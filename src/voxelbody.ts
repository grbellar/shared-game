import * as THREE from 'three'
import { BLOCK } from './blocks'

// Bodies made of voxels, and the rules for growing, boring and collapsing
// them. A body is described by exactly two things:
//
//   grown    a monotonic count of voxels ever accreted, one int in `state`
//   removed  a set of indices bored out, replayed by the room in `welcome`
//
// Everything else — height, speed, where the legs are, which voxels a rocket
// takes — is derived from those two on every client, so none of it crosses the
// wire.
//
// What makes `removed` safe to store is SEQUENCE. There is one deterministic
// infinite ordering of voxels, and the figure at any `grown` is exactly its
// first `grown` entries. Growing appends and never reshuffles, so index 412
// means the same voxel forever, at every size, on every client.

export const VOXEL = BLOCK / 3 // 0.5 — one third of a world block

export const PARTS = ['body', 'head', 'armL', 'armR', 'legL', 'legR'] as const
export type PartName = (typeof PARTS)[number]
export const BASE_MASS = 15
export const COLOSSUS_MASS = 400
const MAX_SEQUENCE = 20480

// Share of every voxel accreted past the base, by part. Deliberately
// top-heavy: legs thicken six times slower than the torso, which keeps the
// ankles sawable at any size.
const GROWTH_WEIGHT: Record<PartName, number> = {
  body: 0.48,
  head: 0.14,
  armL: 0.11,
  armR: 0.11,
  legL: 0.08,
  legR: 0.08,
}

// How many voxels each part starts with, and the box proportions it keeps as
// it grows. `cap` bounds the precomputed local sequence for that part.
const SHAPE: Record<PartName, { base: number; aspect: [number, number, number]; cap: number }> = {
  // The tall aspect makes climbing cheap and widening dear, so a growing torso
  // STACKS: height outruns girth roughly two to one, and a colossus reads as a
  // tower on legs rather than a cube.
  body: { base: 6, aspect: [1.55, 3.9, 1.25], cap: 8192 },
  head: { base: 1, aspect: [1, 1, 1], cap: 4096 },
  armL: { base: 2, aspect: [1, 2, 1], cap: 2048 },
  armR: { base: 2, aspect: [1, 2, 1], cap: 2048 },
  legL: { base: 2, aspect: [1, 2, 1], cap: 2048 },
  legR: { base: 2, aspect: [1, 2, 1], cap: 2048 },
}

interface Local {
  ox: number
  oy: number
  oz: number
}

const BODY_BASE: Local[] = [
  { ox: 0, oy: 0, oz: 0 },
  { ox: -1, oy: 0, oz: 0 },
  { ox: 1, oy: 0, oz: 0 },
  { ox: 0, oy: 1, oz: 0 },
  { ox: -1, oy: 1, oz: 0 },
  { ox: 1, oy: 1, oz: 0 },
]

// Per-part local orderings, anchored where the part joins its parent so that
// growth can never disconnect a limb from the body it hangs off.
const localSeq: Record<PartName, Local[]> = {
  body: [],
  head: [],
  armL: [],
  armR: [],
  legL: [],
  legR: [],
}
// Which part owns global index i, and which entry of that part's local
// sequence it is.
const seqPart: PartName[] = []
const seqSlot: number[] = []

buildSequences()

// Every part grows from where it JOINS its parent, never toward it. A torso
// that filled downward would swallow the hips, leave the legs hanging off
// nothing, and the collapse rule would drop the whole body.
function metricFor(part: PartName, ox: number, oy: number, oz: number): number {
  const [ax, ay, az] = SHAPE[part].aspect
  if (part === 'body') {
    return (ox / ax) ** 2 + (oy / ay) ** 2 + (oz / az) ** 2
  }
  if (part === 'head') {
    return ox * ox + oz * oz + oy * oy * 0.4
  }
  // Limbs: oy runs downward from the joint at 0, so |oy| - 1 is the distance
  // along the limb. The small factor makes it extend before it thickens —
  // smaller still for arms, which have to keep pace with a torso that stacks
  // or a giant ends up with T-rex arms halfway up its chest. Legs thicken
  // sooner on purpose; fat sawable ankles are the counter-play.
  return ox * ox + oz * oz + (Math.abs(oy) - 1) ** 2 * (part === 'legL' || part === 'legR' ? 0.08 : 0.03)
}

function buildSequences(): void {
  for (const part of PARTS) {
    const { aspect, cap } = SHAPE[part]
    // A box comfortably larger than the cap, in the part's own proportions.
    let k = 1
    while (aspect[0] * k * aspect[1] * k * aspect[2] * k < cap) k++
    const hx = Math.max(1, Math.round((aspect[0] * k) / 2))
    const hz = Math.max(1, Math.round((aspect[2] * k) / 2))
    const hy = Math.max(2, aspect[1] * k)
    const cells: { c: Local; m: number }[] = []
    for (let ox = -hx; ox <= hx; ox++) {
      for (let oz = -hz; oz <= hz; oz++) {
        if (part === 'body' || part === 'head') {
          for (let oy = 0; oy <= hy; oy++) {
            cells.push({ c: { ox, oy, oz }, m: metricFor(part, ox, oy, oz) })
          }
        } else {
          for (let oy = -1; oy >= -hy; oy--) {
            cells.push({ c: { ox, oy, oz }, m: metricFor(part, ox, oy, oz) })
          }
        }
      }
    }
    // Ties broken by axis order so every client sorts to the same list. A
    // comparator that ever returns 0 would leave it up to the engine's sort.
    cells.sort(
      (a, b) =>
        a.m - b.m ||
        Math.abs(a.c.oy) - Math.abs(b.c.oy) ||
        a.c.ox - b.c.ox ||
        a.c.oz - b.c.oz ||
        a.c.oy - b.c.oy,
    )
    let seq = cells.slice(0, cap).map((e) => e.c)
    // The torso's first six cells are pinned to the classic 3x2 chest slab.
    // The metric is a tuning knob for how giants stack; it must never restyle
    // the starting character, whose height every step constant was sized to.
    if (part === 'body') {
      const pinned = BODY_BASE.map((b) => seq.find((c) => c.ox === b.ox && c.oy === b.oy && c.oz === b.oz)!)
      seq = [...pinned, ...seq.filter((c) => !pinned.includes(c))]
    }
    localSeq[part] = seq
  }

  // The base figure occupies the first BASE_MASS indices. Order inside it does
  // not matter, because mass never drops below the base.
  const used: Record<PartName, number> = { body: 0, head: 0, armL: 0, armR: 0, legL: 0, legR: 0 }
  for (const part of PARTS) {
    for (let i = 0; i < SHAPE[part].base; i++) {
      seqPart.push(part)
      seqSlot.push(used[part]++)
    }
  }
  // Everything past the base goes to whichever part is furthest behind its
  // share. Largest-deficit scheduling, deterministic so index 412 is the same
  // voxel of the same part on every machine forever.
  for (let i = BASE_MASS; i < MAX_SEQUENCE; i++) {
    const extra = i - BASE_MASS + 1
    let best: PartName = 'body'
    let bestDeficit = -Infinity
    for (const part of PARTS) {
      if (used[part] >= localSeq[part].length) continue
      const deficit = GROWTH_WEIGHT[part] * extra - (used[part] - SHAPE[part].base)
      if (deficit > bestDeficit) {
        bestDeficit = deficit
        best = part
      }
    }
    seqPart.push(best)
    seqSlot.push(used[best]++)
  }
}

// A voxel's position in body space: integer lattice cells, feet at by = 0,
// x and z centered on multiples of VOXEL exactly like the world grid.
export interface BodyCell {
  bx: number
  by: number
  bz: number
}

export interface PartLayout {
  cells: BodyCell[]
  indices: number[] // global sequence index per cell, parallel to `cells`
  pivot: THREE.Vector3 // where the rig Group for this part sits, in world units
}

export interface Layout {
  parts: Record<PartName, PartLayout>
  mass: number
  height: number // world units, feet to crown
  radius: number // world units, widest horizontal half-extent
}

// The only place that knows how the six parts fit together. Pure and
// deterministic.
export function layout(grown: number, removed: ReadonlySet<number>): Layout {
  const count = Math.max(BASE_MASS, Math.min(MAX_SEQUENCE, Math.floor(grown)))
  const locals: Record<PartName, Local[]> = {
    body: [], head: [], armL: [], armR: [], legL: [], legR: [],
  }
  const idx: Record<PartName, number[]> = {
    body: [], head: [], armL: [], armR: [], legL: [], legR: [],
  }
  for (let i = 0; i < count; i++) {
    if (removed.has(i)) continue
    const part = seqPart[i]
    locals[part].push(localSeq[part][seqSlot[i]])
    idx[part].push(i)
  }

  // Extents drive where the joints sit. Measured from the FULL prefix rather
  // than the surviving cells, so a body riddled with holes keeps its size —
  // hollowing out must not quietly shrink you back into a small target.
  const ext = (part: PartName) => {
    let hx = 0
    let hz = 0
    let hi = 0
    // Per-row edges, SIGNED. A half-width would call a row that reaches -2 but
    // not yet +2 symmetric and hang the right arm on a column that does not
    // exist; anchoring to the widest row instead buries an arm in the chest.
    const rowMin: number[] = []
    const rowMax: number[] = []
    // Inner reach ON THE JOINT ROW. The fill adds ox=-1 before ox=+1, so a part
    // can have no cell on its inner side at all, and its widest row is rarely
    // the row that joins the parent. Measure anywhere else and a limb ends up
    // hanging a voxel clear of the body.
    const joinRow = part === 'body' || part === 'head' ? 0 : 1
    let joinOx = 0
    for (let i = 0; i < count; i++) {
      if (seqPart[i] !== part) continue
      const c = localSeq[part][seqSlot[i]]
      const row = Math.abs(c.oy)
      hx = Math.max(hx, Math.abs(c.ox))
      hz = Math.max(hz, Math.abs(c.oz))
      hi = Math.max(hi, row)
      if (row === joinRow) joinOx = Math.max(joinOx, c.ox)
      rowMin[row] = Math.min(rowMin[row] ?? 0, c.ox)
      rowMax[row] = Math.max(rowMax[row] ?? 0, c.ox)
    }
    return { hx, hz, hi, rowMin, rowMax, joinOx }
  }

  const bodyE = ext('body')
  const headE = ext('head')
  const armLE = ext('armL')
  const armRE = ext('armR')
  const legLE = ext('legL')
  const legRE = ext('legR')

  const legH = Math.max(legLE.hi, legRE.hi) // leg layers, feet at by = 0
  const bodyH = bodyE.hi + 1
  const bodyTop = legH + bodyH

  // A fixed fraction of torso height. Anchoring shoulders to the widest row
  // parks them on the chest slab at the bottom of a stacking torso, and
  // everything above the arms reads as one long neck.
  const shoulderOy = Math.min(bodyE.hi, Math.round(bodyE.hi * 0.78))
  const shoulderBy = legH + shoulderOy + 1

  // Arms sit one voxel outside the shoulder row's own edge on their own side,
  // offset by their inner face so that face lands exactly on the joint.
  const armLX = (bodyE.rowMin[shoulderOy] ?? 0) - 1 - armLE.joinOx
  const armRX = (bodyE.rowMax[shoulderOy] ?? 0) + 1 + armRE.joinOx

  // Legs sit UNDER the hip row rather than outside it, so they want overlap
  // where the arms wanted adjacency. Anchoring the always-present ox=0 cell
  // inside the row guarantees it, and the row is contiguous because the fill
  // metric is monotonic in |ox|.
  const hipMin = Math.min(-1, bodyE.rowMin[0] ?? -1)
  const hipMax = Math.max(1, bodyE.rowMax[0] ?? 1)
  const legLX = Math.max(hipMin, Math.min(-1, Math.round(hipMin * 0.55)))
  const legRX = Math.min(hipMax, Math.max(1, Math.round(hipMax * 0.55)))

  // Limb `oy` is already negative, so a limb's top cell lands on the joint row
  // and touches its parent. Right-side parts mirror their local x, so the pair
  // reads as a pair rather than the same arm printed twice.
  const place: Record<PartName, (c: Local) => BodyCell> = {
    body: (c) => ({ bx: c.ox, by: legH + c.oy, bz: c.oz }),
    head: (c) => ({ bx: c.ox, by: bodyTop + c.oy, bz: c.oz }),
    armL: (c) => ({ bx: armLX + c.ox, by: shoulderBy + c.oy, bz: c.oz }),
    armR: (c) => ({ bx: armRX - c.ox, by: shoulderBy + c.oy, bz: c.oz }),
    legL: (c) => ({ bx: legLX + c.ox, by: legH + c.oy, bz: c.oz }),
    legR: (c) => ({ bx: legRX - c.ox, by: legH + c.oy, bz: c.oz }),
  }

  const pivots: Record<PartName, THREE.Vector3> = {
    body: new THREE.Vector3(0, (legH + bodyH / 2) * VOXEL, 0),
    head: new THREE.Vector3(0, (bodyTop + (headE.hi + 1) / 2) * VOXEL, 0),
    armL: new THREE.Vector3(armLX * VOXEL, shoulderBy * VOXEL, 0),
    armR: new THREE.Vector3(armRX * VOXEL, shoulderBy * VOXEL, 0),
    legL: new THREE.Vector3(legLX * VOXEL, legH * VOXEL, 0),
    legR: new THREE.Vector3(legRX * VOXEL, legH * VOXEL, 0),
  }

  const parts = {} as Record<PartName, PartLayout>
  let radius = 0
  for (const part of PARTS) {
    const cells = locals[part].map(place[part])
    parts[part] = { cells, indices: idx[part], pivot: pivots[part] }
    for (const c of cells) radius = Math.max(radius, Math.abs(c.bx), Math.abs(c.bz))
  }

  return {
    parts,
    mass: count - countRemovedBelow(removed, count),
    height: (bodyTop + headE.hi + 1) * VOXEL,
    radius: (radius + 0.5) * VOXEL,
  }
}

function countRemovedBelow(removed: ReadonlySet<number>, count: number): number {
  let n = 0
  for (const i of removed) if (i < count) n++
  return n
}

export function massOf(grown: number, removed: ReadonlySet<number>): number {
  const count = Math.max(BASE_MASS, Math.min(MAX_SEQUENCE, Math.floor(grown)))
  return count - countRemovedBelow(removed, count)
}

// Linear size relative to a base player. Mass is a volume, so the edge of a
// cube holding it goes as the cube root.
export function scaleOf(mass: number): number {
  return Math.cbrt(Math.max(1, mass) / BASE_MASS)
}

// Voxels no longer connected to the feet. The flood roots at the ground layer,
// which only legs can occupy — so sawing through BOTH legs orphans the entire
// torso, while taking one ankle off costs a foot and nothing else.
export function orphans(l: Layout): number[] {
  // A list per cell, not one index: at extreme sizes two parts can grow into
  // the same cell, and dropping the loser would report a voxel as loose when
  // it is standing right there — phantom spill out of a healthy body.
  const occupied = new Map<number, number[]>()
  const roots: number[] = []
  for (const part of PARTS) {
    const { cells, indices } = l.parts[part]
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]
      const k = packCell(c.bx, c.by, c.bz)
      const at = occupied.get(k)
      if (at) at.push(indices[i])
      else occupied.set(k, [indices[i]])
      if (c.by === 0) roots.push(k)
    }
  }
  const seen = new Set<number>(roots)
  const stack = [...roots]
  while (stack.length) {
    const k = stack.pop()!
    const bx = ((k >> 14) & 0x7f) - 64
    const by = (k >> 7) & 0x7f
    const bz = (k & 0x7f) - 64
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const n = packCell(bx + dx, by + dy, bz + dz)
      if (seen.has(n) || !occupied.has(n)) continue
      seen.add(n)
      stack.push(n)
    }
  }
  const loose: number[] = []
  for (const [k, at] of occupied) if (!seen.has(k)) loose.push(...at)
  return loose
}

const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
]

// bx and bz span ±64, by spans 0..127 — comfortably wider than the biggest
// figure the sequence can build.
function packCell(bx: number, by: number, bz: number): number {
  return ((bx + 64) << 14) | ((by & 0x7f) << 7) | (bz + 64)
}

// Where a voxel sits in the character's rest pose, before animation rotates
// the part it belongs to.
export function cellCenter(c: BodyCell, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(c.bx * VOXEL, (c.by + 0.5) * VOXEL, c.bz * VOXEL)
}

// A weapon's volume, in the victim's own space. A sphere is a ray of zero
// length, so this one shape covers everything that bores anything.
export interface Bore {
  ox: number
  oy: number
  oz: number
  dx: number
  dy: number
  dz: number
  r: number
  len: number
}

// Which sequence indices a shape takes out. Tested against the rest pose
// rather than the animated one: a swinging arm is a few centimetres off, and a
// full skinned hit test per shot would cost more than that is worth.
export function boreCells(l: Layout, b: Bore): number[] {
  const hit: number[] = []
  const p = new THREE.Vector3()
  const len = Math.hypot(b.dx, b.dy, b.dz) || 1
  const dx = b.dx / len
  const dy = b.dy / len
  const dz = b.dz / len
  // Centre-in-sphere, with no fudge for voxel corners. Adding a circumradius
  // looks more correct but quietly adds 0.44 to every radius, which at these
  // scales is an order of magnitude more voxels — a rifle round taking a
  // beachball out of somebody. A shot that lands between centres catches
  // nothing; that's what the caller's fallback is for.
  const reach = b.r
  for (const part of PARTS) {
    const { cells, indices } = l.parts[part]
    for (let i = 0; i < cells.length; i++) {
      cellCenter(cells[i], p)
      const vx = p.x - b.ox
      const vy = p.y - b.oy
      const vz = p.z - b.oz
      const along = Math.max(0, Math.min(b.len, vx * dx + vy * dy + vz * dz))
      const px = vx - dx * along
      const py = vy - dy * along
      const pz = vz - dz * along
      if (px * px + py * py + pz * pz <= reach * reach) hit.push(indices[i])
    }
  }
  return hit
}

// Which part owns a sequence index. Erosion uses it to spare the legs: limbs
// grow DOWNWARD, so a leg's newest voxels are its feet, and eating the ground
// row makes the connectivity flood declare the whole body loose — one skeleton
// strike disintegrating a 1000-voxel giant. Legs go to aimed cuts only.
export function partOfIndex(i: number): PartName {
  return seqPart[Math.max(0, Math.min(seqPart.length - 1, Math.floor(i)))]
}

// The n most recently accreted surviving voxels, which are the outermost ones
// because the fill order runs inside-out. Hazards erode through this, and so
// does an aimed shot whose sphere caught nothing — a hit that connected must
// never come out a whiff just because aim drifted between clients.
export function outermost(l: Layout, n: number): number[] {
  const all: number[] = []
  for (const part of PARTS) all.push(...l.parts[part].indices)
  all.sort((a, b) => b - a)
  return all.slice(0, n)
}

// Hashed off the index, so debris from one body lands in the same rough place
// on every client without anybody sending positions.
export function spillJitter(i: number): { a: number; r: number; h: number } {
  const s = Math.sin(i * 12.9898) * 43758.5453
  const t = Math.sin(i * 78.233) * 24634.6345
  const u = Math.sin(i * 37.719) * 19873.1234
  return { a: (s - Math.floor(s)) * Math.PI * 2, r: t - Math.floor(t), h: u - Math.floor(u) }
}
