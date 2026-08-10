import * as THREE from 'three'
import { addRegion } from './world'
import { BUILDINGS, ROADS, WATER, type WichitaBuilding } from './wichita-data'

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
// What sells "the real deal" at 320x240 is silhouette, palette and window
// rhythm, never photos: facades are 64px canvas-drawn window grids tiled by
// each building's REAL floor count, landmark colours are hand-curated from
// reference photos (data, not image assets), and the recognizable few get
// hand-built hero geometry — Century II's blue dome, Epic Center's crown,
// Union Station's clock tower, and the Keeper of the Plains at the
// confluence. Windows light up as the shared clock rolls into night
// (updateWichita, called from the main loop).
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

// ---- facade textures --------------------------------------------------------
// Two 64px canvas-drawn window grids (the art rules' one sanctioned kind of
// texture): punched masonry windows and a glass curtain wall. Drawn in
// grayscale so the per-building vertex colour supplies the brick/limestone/
// glass tint, with a matching emissive map of lit windows for the night.
// One texture tile = 4 windows wide (TILE_W meters) by 4 floors (TILE_H).

const TILE_W = 12
const FLOOR_H = 3.2
const TILE_H = FLOOR_H * 4

interface FacadeMaps {
  masonry: THREE.Texture
  masonryGlow: THREE.Texture
  glass: THREE.Texture
  glassGlow: THREE.Texture
}

function drawFacades(): FacadeMaps | null {
  if (typeof document === 'undefined') return null // headless tests
  const make = (draw: (g: CanvasRenderingContext2D) => void): THREE.Texture => {
    const cv = document.createElement('canvas')
    cv.width = 64
    cv.height = 64
    const g = cv.getContext('2d')!
    draw(g)
    const tex = new THREE.CanvasTexture(cv)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }
  const lit = mulberry32(1955) // the year the Keeper's sculptor got going

  const masonry = make((g) => {
    g.fillStyle = '#d4d4d4'
    g.fillRect(0, 0, 64, 64)
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        g.fillStyle = '#4c5157'
        g.fillRect(4 + i * 16, 3 + j * 16, 9, 10)
        g.fillStyle = '#e8e8e8' // sill
        g.fillRect(4 + i * 16, 13 + j * 16, 9, 1)
      }
  })
  const masonryGlow = make((g) => {
    g.fillStyle = '#000'
    g.fillRect(0, 0, 64, 64)
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++)
        if (lit() < 0.34) {
          g.fillStyle = '#ffc46e'
          g.fillRect(4 + i * 16, 3 + j * 16, 9, 10)
        }
  })
  const glass = make((g) => {
    g.fillStyle = '#c9c9c9' // mullions
    g.fillRect(0, 0, 64, 64)
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        g.fillStyle = lit() < 0.2 ? '#8d949b' : '#767d84'
        g.fillRect(1 + i * 16, 1 + j * 16, 14, 14)
      }
  })
  const glassGlow = make((g) => {
    g.fillStyle = '#000'
    g.fillRect(0, 0, 64, 64)
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++)
        if (lit() < 0.45) {
          g.fillStyle = '#ffd08a'
          g.fillRect(1 + i * 16, 1 + j * 16, 14, 14)
        }
  })
  return { masonry, masonryGlow, glass, glassGlow }
}

// The wall materials live at module scope so updateWichita can turn the
// windows on at night without walking the scene.
const wallMats: THREE.MeshLambertMaterial[] = []

// ---- who's who --------------------------------------------------------------
// Hand-curated from reference photos: real facade colours for the buildings
// people actually recognize. Colours are data; no image ever ships.

interface Style {
  c: number
  glass?: boolean
  top?: number // a contrasting crown band at the roofline
}

const CURATED: Record<string, Style> = {
  'Epic Center': { c: 0x84403a, top: 0xe9e5da }, // red granite, white crown
  'Ruffin Building': { c: 0x6f5a46, glass: true },
  'The Lux': { c: 0xcbb794 },
  'Meritrust Credit Union': { c: 0x8fa3b5, glass: true },
  'Kansas Health Foundation': { c: 0x9db4c9, glass: true },
  'Drury Plaza Hotel Broadview Wichita': { c: 0x9a5a40, top: 0xe6e0d2 },
  'Ambassador Hotel Wichita, Autograph Collection': { c: 0x6e4a38 },
  'Wichita Union Station': { c: 0xd6cdb4 },
  'Keen Kutter Building': { c: 0x99503a },
  'Scottish Rite Center;Temple Live': { c: 0xd9d2bd },
  'Orpheum Theatre': { c: 0x8d5a40 },
  'The Orpheum Offices': { c: 0x8d5a40 },
  'Intrust Bank Arena': { c: 0x6b5a48, glass: true },
}

// These get hand-built hero geometry instead of a plain extrusion.
const CENTURY_II = 'Century II Performing Arts & Convention Center'

const PALETTE = [
  new THREE.Color(0x9a5f3e), // brick
  new THREE.Color(0xb08968), // tan brick
  new THREE.Color(0xc9b28a), // limestone
  new THREE.Color(0x8d8d95), // concrete
  new THREE.Color(0xa39b8b), // stucco
]
const OLD_TOWN_BRICK = [new THREE.Color(0x92462f), new THREE.Color(0x9e553a), new THREE.Color(0x84402c)]
const TALL_GLASS = new THREE.Color(0x7c8fa6)
const ROOF_DARKEN = 0.72

// Old Town's warehouse district really is wall-to-wall red brick.
function inOldTown(lx: number, lz: number): boolean {
  return lx > 620 && lx < 1260 && lz > -460 && lz < 130
}

interface Ring {
  pts: THREE.Vector2[]
  cx: number
  cz: number
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

function toRing(b: WichitaBuilding): Ring | null {
  const pts: THREE.Vector2[] = []
  for (let i = 0; i < b.p.length; i += 2) pts.push(new THREE.Vector2(b.p[i], b.p[i + 1]))
  if (pts.length < 3) return null
  // Normalized CCW seen from above so wall normals face outward.
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const d = pts[(i + 1) % pts.length]
    area += a.y * d.x - a.x * d.y
  }
  if (area < 0) pts.reverse()
  let cx = 0
  let cz = 0
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of pts) {
    cx += p.x
    cz += p.y
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.y)
    maxZ = Math.max(maxZ, p.y)
  }
  return { pts, cx: cx / pts.length, cz: cz / pts.length, minX, maxX, minZ, maxZ }
}

// ---- buildings --------------------------------------------------------------
// Three merged geometries: masonry walls and glass walls (windowed, UV-tiled
// by real floor count), and everything unmapped — roofs, crown bands, roof
// clutter. Three draw calls for ~950 buildings.

interface Buf {
  pos: number[]
  col: number[]
  uv?: number[]
}

function pushTri(buf: Buf, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, c: THREE.Color): void {
  buf.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz)
  buf.col.push(c.r, c.g, c.b, c.r, c.g, c.b, c.r, c.g, c.b)
}

// One wall quad with facade UVs: u rides the cumulative distance around the
// ring so windows never stretch, v is metres above the slab in floors.
function pushWall(buf: Buf, x1: number, z1: number, x2: number, z2: number, y0: number, y1: number, u0: number, c: THREE.Color): number {
  const len = Math.hypot(x2 - x1, z2 - z1)
  const u1 = u0 + len / TILE_W
  const v0 = 0
  const v1 = (y1 - y0) / TILE_H
  buf.pos.push(x1, y0, z1, x2, y0, z2, x2, y1, z2)
  buf.pos.push(x1, y0, z1, x2, y1, z2, x1, y1, z1)
  buf.uv!.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1)
  for (let k = 0; k < 6; k++) buf.col.push(c.r, c.g, c.b)
  return u1
}

// An axis-aligned box (no bottom face) into an unmapped buffer — rooftop
// clutter, clock towers, plinths.
function pushBox(buf: Buf, cx: number, y0: number, cz: number, w: number, h: number, d: number, c: THREE.Color): void {
  const x0 = cx - w / 2
  const x1 = cx + w / 2
  const z0 = cz - d / 2
  const z1 = cz + d / 2
  const y1 = y0 + h
  pushTri(buf, x0, y1, z0, x0, y1, z1, x1, y1, z1, c) // top
  pushTri(buf, x0, y1, z0, x1, y1, z1, x1, y1, z0, c)
  pushTri(buf, x0, y0, z1, x1, y0, z1, x1, y1, z1, c) // +z
  pushTri(buf, x0, y0, z1, x1, y1, z1, x0, y1, z1, c)
  pushTri(buf, x1, y0, z0, x0, y0, z0, x0, y1, z0, c) // -z
  pushTri(buf, x1, y0, z0, x0, y1, z0, x1, y1, z0, c)
  pushTri(buf, x1, y0, z1, x1, y0, z0, x1, y1, z0, c) // +x
  pushTri(buf, x1, y0, z1, x1, y1, z0, x1, y1, z1, c)
  pushTri(buf, x0, y0, z0, x0, y0, z1, x0, y1, z1, c) // -x
  pushTri(buf, x0, y0, z0, x0, y1, z1, x0, y1, z0, c)
}

function bufToMesh(buf: Buf, mat: THREE.Material, name: string): THREE.Mesh {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3))
  if (buf.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2))
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.set(WICHITA_X, 0, WICHITA_Z)
  mesh.name = name
  return mesh
}

function buildBuildings(scene: THREE.Scene): void {
  const maps = drawFacades()
  const masonryBuf: Buf = { pos: [], col: [], uv: [] }
  const glassBuf: Buf = { pos: [], col: [], uv: [] }
  const trimBuf: Buf = { pos: [], col: [] } // roofs, crowns, clutter
  const rand = mulberry32(316) // Wichita's area code, obviously
  const c = new THREE.Color()
  const roof = new THREE.Color()
  const CLUTTER = new THREE.Color(0x8e8e94)

  for (const b of BUILDINGS) {
    if (b.n === CENTURY_II) continue // hero-built below
    const ring = toRing(b)
    if (!ring) continue

    const curated = b.n ? CURATED[b.n] : undefined
    let glassy: boolean
    if (curated) {
      c.setHex(curated.c)
      glassy = !!curated.glass
    } else if (b.h > 28) {
      c.copy(TALL_GLASS)
      glassy = true
    } else if (inOldTown(ring.cx, ring.cz)) {
      c.copy(OLD_TOWN_BRICK[Math.floor(rand() * OLD_TOWN_BRICK.length)])
      glassy = false
    } else {
      c.copy(PALETTE[Math.floor(rand() * PALETTE.length)])
      glassy = false
    }
    c.offsetHSL(0, 0, (rand() - 0.5) * 0.08)
    roof.copy(c).multiplyScalar(ROOF_DARKEN)

    const y0 = WICHITA_GROUND - 0.5 // socketed into the slab, no gaps
    const crown = curated?.top !== undefined && b.h > 20 ? 5 : 0
    const yTop = WICHITA_GROUND + b.h
    const yWall = yTop - crown
    const wallBuf = glassy ? glassBuf : masonryBuf

    // Roof. triangulateShape copes with the concave footprints; winding of
    // its output isn't guaranteed for our axes, so each triangle is checked
    // and flipped to face up.
    const tris = THREE.ShapeUtils.triangulateShape(ring.pts, [])
    for (const [ia, ib, ic] of tris) {
      const A = ring.pts[ia]
      const B = ring.pts[ib]
      const C = ring.pts[ic]
      const ny = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y)
      const [q1, q2] = ny >= 0 ? [B, C] : [C, B]
      pushTri(trimBuf, A.x, yTop, A.y, q1.x, yTop, q1.y, q2.x, yTop, q2.y, roof)
    }

    // Walls, windowed. The crown band (Epic Center's white top, the
    // Broadview's cornice) is a separate unmapped strip above them.
    let u = 0
    const crownColor = new THREE.Color(curated?.top ?? 0xffffff)
    for (let i = 0; i < ring.pts.length; i++) {
      const a = ring.pts[i]
      const d = ring.pts[(i + 1) % ring.pts.length]
      u = pushWall(wallBuf, a.x, a.y, d.x, d.y, y0, yWall, u, c)
      if (crown > 0) {
        pushTri(trimBuf, a.x, yWall, a.y, d.x, yWall, d.y, d.x, yTop, d.y, crownColor)
        pushTri(trimBuf, a.x, yWall, a.y, d.x, yTop, d.y, a.x, yTop, a.y, crownColor)
      }
    }

    // Rooftop clutter: AC units and stair heads on any roof big enough to
    // matter, scattered deterministically inside the footprint's core.
    const area = (ring.maxX - ring.minX) * (ring.maxZ - ring.minZ)
    if (b.h >= 7 && area > 140) {
      const n = 1 + Math.floor(rand() * 3)
      for (let k = 0; k < n; k++) {
        const bx = ring.cx + (rand() - 0.5) * (ring.maxX - ring.minX) * 0.4
        const bz = ring.cz + (rand() - 0.5) * (ring.maxZ - ring.minZ) * 0.4
        pushBox(trimBuf, bx, yTop, bz, 1.2 + rand() * 1.6, 0.8 + rand() * 1.4, 1.2 + rand() * 1.6, CLUTTER)
      }
    }
  }

  const mkWallMat = (map: THREE.Texture | undefined, glow: THREE.Texture | undefined) => {
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
      map,
      emissiveMap: glow,
      emissive: 0xffffff,
      emissiveIntensity: 0,
    })
    wallMats.push(mat)
    return mat
  }
  scene.add(bufToMesh(masonryBuf, mkWallMat(maps?.masonry, maps?.masonryGlow), 'wichita-walls'))
  scene.add(bufToMesh(glassBuf, mkWallMat(maps?.glass, maps?.glassGlow), 'wichita-glass'))
  scene.add(
    bufToMesh(
      trimBuf,
      new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      'wichita-trim',
    ),
  )
}

// ---- heroes -----------------------------------------------------------------
// The handful of silhouettes that make it read as Wichita and not Anytown.

function lambert(color: number, emissive = 0): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, emissive, flatShading: true })
}

function buildHeroes(group: THREE.Group): void {
  // Century II: the round hall with the shallow blue dome. A drum and a
  // cone on its real footprint — five minutes of geometry, instantly it.
  const c2 = BUILDINGS.find((b) => b.n === CENTURY_II)
  const ring = c2 ? toRing(c2) : null
  if (ring) {
    let r = 0
    for (const p of ring.pts) r += Math.hypot(p.x - ring.cx, p.y - ring.cz)
    r /= ring.pts.length
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 13, 18), lambert(0xe9e1cb))
    drum.position.set(ring.cx, WICHITA_GROUND + 6.5, ring.cz)
    const dome = new THREE.Mesh(new THREE.ConeGeometry(r + 5, 8, 18), lambert(0x2f5f9e))
    dome.position.set(ring.cx, WICHITA_GROUND + 17, ring.cz)
    const cupola = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 3, 8), lambert(0xe9e1cb))
    cupola.position.set(ring.cx, WICHITA_GROUND + 22.5, ring.cz)
    group.add(drum, dome, cupola)
  }

  // Intrust Bank Arena: the big pale roof plate floating over dark glass.
  const arena = BUILDINGS.find((b) => b.n === 'Intrust Bank Arena')
  const aring = arena ? toRing(arena) : null
  if (aring && arena) {
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(aring.maxX - aring.minX + 8, 2.5, aring.maxZ - aring.minZ + 8),
      lambert(0xd8d5cd),
    )
    slab.position.set(aring.cx, WICHITA_GROUND + arena.h + 1, aring.cz)
    group.add(slab)
  }

  // Union Station's clock tower.
  const union = BUILDINGS.find((b) => b.n === 'Wichita Union Station')
  const uring = union ? toRing(union) : null
  if (uring && union) {
    const stone = lambert(0xd6cdb4)
    const tower = new THREE.Mesh(new THREE.BoxGeometry(7, 12, 7), stone)
    const towerTop = WICHITA_GROUND + union.h + 6
    tower.position.set(uring.cx, towerTop, uring.cz)
    const cap = new THREE.Mesh(new THREE.ConeGeometry(5.4, 3.5, 4), lambert(0x4f5a48))
    cap.position.set(uring.cx, towerTop + 7.7, uring.cz)
    cap.rotation.y = Math.PI / 4
    group.add(tower, cap)
    const face = lambert(0xf2ead2, 0x584f36)
    for (const [dx, dz, ry] of [
      [0, 3.6, 0],
      [0, -3.6, Math.PI],
      [3.6, 0, Math.PI / 2],
      [-3.6, 0, -Math.PI / 2],
    ]) {
      const clock = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 0.3, 10), face)
      clock.rotation.set(Math.PI / 2, 0, 0)
      clock.rotation.y = ry
      clock.position.set(uring.cx + dx, towerTop + 3, uring.cz + dz)
      group.add(clock)
    }
  }

  // Epic Center's white gabled crown — the extrusion already wears the white
  // band; this is the peak that finishes the skyline's tallest silhouette.
  const epic = BUILDINGS.find((b) => b.n === 'Epic Center')
  const ering = epic ? toRing(epic) : null
  if (ering && epic) {
    const w = ering.maxX - ering.minX
    const d = ering.maxZ - ering.minZ
    const gable = new THREE.Mesh(new THREE.CylinderGeometry(0.01, Math.min(w, d) * 0.42, 7, 4), lambert(0xe9e5da))
    gable.rotation.y = Math.PI / 4
    gable.position.set(ering.cx, WICHITA_GROUND + epic.h + 3.5, ering.cz)
    group.add(gable)
  }
}

// The Keeper of the Plains, at the confluence of the two rivers, with the
// ring of fire lit after dark. Local coords from the real spot (37.69245,
// -97.34518). It's 13m of weathered steel on a stone promontory.
function buildKeeper(group: THREE.Group): void {
  const KX = -985
  const KZ = -729
  const base = Math.max(wichitaHeightAt(WICHITA_X + KX, WICHITA_Z + KZ) ?? WICHITA_GROUND, -2.6)
  const steel = lambert(0x7d4526)
  const dark = lambert(0x5f3418)

  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(5, 6.5, 5, 8), lambert(0x8c8578))
  plinth.position.set(KX, base + 2.5, KZ)
  group.add(plinth)
  const top = base + 5

  const robe = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.6, 7, 6), dark)
  robe.position.set(KX, top + 3.5, KZ)
  const chest = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3, 1.6), steel)
  chest.position.set(KX, top + 8, KZ)
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.3, 1.1), steel)
  head.position.set(KX, top + 10.2, KZ)
  group.add(robe, chest, head)

  // Arms raised to the sky — the whole pose in two boxes.
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 4.4, 0.7), steel)
    arm.position.set(KX + side * 2.1, top + 10.4, KZ)
    arm.rotation.z = side * 0.55
    group.add(arm)
  }

  // The headdress: a fan of feathers sweeping down the back.
  for (let i = 0; i < 7; i++) {
    const a = (i / 6 - 0.5) * 1.9
    const feather = new THREE.Mesh(new THREE.BoxGeometry(0.35, 2.6, 0.12), steel)
    feather.position.set(
      KX + Math.sin(a) * 1.3,
      top + 10.6 + Math.cos(a) * 1.2,
      KZ + 0.75,
    )
    feather.rotation.z = -a
    group.add(feather)
  }

  // The ring of fire drums in the water around the point.
  const flame = new THREE.MeshLambertMaterial({
    color: 0x431105,
    emissive: 0xff5a12,
    flatShading: true,
  })
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2
    const drum = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8, 0), flame)
    drum.position.set(KX + Math.cos(a) * 9, Math.max(base, -0.4) + 0.6, KZ + Math.sin(a) * 9)
    group.add(drum)
  }
}

// Called once a frame from main.ts with the shared clock: the city's windows
// come on as the sun goes down. Same day curve daynight.ts uses for the sky,
// so the skyline lights up exactly as the stars come out.
export function updateWichita(hours: number): void {
  const e = Math.sin(((hours - 6) / 24) * Math.PI * 2)
  const t = Math.min(1, Math.max(0, (e + 0.05) / 0.35))
  const night = 1 - t * t * (3 - 2 * t)
  for (const mat of wallMats) mat.emissiveIntensity = night
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

// ---- street signs -----------------------------------------------------------
// Green blades on gray posts along every real street (w >= 8 skips alleys and
// footpaths), so you can orient the same way you would in the real city. One
// 128x16 canvas per street name (nametag-sized — chunky pixels read better at
// 320x240 than anything finer), and one merged mesh per name, so Douglas costs
// one draw call no matter how many blades it earns.

const SIGN_SPACING = 170
const BLADE_W = 4.4
const BLADE_H = 0.55
const POST_H = 3.1
const SIGN_GREEN = 0x1d6a38

const ABBREV: [RegExp, string][] = [
  [/\bNorth\b/g, 'N'],
  [/\bSouth\b/g, 'S'],
  [/\bEast\b/g, 'E'],
  [/\bWest\b/g, 'W'],
  [/\bStreet\b/g, 'St'],
  [/\bAvenue\b/g, 'Ave'],
  [/\bBoulevard\b/g, 'Blvd'],
  [/\bDrive\b/g, 'Dr'],
  [/\bCourt\b/g, 'Ct'],
  [/\bPlace\b/g, 'Pl'],
  [/\bLane\b/g, 'Ln'],
]

function signTexture(name: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 16
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#' + SIGN_GREEN.toString(16).padStart(6, '0')
  ctx.fillRect(0, 0, 128, 16)
  ctx.strokeStyle = '#e8e8e0'
  ctx.strokeRect(0.5, 0.5, 127, 15)
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 10px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name.toUpperCase(), 64, 9, 120)
  const tex = new THREE.CanvasTexture(canvas)
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function buildSigns(scene: THREE.Scene): void {
  if (typeof document === 'undefined') return
  // Candidate spots: the midpoint of every segment of every named street,
  // grouped by (abbreviated) name.
  interface Spot {
    x: number
    z: number
    dx: number
    dz: number
    half: number
  }
  const spots = new Map<string, Spot[]>()
  for (const r of ROADS) {
    if (!r.n || r.w < 8) continue
    let short = r.n
    for (const [re, s] of ABBREV) short = short.replace(re, s)
    for (let i = 0; i + 3 < r.p.length; i += 2) {
      const x1 = r.p[i]
      const z1 = r.p[i + 1]
      const x2 = r.p[i + 2]
      const z2 = r.p[i + 3]
      const dx = x2 - x1
      const dz = z2 - z1
      const len = Math.hypot(dx, dz)
      if (len < 8) continue
      let list = spots.get(short)
      if (!list) spots.set(short, (list = []))
      list.push({ x: (x1 + x2) / 2, z: (z1 + z2) / 2, dx: dx / len, dz: dz / len, half: r.w / 2 })
    }
  }

  const postBuf: Buf = { pos: [], col: [] }
  const postC = new THREE.Color(0x6f7276)
  const white = new THREE.Color(0xffffff)
  const y = WICHITA_GROUND

  for (const [name, list] of spots) {
    const placed: Spot[] = []
    const blade: Buf = { pos: [], col: [], uv: [] }
    for (const s of list) {
      // Greedy spacing: a blade roughly every long block, not one per segment.
      if (placed.some((p) => Math.hypot(p.x - s.x, p.z - s.z) < SIGN_SPACING)) continue
      placed.push(s)
      // Post on the curb, blade across the top running with the street.
      const px = s.x - s.dz * (s.half + 1.5)
      const pz = s.z + s.dx * (s.half + 1.5)
      pushBox(postBuf, px, y, pz, 0.16, POST_H, 0.16, postC)
      const ex = s.dx * (BLADE_W / 2)
      const ez = s.dz * (BLADE_W / 2)
      const y0 = y + POST_H - BLADE_H
      const y1 = y + POST_H
      // The same quad twice with opposite winding and mirrored u, so the name
      // reads correctly from both sides instead of one side being mirror-text.
      blade.pos.push(px - ex, y0, pz - ez, px + ex, y0, pz + ez, px + ex, y1, pz + ez)
      blade.pos.push(px - ex, y0, pz - ez, px + ex, y1, pz + ez, px - ex, y1, pz - ez)
      blade.uv!.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1)
      blade.pos.push(px + ex, y0, pz + ez, px - ex, y0, pz - ez, px - ex, y1, pz - ez)
      blade.pos.push(px + ex, y0, pz + ez, px - ex, y1, pz - ez, px + ex, y1, pz + ez)
      blade.uv!.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1)
      for (let k = 0; k < 12; k++) blade.col.push(white.r, white.g, white.b)
    }
    if (!blade.pos.length) continue
    scene.add(
      bufToMesh(
        blade,
        new THREE.MeshLambertMaterial({
          map: signTexture(name),
          vertexColors: true,
          flatShading: true,
        }),
        'wichita-sign',
      ),
    )
  }
  scene.add(
    bufToMesh(
      postBuf,
      new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      'wichita-signposts',
    ),
  )
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
  buildBuildings(scene)
  scene.add(buildRoads())
  buildSigns(scene)

  const heroes = new THREE.Group()
  heroes.position.set(WICHITA_X, 0, WICHITA_Z)
  heroes.name = 'wichita-heroes'
  buildHeroes(heroes)
  buildKeeper(heroes)
  scene.add(heroes)

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
