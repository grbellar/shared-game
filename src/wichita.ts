import * as THREE from 'three'
import { addRegion } from './world'
import { BUILDINGS, ROADS, WATER } from './wichita-data'

// Downtown Wichita, Kansas — for real. Baked from OpenStreetMap by
// tools/bake-wichita.mjs into wichita-data.ts: 900-odd true building
// footprints, the street grid, and the Arkansas River, all in meters at 1:1.
// Douglas Ave runs along the world's z=0 line, pointing east at home.
//
// Same trick as the shadow realm: not a scene, just a place far enough west
// (WICHITA_X) that the fog wall and the 500-unit far plane keep it and the
// island from ever seeing each other. Everything world-space — blocks,
// craters, rockets, chat, remotes — works here for free.
//
// Buildings are scenery, not walls, in this first cut: you can walk through
// them (and build/blast your own real ones anywhere — the block grid and
// craters both reach out here). Proper collision is a follow-up.

export const WICHITA_X = -2600
export const WICHITA_Z = 0
export const WICHITA_GROUND = 3 // two BLOCK courses, flush like the realm

// The city rectangle in local (bake) coordinates, from the bake's extents,
// plus the margin where the prairie shears off into the sea.
const X0 = -1300
const X1 = 1410
const Z0 = -1140
const Z1 = 790
const EDGE = 120

export function inWichita(x: number, z: number): boolean {
  return (
    x - WICHITA_X > X0 - EDGE &&
    x - WICHITA_X < X1 + EDGE &&
    z - WICHITA_Z > Z0 - EDGE &&
    z - WICHITA_Z < Z1 + EDGE
  )
}

// ---- the Arkansas River, rasterized ----------------------------------------
// heightAt gets called per frame per thing standing on the ground, so the
// river polygons are scanline-filled once into a coarse bitmask instead of
// point-in-polygon tested live.
const CELL = 4
const GW = Math.ceil((X1 - X0) / CELL)
const GH = Math.ceil((Z1 - Z0) / CELL)
let riverMask: Uint8Array | null = null

function buildRiverMask(): Uint8Array {
  const mask = new Uint8Array(GW * GH)
  for (const poly of WATER) {
    const p = poly.p
    const n = p.length / 2
    for (let gz = 0; gz < GH; gz++) {
      const z = Z0 + (gz + 0.5) * CELL
      // Even-odd rule: collect x-crossings of this row, fill between pairs.
      const xs: number[] = []
      for (let i = 0; i < n; i++) {
        const x1 = p[i * 2]
        const z1 = p[i * 2 + 1]
        const x2 = p[((i + 1) % n) * 2]
        const z2 = p[((i + 1) % n) * 2 + 1]
        if (z1 <= z === z2 <= z) continue
        xs.push(x1 + ((z - z1) / (z2 - z1)) * (x2 - x1))
      }
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, Math.ceil((xs[k] - X0) / CELL - 0.5))
        const b = Math.min(GW - 1, Math.floor((xs[k + 1] - X0) / CELL - 0.5))
        for (let gx = a; gx <= b; gx++) mask[gz * GW + gx] = 1
      }
    }
  }
  return mask
}

function inRiver(lx: number, lz: number): boolean {
  if (!riverMask) riverMask = buildRiverMask()
  const gx = Math.floor((lx - X0) / CELL)
  const gz = Math.floor((lz - Z0) / CELL)
  if (gx < 0 || gx >= GW || gz < 0 || gz >= GH) return false
  return riverMask[gz * GW + gx] === 1
}

// The city's analytic heightfield: dead flat concrete prairie, the river cut
// down to swimmable depth (WATER_LEVEL floats you in anything deeper), and
// the whole slab shearing off into the sea past the edges. Null everywhere
// it isn't, so world.ts falls through to the islands.
export function wichitaHeightAt(x: number, z: number): number | null {
  const lx = x - WICHITA_X
  const lz = z - WICHITA_Z
  if (lx < X0 - EDGE || lx > X1 + EDGE || lz < Z0 - EDGE || lz > Z1 + EDGE) return null
  const out = Math.max(0, X0 - lx, lx - X1, Z0 - lz, lz - Z1)
  // A beach, not a cliff: swimmable a third of the way out, ~-27 at the rim.
  if (out > 0) return WICHITA_GROUND - Math.pow(out / EDGE, 2) * 30
  if (inRiver(lx, lz)) return -2.6
  return WICHITA_GROUND
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- buildings --------------------------------------------------------------
// Every footprint extruded into a flat-shaded prism: triangulated roof at
// its real height, walls down to the slab. All ~950 go into ONE non-indexed
// geometry with vertex colors — one draw call for the whole skyline.

const PALETTE = [
  new THREE.Color(0x9a5f3e), // brick
  new THREE.Color(0xb08968), // tan brick
  new THREE.Color(0xc9b28a), // limestone
  new THREE.Color(0x8d8d95), // concrete
  new THREE.Color(0xa39b8b), // stucco
]
const TALL = new THREE.Color(0x7c8fa6) // glass towers
const ROOF_DARKEN = 0.72

function buildBuildings(): THREE.Mesh {
  const pos: number[] = []
  const col: number[] = []
  const rand = mulberry32(316) // Wichita's area code, obviously
  const c = new THREE.Color()
  const roof = new THREE.Color()

  for (const b of BUILDINGS) {
    // Ring, normalized to CCW seen from above so wall normals face outward.
    const ring: THREE.Vector2[] = []
    for (let i = 0; i < b.p.length; i += 2) ring.push(new THREE.Vector2(b.p[i], b.p[i + 1]))
    let area = 0
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const d = ring[(i + 1) % ring.length]
      area += a.y * d.x - a.x * d.y
    }
    if (area < 0) ring.reverse()

    c.copy(b.h > 28 ? TALL : PALETTE[Math.floor(rand() * PALETTE.length)])
    c.offsetHSL(0, 0, (rand() - 0.5) * 0.1)
    roof.copy(c).multiplyScalar(ROOF_DARKEN)

    const y0 = WICHITA_GROUND - 0.5 // socketed into the slab, no gaps
    const y1 = WICHITA_GROUND + b.h

    // Roof. triangulateShape copes with the concave footprints; winding of
    // its output isn't guaranteed for our axes, so each triangle is checked
    // and flipped to face up.
    const tris = THREE.ShapeUtils.triangulateShape(ring, [])
    for (const [ia, ib, ic] of tris) {
      const A = ring[ia]
      const B = ring[ib]
      const C = ring[ic]
      const ny = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y)
      const [q1, q2] = ny >= 0 ? [B, C] : [C, B]
      pos.push(A.x, y1, A.y, q1.x, y1, q1.y, q2.x, y1, q2.y)
      for (let k = 0; k < 3; k++) col.push(roof.r, roof.g, roof.b)
    }

    // Walls: one quad per ring edge.
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const d = ring[(i + 1) % ring.length]
      pos.push(a.x, y0, a.y, d.x, y0, d.y, d.x, y1, d.y)
      pos.push(a.x, y0, a.y, d.x, y1, d.y, a.x, y1, a.y)
      for (let k = 0; k < 6; k++) col.push(c.r, c.g, c.b)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  )
  mesh.position.set(WICHITA_X, 0, WICHITA_Z)
  mesh.name = 'wichita-buildings'
  return mesh
}

// ---- streets ----------------------------------------------------------------
// Ribbons a hair above the slab, one geometry for the lot. Each road gets its
// own deterministic sub-millimeter lift so coplanar overlaps at intersections
// don't shimmer.

const ASPHALT = new THREE.Color(0x4a4a50)

function buildRoads(): THREE.Mesh {
  const pos: number[] = []
  const col: number[] = []
  const c = new THREE.Color()
  ROADS.forEach((r, ri) => {
    const y = WICHITA_GROUND + 0.06 + ((ri % 37) / 37) * 0.05
    c.copy(ASPHALT)
    if (r.w <= 3) c.setHex(0x8f8578) // footpaths read as gravel
    c.offsetHSL(0, 0, ((ri % 11) / 11 - 0.5) * 0.05)
    const half = r.w / 2
    for (let i = 0; i + 3 < r.p.length; i += 2) {
      const x1 = r.p[i]
      const z1 = r.p[i + 1]
      const x2 = r.p[i + 2]
      const z2 = r.p[i + 3]
      const dx = x2 - x1
      const dz = z2 - z1
      const len = Math.hypot(dx, dz)
      if (len < 0.01) continue
      // Perpendicular in the ground plane, plus a half-width cap on each end
      // so segments of a bend seal their own joint.
      const px = (-dz / len) * half
      const pz = (dx / len) * half
      const ex = (dx / len) * half
      const ez = (dz / len) * half
      const ax = x1 - ex + px
      const az = z1 - ez + pz
      const bx = x1 - ex - px
      const bz = z1 - ez - pz
      const cx = x2 + ex - px
      const cz = z2 + ez - pz
      const dx2 = x2 + ex + px
      const dz2 = z2 + ez + pz
      pos.push(ax, y, az, bx, y, bz, cx, y, cz)
      pos.push(ax, y, az, cx, y, cz, dx2, y, dz2)
      for (let k = 0; k < 6; k++) col.push(c.r, c.g, c.b)
    }
  })
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  )
  mesh.position.set(WICHITA_X, 0, WICHITA_Z)
  mesh.name = 'wichita-roads'
  return mesh
}

// ---- terrain ----------------------------------------------------------------
// One big flat tile: pale downtown concrete fading to prairie grass at the
// edges, river bed cut in, rim shearing into the sea. Vertices are
// mesh-local; userData.origin is how world.ts carves craters at an offset
// (same contract as the realm's tile).

const CONCRETE = new THREE.Color(0xb9b2a4)
const PRAIRIE = new THREE.Color(0x7f9e4a)
const RIVERBED = new THREE.Color(0x7a6a4a)
const SEG = 20 / 3 // double the island's 3⅓ — the slab is flat, craters still read

export function buildWichitaTerrain(): THREE.Mesh {
  const w = X1 - X0 + EDGE * 2
  const d = Z1 - Z0 + EDGE * 2
  const cx = (X0 + X1) / 2
  const cz = (Z0 + Z1) / 2
  const geo = new THREE.PlaneGeometry(w, d, Math.round(w / SEG), Math.round(d / SEG))
  geo.rotateX(-Math.PI / 2)
  geo.translate(cx, 0, cz)
  const pos = geo.attributes.position
  const colors: number[] = []
  const rand = mulberry32(67202) // downtown's ZIP
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i)
    const lz = pos.getZ(i)
    const h = wichitaHeightAt(lx + WICHITA_X, lz + WICHITA_Z) ?? -20
    pos.setY(i, h)
    if (h < 0) c.copy(RIVERBED)
    else {
      // Concrete through the core, prairie taking over toward the edges.
      const t = Math.max(
        (Math.abs(lx - cx) / (w / 2)) ** 3,
        (Math.abs(lz - cz) / (d / 2)) ** 3,
      )
      c.copy(CONCRETE).lerp(PRAIRIE, Math.min(1, t * 1.4))
    }
    c.offsetHSL(0, 0, (rand() - 0.5) * 0.06)
    colors.push(c.r, c.g, c.b)
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  geo.userData.origin = new THREE.Vector2(WICHITA_X, WICHITA_Z)
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  )
  mesh.position.set(WICHITA_X, 0, WICHITA_Z)
  mesh.name = 'wichita-terrain'
  return mesh
}

export function createWichita(scene: THREE.Scene): void {
  const terrain = buildWichitaTerrain()
  scene.add(terrain)
  addRegion(wichitaHeightAt, terrain.geometry)
  scene.add(buildBuildings())
  scene.add(buildRoads())

  // The river surface — same look as the island sea so the WATER_LEVEL float
  // trick reads the same. One local plane, not the island's (that one is only
  // 800 wide and lives at the origin).
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(X1 - X0 + EDGE * 4, Z1 - Z0 + EDGE * 4),
    new THREE.MeshLambertMaterial({ color: 0x3f76c9, transparent: true, opacity: 0.85 }),
  )
  water.rotateX(-Math.PI / 2)
  water.position.set(WICHITA_X + (X0 + X1) / 2, 0, WICHITA_Z + (Z0 + Z1) / 2)
  water.name = 'wichita-water'
  scene.add(water)
}
