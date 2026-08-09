import * as THREE from 'three'

const ISLAND_RADIUS = 90

export interface Island {
  name: string
  x: number
  z: number
  r: number
}

// Every island you can stand on. Home sits at the origin exactly where it
// always has; the far rock is out east, past the fog wall, close enough to
// rocket to (see rocket.ts) and far enough that it's a rumour from the beach.
//
// Two rules hold this together, and both are load-bearing:
//   1. baseHeightAt takes the TALLEST island at a point, so each one keeps
//      precisely the shape it had when it was alone in the world.
//   2. createWorld builds one terrain mesh per island, tiled edge to edge in
//      x and never overlapping — two meshes over the same ground z-fight.
// Adding a third island means extending both, plus the grid/crater caps in
// blocks.ts and server/room.ts that bound how far out the world may be edited.
export const ISLANDS: Island[] = [
  { name: 'home', x: 0, z: 0, r: ISLAND_RADIUS },
  { name: 'the far rock', x: 280, z: 0, r: 70 },
]

// A bowl carved out of the terrain by a rocket blast or a shovel dig.
// Synced through the room (net.ts 'crater' message) and summed into heightAt.
export interface Crater {
  x: number
  z: number
  r: number
  d: number
}

export interface DestroyedProp {
  kind: 'tree' | 'rock'
  x: number
  y: number
  z: number
  s: number
}

interface Prop {
  kind: 'tree' | 'rock'
  obj: THREE.Object3D
  x: number
  y: number
  z: number
  hitR: number
  s: number
}

// Where the sea sits. Deep water floats you chest-deep instead of sinking
// you forever; player.ts re-exports this, which is where most of the game
// reads it from. It lives here because it's a fact about the terrain, and
// modules that only know about the ground (xwing.ts) need it without
// dragging in the player.
export const WATER_LEVEL = -1.1

// Craters can only dig so deep at one spot — enough that holes below the
// water line become swimmable ponds, not tunnels to the void.
const MAX_DIG = 5

const craters: Crater[] = []
const craterKeys = new Set<string>()
let revision = 0
const props: Prop[] = []
const terrainGeos: THREE.BufferGeometry[] = []
let worldScene: THREE.Scene | null = null
// Somewhere else on the map another landmass owns the heightfield (the
// shadow realm, way out past the fog). It returns null everywhere it isn't.
let region: ((x: number, z: number) => number | null) | null = null

// A landmass beyond the island: its own analytic height, and a mesh that
// craters carve the same way they carve the island.
export function addRegion(
  heightFn: (x: number, z: number) => number | null,
  geo: THREE.BufferGeometry,
): void {
  region = heightFn
  terrainGeos.push(geo)
}

// The untouched island shape. Placement code (terrain build, tree/rock
// loops) must use this — never the crater-adjusted heightAt — so the seeded
// PRNG streams stay identical on every client no matter what has been
// blown up by the time someone joins.
//
// Also exported because the travel map draws the world from it (map.ts): the
// same surface heightAt reports, minus the crater walk, which is invisible at
// map scale and would mean 30k crater-list scans per redraw.
//
// Two layers sit on top of the base noise, in order. A region (the shadow
// realm) owns its patch of the map outright and short-circuits everything
// else. Otherwise the tallest ISLAND wins.
export function baseHeightAt(x: number, z: number): number {
  const other = region?.(x, z)
  if (other !== null && other !== undefined) return other
  const noise =
    Math.sin(x * 0.05) * Math.cos(z * 0.05) * 3 +
    Math.sin(x * 0.021 + 1.7) * Math.cos(z * 0.017 - 0.4) * 6 +
    Math.sin(x * 0.11 - 2.1) * Math.sin(z * 0.13) * 1.2 +
    4
  // Tallest island wins. Home's own term is untouched by this — every other
  // island is hundreds of units of falloff away by the time you're standing
  // on it — so the world everyone already built on is bit-for-bit the same.
  let h = -Infinity
  for (const isl of ISLANDS) {
    const d = Math.hypot(x - isl.x, z - isl.z)
    h = Math.max(h, noise - Math.pow(d / isl.r, 3) * 18)
  }
  return h
}

// Which island is nearest to a point (an index into ISLANDS). Used by the map
// and by "rocket me to the next island", which is just the other one.
export function nearestIsland(x: number, z: number): number {
  let best = 0
  let bestD = Infinity
  ISLANDS.forEach((isl, i) => {
    const d = Math.hypot(x - isl.x, z - isl.z)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

// Somewhere dry to come down on an island. Rejection sampled against the
// crater-aware heightAt so a rocket never drops you into a flooded pit; the
// island's middle as a last resort. Not deterministic and doesn't need to be
// — only the traveller picks their own landing spot.
export function landingSpotOn(index: number): { x: number; z: number } {
  const isl = ISLANDS[index] ?? ISLANDS[0]
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * Math.PI * 2
    const r = Math.sqrt(Math.random()) * isl.r * 0.6
    const x = isl.x + Math.cos(a) * r
    const z = isl.z + Math.sin(a) * r
    if (heightAt(x, z) > 1.5) return { x, z }
  }
  return { x: isl.x, z: isl.z }
}

// Deterministic terrain height — the client is the only authority on
// geometry, so everyone computes the identical island from this function.
// Craters subtract as an order-independent clamped sum, so clients that
// received the same craters in different orders still agree exactly.
export function heightAt(x: number, z: number): number {
  let dig = 0
  for (const c of craters) {
    // Cheap axis-aligned reject first — this loop runs for every terrain
    // sample and almost every crater is nowhere near the point asked about.
    const dx = x - c.x
    if (dx > c.r || dx < -c.r) continue
    const dz = z - c.z
    if (dz > c.r || dz < -c.r) continue
    const sq = dx * dx + dz * dz
    if (sq >= c.r * c.r) continue
    dig += c.d * (0.5 + 0.5 * Math.cos((Math.PI * Math.sqrt(sq)) / c.r))
  }
  return baseHeightAt(x, z) - Math.min(dig, MAX_DIG)
}

// Bumped whenever the terrain shape changes. Anything caching a picture of
// the island (the minimap) watches this instead of wiring up a callback.
export function terrainVersion(): number {
  return revision
}

// For consumers that cache terrain piecewise (the physics heightfields) and
// only want to rebuild the pieces a crater actually touched: fired with each
// batch of craters whose shape just changed, alongside the revision bump.
// terrainVersion stays the coarse whole-world signal for everyone else.
const craterListeners: ((changed: readonly Crater[]) => void)[] = []
export function onCraters(cb: (changed: readonly Crater[]) => void): void {
  craterListeners.push(cb)
}

const DIRT = new THREE.Color(0x6b4526)
const ZERO = new THREE.Vector2(0, 0)

// Apply craters we just learned about: carve the terrain mesh, expose dirt,
// and kill any props caught inside. Returns the props that died so the
// caller can blow them up visually. Idempotent (reconnect welcome replays
// are deduped) and batched: one mesh refresh per call, not per crater.
export function addCraters(list: Crater[]): DestroyedProp[] {
  const fresh: Crater[] = []
  for (const c of list) {
    const key = `${c.x}|${c.z}|${c.r}|${c.d}`
    if (craterKeys.has(key)) continue
    craterKeys.add(key)
    fresh.push(c)
  }
  if (fresh.length === 0) return []
  craters.push(...fresh)
  // Mirror the server's 500-crater replay cap so an all-night session can't
  // grow the heightAt walk forever. Drop the key too, or a re-sent old
  // crater would be deduped into nothing. Evicted craters changed the shape
  // too (their dig un-carves), so they count as changed for the listeners.
  const changed: Crater[] = [...fresh]
  while (craters.length > 500) {
    const old = craters.shift()!
    craterKeys.delete(`${old.x}|${old.z}|${old.r}|${old.d}`)
    changed.push(old)
  }
  revision++
  for (const cb of craterListeners) cb(changed)

  // Every tile: a crater can land on any island, or in the realm.
  for (const geo of terrainGeos) {
    const pos = geo.attributes.position
    const col = geo.attributes.color
    const origin = (geo.userData.origin as THREE.Vector2 | undefined) ?? ZERO
    const tint = new THREE.Color()
    let touched = false
    for (let i = 0; i < pos.count; i++) {
      // Region meshes sit at an offset; their vertices are mesh-local.
      const x = pos.getX(i) + origin.x
      const z = pos.getZ(i) + origin.y
      let bite = 0
      for (const c of fresh) {
        const dx = x - c.x
        const dz = z - c.z
        const sq = dx * dx + dz * dz
        if (sq >= c.r * c.r) continue
        bite += c.d * (0.5 + 0.5 * Math.cos((Math.PI * Math.sqrt(sq)) / c.r))
      }
      if (bite <= 0) continue
      touched = true
      pos.setY(i, heightAt(x, z))
      tint.setRGB(col.getX(i), col.getY(i), col.getZ(i))
      tint.lerp(DIRT, Math.min(1, bite * 0.9))
      tint.offsetHSL(0, 0, ((Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1) - 0.5) * 0.06)
      col.setXYZ(i, tint.r, tint.g, tint.b)
    }
    if (!touched) continue
    pos.needsUpdate = true
    col.needsUpdate = true
    geo.computeVertexNormals()
  }

  const dead: DestroyedProp[] = []
  for (let i = props.length - 1; i >= 0; i--) {
    const prop = props[i]
    for (const c of fresh) {
      const reach = c.r + prop.hitR * 0.5
      const dx = prop.x - c.x
      const dz = prop.z - c.z
      if (dx * dx + dz * dz >= reach * reach) continue
      worldScene?.remove(prop.obj)
      // Free the prop's GPU resources; the rocks share one material per
      // scatter, but disposing a still-shared material is safe in three.js
      // (it just re-uploads on next use).
      prop.obj.traverse((child) => {
        const mesh = child as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        if (mesh.material) (mesh.material as THREE.Material).dispose()
      })
      props.splice(i, 1)
      dead.push({ kind: prop.kind, x: prop.x, y: prop.y, z: prop.z, s: prop.s })
      break
    }
  }
  return dead
}

// Is this point inside a living tree or rock? Rockets check this so shooting
// a prop head-on detonates against it instead of flying through.
export function propInPath(p: THREE.Vector3): boolean {
  for (const prop of props) {
    const dx = p.x - prop.x
    const dz = p.z - prop.z
    const r = prop.hitR * 0.8
    if (dx * dx + dz * dz >= r * r) continue
    const top = prop.y + (prop.kind === 'tree' ? 4.5 * prop.s : prop.hitR * 1.5)
    if (p.y < top) return true
  }
  return false
}

// Deterministic PRNG so tree/rock placement matches on every client.
// Exported for other world content (treasure.ts) — always give new content
// its own seed so the existing prop streams don't shift.
export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// One terrain tile, spanning `width` in x centred on `cx` and the full 320 in
// z. Segment size must come out the same on every tile (3⅓ units), so tiles
// share their seam vertices exactly and the join is invisible underwater.
function buildTerrain(cx: number, width: number, segX: number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(width, 320, segX, 96)
  geo.rotateX(-Math.PI / 2)
  geo.translate(cx, 0, 0)
  const pos = geo.attributes.position
  const colors: number[] = []
  const rand = mulberry32(1)
  const sand = new THREE.Color(0xd8c47a)
  const grass = new THREE.Color(0x4f9e3f)
  const rock = new THREE.Color(0x8a8a92)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const h = baseHeightAt(x, z)
    pos.setY(i, h)
    if (h < 1) c.copy(sand)
    else if (h < 10.5) c.copy(grass)
    else c.copy(rock)
    // Slight per-vertex tint variation for that vertex-lit N64 look.
    c.offsetHSL(0, 0, (rand() - 0.5) * 0.08)
    colors.push(c.r, c.g, c.b)
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'terrain'
  terrainGeos.push(geo)
  return mesh
}

function buildTree(): THREE.Group {
  const tree = new THREE.Group()
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25, 0.35, 1.6, 5),
    new THREE.MeshLambertMaterial({ color: 0x6b4a2b, flatShading: true }),
  )
  trunk.position.y = 0.8
  const leaves = new THREE.Mesh(
    new THREE.ConeGeometry(1.6, 3.2, 6),
    new THREE.MeshLambertMaterial({ color: 0x2e7d32, flatShading: true }),
  )
  leaves.position.y = 3
  tree.add(trunk, leaves)
  return tree
}

export function createWorld(scene: THREE.Scene): void {
  worldScene = scene
  const sky = new THREE.Color(0x9fd4ea)
  scene.background = sky
  scene.fog = new THREE.Fog(sky, 40, 150)

  // Named so daynight.ts can find and drive them through the day cycle.
  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x5a7a4a, 0.9)
  hemi.name = 'hemi-light'
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xfff2cc, 1.4)
  sun.name = 'sun-light'
  sun.position.set(40, 60, 20)
  scene.add(sun)

  // One tile per island, laid end to end: home covers x -160..160 (exactly the
  // plane it has always had), the far rock picks up at 160 and runs to 400.
  scene.add(buildTerrain(0, 320, 96))
  scene.add(buildTerrain(280, 240, 72))

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(800, 800),
    new THREE.MeshLambertMaterial({ color: 0x3f76c9, transparent: true, opacity: 0.85 }),
  )
  water.rotateX(-Math.PI / 2)
  water.position.y = 0
  scene.add(water)

  // Each island gets its own PRNG stream, so adding one can never shift the
  // trees and rocks on any island that came before it.
  scatterProps(scene, ISLANDS[0], 42, 70, 20)
  scatterProps(scene, ISLANDS[1], 77, 26, 34) // barer and rockier than home
}

function scatterProps(
  scene: THREE.Scene,
  isl: Island,
  seed: number,
  trees: number,
  rocks: number,
): void {
  const rand = mulberry32(seed)
  for (let i = 0; i < trees; i++) {
    const x = isl.x + (rand() - 0.5) * 2 * (isl.r - 8)
    const z = isl.z + (rand() - 0.5) * 2 * (isl.r - 8)
    const h = baseHeightAt(x, z)
    if (h < 1.5 || h > 9) continue
    const tree = buildTree()
    tree.position.set(x, h - 0.1, z)
    const s = 0.7 + rand() * 0.8
    tree.scale.setScalar(s)
    tree.rotation.y = rand() * Math.PI * 2
    scene.add(tree)
    props.push({ kind: 'tree', obj: tree, x, y: h - 0.1, z, hitR: 1.6 * s, s })
  }

  const rockMat = new THREE.MeshLambertMaterial({ color: 0x7d7d85, flatShading: true })
  for (let i = 0; i < rocks; i++) {
    const x = isl.x + (rand() - 0.5) * 2 * (isl.r - 5)
    const z = isl.z + (rand() - 0.5) * 2 * (isl.r - 5)
    const h = baseHeightAt(x, z)
    if (h < 0.5) continue
    const size = 0.5 + rand() * 1.2
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), rockMat)
    rock.position.set(x, h, z)
    rock.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI)
    scene.add(rock)
    props.push({ kind: 'rock', obj: rock, x, y: h, z, hitR: size, s: size })
  }
}
