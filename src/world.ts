import * as THREE from 'three'

const ISLAND_RADIUS = 90

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
  alive: boolean
}

// Craters can only dig so deep at one spot — enough that holes below the
// water line (-1.1) become swimmable ponds, not tunnels to the void.
const MAX_DIG = 5

const craters: Crater[] = []
const craterKeys = new Set<string>()
let revision = 0
const props: Prop[] = []
let terrainGeo: THREE.BufferGeometry | null = null
let worldScene: THREE.Scene | null = null

// The untouched island shape. Placement code (terrain build, tree/rock
// loops) must use this — never the crater-adjusted heightAt — so the seeded
// PRNG streams stay identical on every client no matter what has been
// blown up by the time someone joins.
function baseHeightAt(x: number, z: number): number {
  let h =
    Math.sin(x * 0.05) * Math.cos(z * 0.05) * 3 +
    Math.sin(x * 0.021 + 1.7) * Math.cos(z * 0.017 - 0.4) * 6 +
    Math.sin(x * 0.11 - 2.1) * Math.sin(z * 0.13) * 1.2 +
    4
  const d = Math.hypot(x, z)
  h -= Math.pow(d / ISLAND_RADIUS, 3) * 18
  return h
}

// Deterministic terrain height — the client is the only authority on
// geometry, so everyone computes the identical island from this function.
// Craters subtract as an order-independent clamped sum, so clients that
// received the same craters in different orders still agree exactly.
export function heightAt(x: number, z: number): number {
  let dig = 0
  for (const c of craters) {
    const dx = x - c.x
    const dz = z - c.z
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

const DIRT = new THREE.Color(0x6b4526)

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
  revision++

  if (terrainGeo) {
    const pos = terrainGeo.attributes.position
    const col = terrainGeo.attributes.color
    const tint = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      let bite = 0
      for (const c of fresh) {
        const dx = x - c.x
        const dz = z - c.z
        const sq = dx * dx + dz * dz
        if (sq >= c.r * c.r) continue
        bite += c.d * (0.5 + 0.5 * Math.cos((Math.PI * Math.sqrt(sq)) / c.r))
      }
      if (bite <= 0) continue
      pos.setY(i, heightAt(x, z))
      tint.setRGB(col.getX(i), col.getY(i), col.getZ(i))
      tint.lerp(DIRT, Math.min(1, bite * 0.9))
      tint.offsetHSL(0, 0, ((Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1) - 0.5) * 0.06)
      col.setXYZ(i, tint.r, tint.g, tint.b)
    }
    pos.needsUpdate = true
    col.needsUpdate = true
    terrainGeo.computeVertexNormals()
  }

  const dead: DestroyedProp[] = []
  for (const prop of props) {
    if (!prop.alive) continue
    for (const c of fresh) {
      const reach = c.r + prop.hitR * 0.5
      const dx = prop.x - c.x
      const dz = prop.z - c.z
      if (dx * dx + dz * dz >= reach * reach) continue
      prop.alive = false
      worldScene?.remove(prop.obj)
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
    if (!prop.alive) continue
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

function buildTerrain(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(320, 320, 96, 96)
  geo.rotateX(-Math.PI / 2)
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
  terrainGeo = geo
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

  scene.add(buildTerrain())

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(800, 800),
    new THREE.MeshLambertMaterial({ color: 0x3f76c9, transparent: true, opacity: 0.85 }),
  )
  water.rotateX(-Math.PI / 2)
  water.position.y = 0
  scene.add(water)

  const rand = mulberry32(42)
  for (let i = 0; i < 70; i++) {
    const x = (rand() - 0.5) * 2 * (ISLAND_RADIUS - 8)
    const z = (rand() - 0.5) * 2 * (ISLAND_RADIUS - 8)
    const h = baseHeightAt(x, z)
    if (h < 1.5 || h > 9) continue
    const tree = buildTree()
    tree.position.set(x, h - 0.1, z)
    const s = 0.7 + rand() * 0.8
    tree.scale.setScalar(s)
    tree.rotation.y = rand() * Math.PI * 2
    scene.add(tree)
    props.push({ kind: 'tree', obj: tree, x, y: h - 0.1, z, hitR: 1.6 * s, s, alive: true })
  }

  const rockMat = new THREE.MeshLambertMaterial({ color: 0x7d7d85, flatShading: true })
  for (let i = 0; i < 20; i++) {
    const x = (rand() - 0.5) * 2 * (ISLAND_RADIUS - 5)
    const z = (rand() - 0.5) * 2 * (ISLAND_RADIUS - 5)
    const h = baseHeightAt(x, z)
    if (h < 0.5) continue
    const size = 0.5 + rand() * 1.2
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), rockMat)
    rock.position.set(x, h, z)
    rock.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI)
    scene.add(rock)
    props.push({ kind: 'rock', obj: rock, x, y: h, z, hitR: size, s: size, alive: true })
  }
}
