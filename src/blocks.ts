import * as THREE from 'three'
import { heightAt } from './world'

// Player-built blocks on a world-aligned grid. This is the world-layer half
// of building: the grid store, the shared meshes, and the queries physics
// and combat ask. It never imports effects or net — building.ts orchestrates
// those (same layering rule as world.ts vs destruction.ts).
//
// Grid: horizontal cells are centered on multiples of BLOCK
// (gx = round(x / BLOCK)); vertical cells span [gy*BLOCK, (gy+1)*BLOCK)
// (gy = floor(y / BLOCK)). Blocks are synced state (bplace/bhit messages),
// never derived from terrain — a crater dug under a block leaves it floating.
//
// Two kinds of block share the grid. PLAYER blocks are the ones the server
// stores and replays. WORLD blocks (the castle in the shadow realm) are
// generated deterministically by every client from the same code, so they
// never ride the wire — only the damage done to them does.

export const BLOCK = 1.5 // under the ~2.0 jump apex, so one block is climbable
// |gx|,|gz| cap. Wide enough for the island AND the shadow realm out at
// x ≈ 1800. Keep in sync with server/room.ts.
export const GRID_XZ_MAX = 1400
export const GY_MIN = -8
export const GY_MAX = 40
// One shared step threshold: floors up to STEP above the feet auto-step you
// on top, and walls only block when their top is beyond STEP — so a single
// block is a stair and a 2-stack is a wall, never both.
const STEP = 1.55
// Instances reserved per material. Blocks render as four InstancedMeshes —
// four draw calls for the entire castle — because a few thousand individual
// meshes would spend the whole frame budget on scene-graph traversal.
const CAPACITY = 6000

export interface BlockSpec {
  gx: number
  gy: number
  gz: number
  m: number
  hp: number
}

// HP table duplicated in server/room.ts (BLOCK_HP) — keep in sync.
export const MATERIALS = [
  { name: 'wood', hp: 2, debris: 0x8a5a2b },
  { name: 'stone', hp: 4, debris: 0x8a8a92 },
  { name: 'brick', hp: 6, debris: 0xa34632 },
  { name: 'metal', hp: 8, debris: 0x9aa0a8 },
]

interface Cell {
  spec: BlockSpec
  inst: number // slot in the material's InstancedMesh
}

const cells = new Map<string, Cell>()
// Bumped whenever a block appears or dies. Anything caching a picture of the
// grid (the minimap's castle layer) watches this instead of wiring a callback.
let revision = 0
let meshes: THREE.InstancedMesh[] = []
// Recycled instance slots per material, plus the high-water mark that bounds
// how many instances the GPU actually walks.
const freeSlots: number[][] = []
const used: number[] = []
// Regenerates the world blocks (the castle). Held here so a welcome snapshot
// can rebuild the world from scratch before replaying damage onto it.
let seedWorld: (() => void) | null = null
const dummy = new THREE.Object3D()

const key = (gx: number, gy: number, gz: number) => `${gx},${gy},${gz}`

export function cellCenter(gx: number, gy: number, gz: number): THREE.Vector3 {
  return new THREE.Vector3(gx * BLOCK, gy * BLOCK + BLOCK / 2, gz * BLOCK)
}

export function initBlocks(scene: THREE.Scene, seed?: () => void): void {
  const geo = new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK)
  meshes = MATERIALS.map((_, i) => {
    const mat = new THREE.MeshLambertMaterial({ map: makeBlockTexture(i), flatShading: true })
    const mesh = new THREE.InstancedMesh(geo, mat, CAPACITY)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // Instances are scattered across two continents; one bounding sphere
    // would never cull usefully anyway, and culling it wrong hides the castle.
    mesh.frustumCulled = false
    mesh.count = 0
    scene.add(mesh)
    freeSlots.push([])
    used.push(0)
    return mesh
  })
  seedWorld = seed ?? null
  seedWorld?.()
}

export function blockAt(gx: number, gy: number, gz: number): BlockSpec | undefined {
  return cells.get(key(gx, gy, gz))?.spec
}

export function blockAtPoint(x: number, y: number, z: number): BlockSpec | undefined {
  return blockAt(Math.round(x / BLOCK), Math.floor(y / BLOCK), Math.round(z / BLOCK))
}

export function blocksVersion(): number {
  return revision
}

// Walk every standing block. Cheap enough to sweep the whole castle (~4k) in
// one pass, which is how the minimap bakes its castle layer.
export function forEachBlock(fn: (spec: BlockSpec) => void): void {
  for (const cell of cells.values()) fn(cell.spec)
}

// False if the cell is already occupied (simultaneous-place race: the server
// keeps the first, the loser's phantom heals on the next welcome) or the
// material's instance pool is full.
export function placeBlock(spec: BlockSpec): boolean {
  const k = key(spec.gx, spec.gy, spec.gz)
  if (cells.has(k)) return false
  const inst = alloc(spec.m)
  if (inst < 0) return false
  cells.set(k, { spec, inst })
  writeInstance(spec.m, inst, spec)
  revision++
  return true
}

// Null when there's no block there (stale hits are no-ops — that's what
// makes the server's cap-eviction bhit broadcast safe for everyone).
export function damageBlock(
  gx: number,
  gy: number,
  gz: number,
  dmg: number,
): { destroyed: boolean; m: number; center: THREE.Vector3 } | null {
  const k = key(gx, gy, gz)
  const entry = cells.get(k)
  if (!entry) return null
  entry.spec.hp -= dmg
  const center = cellCenter(gx, gy, gz)
  if (entry.spec.hp <= 0) {
    writeInstance(entry.spec.m, entry.inst, null)
    freeSlots[entry.spec.m].push(entry.inst)
    cells.delete(k)
    revision++
    return { destroyed: true, m: entry.spec.m, center }
  }
  writeInstance(entry.spec.m, entry.inst, entry.spec)
  return { destroyed: false, m: entry.spec.m, center }
}

function alloc(m: number): number {
  if (m < 0 || m >= meshes.length) return -1
  const recycled = freeSlots[m].pop()
  if (recycled !== undefined) return recycled
  if (used[m] >= CAPACITY) return -1
  const inst = used[m]++
  meshes[m].count = used[m]
  return inst
}

// Paint one instance, or null to park it out of sight at zero scale. Half-dead
// blocks shrink a hair and sit crooked — reads as "loosened" without cloning
// materials for crack decals. The tilt is hashed from the cell so every client
// leans the same block the same way.
function writeInstance(m: number, inst: number, spec: BlockSpec | null): void {
  if (spec) {
    dummy.position.copy(cellCenter(spec.gx, spec.gy, spec.gz))
    const worn = spec.hp <= Math.ceil(MATERIALS[spec.m].hp / 2)
    dummy.scale.setScalar(worn ? 0.94 : 1)
    dummy.rotation.set(0, worn ? tiltOf(spec) : 0, 0)
  } else {
    dummy.position.set(0, -9999, 0)
    dummy.scale.setScalar(0)
    dummy.rotation.set(0, 0, 0)
  }
  dummy.updateMatrix()
  meshes[m].setMatrixAt(inst, dummy.matrix)
  meshes[m].instanceMatrix.needsUpdate = true
}

function tiltOf(spec: BlockSpec): number {
  const h = Math.sin(spec.gx * 12.9898 + spec.gy * 78.233 + spec.gz * 37.719) * 43758.5453
  return (h - Math.floor(h) - 0.5) * 0.12
}

// The lowest empty cell in the column whose top pokes above the terrain —
// repeat placements grow a pillar. heightAt is sampled at placement time;
// later craters don't move existing blocks (they're synced, not derived).
// `fromGy` starts the search at the builder's own feet instead, so standing
// on a castle rampart builds on the rampart rather than hunting for the first
// arrow slit forty cells below.
export function findPlacementGy(gx: number, gz: number, fromGy?: number): number {
  const ground = Math.floor(heightAt(gx * BLOCK, gz * BLOCK) / BLOCK)
  let gy = Math.max(GY_MIN, fromGy === undefined ? ground : Math.max(ground, fromGy))
  while (gy <= GY_MAX && blockAt(gx, gy, gz)) gy++
  return gy
}

// Highest block top at or below feetY + STEP in this column, else -Infinity.
// Feeds the player's floor resolve: standing on towers and 1-block auto-step.
export function blockFloorAt(x: number, z: number, feetY: number): number {
  const gx = Math.round(x / BLOCK)
  const gz = Math.round(z / BLOCK)
  let gy = Math.min(GY_MAX, Math.floor((feetY + STEP) / BLOCK + 1e-6) - 1)
  for (; gy >= GY_MIN; gy--) {
    if (cells.get(key(gx, gy, gz))) return (gy + 1) * BLOCK
  }
  return -Infinity
}

// Is there an un-steppable wall at (x, z) for someone whose feet are at
// feetY? Samples shin and head height so a 2-stack always registers, while
// a single block (top within STEP) stays walkable via the floor hook.
export function wallAt(x: number, z: number, feetY: number): boolean {
  const gx = Math.round(x / BLOCK)
  const gz = Math.round(z / BLOCK)
  for (const h of [1.0, 1.9]) {
    const gy = Math.floor((feetY + h) / BLOCK)
    if (cells.get(key(gx, gy, gz)) && (gy + 1) * BLOCK > feetY + STEP) return true
  }
  return false
}

// Replace everything with a welcome snapshot. Blocks can be destroyed while
// we're away, so reconnects need a full reset — crater-style dedupe isn't
// enough here. World blocks aren't in the snapshot: they're regenerated
// pristine and then re-broken by the accumulated damage the room replays,
// which is idempotent because hp is a commutative sum.
export function resetBlocks(specs: BlockSpec[], worldDamage: WorldDamage[]): void {
  for (const cell of cells.values()) {
    writeInstance(cell.spec.m, cell.inst, null)
    freeSlots[cell.spec.m].push(cell.inst)
  }
  cells.clear()
  seedWorld?.()
  for (const [gx, gy, gz, dmg] of worldDamage) damageBlock(gx, gy, gz, dmg)
  for (const spec of specs) placeBlock(spec)
}

// Accumulated damage on one world cell: [gx, gy, gz, total]. Packed as a
// tuple because the welcome replay can carry thousands of them.
export type WorldDamage = [number, number, number, number]

// 32x32 canvas textures, nearest-filtered: chunky Minecraft-by-way-of-N64
// pixels. Hardcoded layouts, no randomness — every client draws the same.
function makeBlockTexture(m: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 32
  const ctx = canvas.getContext('2d')!
  if (m === 0) {
    // Wood: horizontal planks, dark seams, a few nails.
    ctx.fillStyle = '#8a5a2b'
    ctx.fillRect(0, 0, 32, 32)
    ctx.fillStyle = '#96632f'
    ctx.fillRect(0, 8, 32, 8)
    ctx.fillRect(0, 24, 32, 8)
    ctx.fillStyle = '#6b4526'
    for (const y of [7, 15, 23, 31]) ctx.fillRect(0, y, 32, 1)
    ctx.fillStyle = '#7a4e26'
    ctx.fillRect(9, 0, 1, 7)
    ctx.fillRect(22, 8, 1, 7)
    ctx.fillRect(5, 16, 1, 7)
    ctx.fillRect(26, 24, 1, 7)
    ctx.fillStyle = '#4e331a'
    ctx.fillRect(3, 3, 2, 2)
    ctx.fillRect(28, 19, 2, 2)
  } else if (m === 1) {
    // Stone: cobbles on dark grout.
    ctx.fillStyle = '#5f5f66'
    ctx.fillRect(0, 0, 32, 32)
    const stones: [number, number, number, number, string][] = [
      [1, 1, 12, 9, '#8a8a92'],
      [15, 2, 15, 8, '#94949c'],
      [2, 12, 9, 9, '#82828a'],
      [13, 12, 11, 8, '#8f8f97'],
      [26, 11, 5, 10, '#84848c'],
      [1, 23, 13, 8, '#90909a'],
      [16, 22, 14, 9, '#86868e'],
    ]
    for (const [x, y, w, h, c] of stones) {
      ctx.fillStyle = c
      ctx.fillRect(x, y, w, h)
    }
  } else if (m === 2) {
    // Brick: offset courses on mortar.
    ctx.fillStyle = '#b8a48e'
    ctx.fillRect(0, 0, 32, 32)
    const reds = ['#a34632', '#a84b36', '#9c4130']
    for (let row = 0; row < 4; row++) {
      const y = row * 8
      const offset = row % 2 === 0 ? 0 : -5
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = reds[(row + i) % 3]
        ctx.fillRect(offset + i * 10, y, 9, 7)
      }
    }
  } else {
    // Metal: plate with a bevel and corner rivets.
    ctx.fillStyle = '#8f959d'
    ctx.fillRect(0, 0, 32, 32)
    ctx.fillStyle = '#b5bcc4'
    ctx.fillRect(0, 0, 32, 2)
    ctx.fillRect(0, 0, 2, 32)
    ctx.fillStyle = '#6b7077'
    ctx.fillRect(0, 30, 32, 2)
    ctx.fillRect(30, 0, 2, 32)
    ctx.fillStyle = '#5f646b'
    for (const [x, y] of [[5, 5], [25, 5], [5, 25], [25, 25]]) {
      ctx.fillRect(x, y, 3, 3)
      ctx.fillStyle = '#c0c6cd'
      ctx.fillRect(x, y, 1, 1)
      ctx.fillStyle = '#5f646b'
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  return texture
}
