import * as THREE from 'three'
import { addRegion } from './world'

// The shadow realm: a second landmass sitting 1800 units east of the island,
// in the same scene and the same coordinate space. It doesn't need its own
// scene or a realm field in the protocol, because the fog wall (150 units)
// and the camera's far plane (500) mean the two places can never see each
// other. Everything that already works in world space — blocks, craters,
// rockets, arrows, remote players — works here for free.
//
// The floor is a dead-flat basalt plateau at REALM_GROUND so the castle sits
// flush on it, crumbling into a lava sea at the rim. The lava is the island's
// water plane trick reused: player.ts floats you at WATER_LEVEL over anything
// deeper, so falling off the edge drops you in, and main.ts burns you for it.

export const REALM_X = 1800
export const REALM_Z = 0
export const REALM_GROUND = 6 // a whole number of BLOCKs, so the castle sits flush

const HALF = 160 // region half-extent; matches the terrain plane
const FLAT_R = 88 // dead flat out to here: castle, apron, and the arrival pad
const RIM_R = 116 // beyond here the plateau shears off into the lava
const FLOOR_Y = -34 // the void bottoms out, so the mesh keeps a sane bounding box

// Is this point out in the shadow realm? Generous bounds — it only has to
// separate "the island" from "1800 units away".
export function inRealm(x: number, z: number): boolean {
  return Math.abs(x - REALM_X) < 400 && Math.abs(z - REALM_Z) < 400
}

// The realm's analytic heightfield. Null everywhere it isn't, so world.ts
// falls through to the island.
export function realmHeightAt(x: number, z: number): number | null {
  const dx = x - REALM_X
  const dz = z - REALM_Z
  if (Math.abs(dx) > HALF || Math.abs(dz) > HALF) return null
  const d = Math.hypot(dx, dz)
  if (d <= FLAT_R) return REALM_GROUND
  // Ridged badlands easing in past the flat, then a cliff into the lava.
  const t = Math.min(1, (d - FLAT_R) / 24)
  const ease = t * t * (3 - 2 * t)
  const ridge =
    Math.sin(dx * 0.085) * Math.cos(dz * 0.105) * 2.4 +
    Math.sin(dx * 0.033 + 2.2) * Math.sin(dz * 0.039 - 1.1) * 3.6
  let h = REALM_GROUND + ridge * ease
  if (d > RIM_R) h -= Math.pow((d - RIM_R) / 26, 2.2) * 70
  return Math.max(FLOOR_Y, h)
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

const BASALT = new THREE.Color(0x5c5070)
const HIGH_BASALT = new THREE.Color(0x473c5b)
const SCORCH = new THREE.Color(0x7b3a1e)
const EMBER = new THREE.Color(0xb04a1e)
const ROAD = new THREE.Color(0x3d3550)

function buildRealmTerrain(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(320, 320, 96, 96)
  geo.rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  const colors: number[] = []
  const rand = mulberry32(9001)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i)
    const lz = pos.getZ(i)
    const h = realmHeightAt(lx + REALM_X, lz + REALM_Z) ?? FLOOR_Y
    pos.setY(i, h)
    if (h < -6) c.copy(EMBER)
    else if (h < 1.5) c.copy(SCORCH)
    else if (h > REALM_GROUND + 2) c.copy(HIGH_BASALT)
    else c.copy(BASALT)
    // A scorched processional road from the arrival portal up to the gate.
    if (Math.abs(lx) < 5 && lz > -84 && lz < -32) c.lerp(ROAD, 0.8)
    c.offsetHSL(0, 0, (rand() - 0.5) * 0.07)
    colors.push(c.r, c.g, c.b)
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  // Vertices are mesh-local; world.ts needs the offset to carve craters here.
  geo.userData.origin = new THREE.Vector2(REALM_X, REALM_Z)
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  )
  mesh.position.set(REALM_X, 0, REALM_Z)
  mesh.name = 'realm-terrain'
  return mesh
}

// Jagged obsidian teeth around the plateau, plus rock shards hanging in the
// air. Seeded, so everybody's skyline matches.
function buildSkyline(scene: THREE.Scene, rand: () => number): void {
  const obsidian = new THREE.MeshLambertMaterial({ color: 0x211a2b, flatShading: true })
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + rand() * 0.2
    const r = 92 + rand() * 26
    const height = 16 + rand() * 34
    const spire = new THREE.Mesh(new THREE.ConeGeometry(3 + rand() * 4, height, 5), obsidian)
    spire.position.set(
      REALM_X + Math.cos(a) * r,
      (realmHeightAt(REALM_X + Math.cos(a) * r, REALM_Z + Math.sin(a) * r) ?? 0) + height / 2 - 2,
      REALM_Z + Math.sin(a) * r,
    )
    spire.rotation.set((rand() - 0.5) * 0.18, rand() * Math.PI, (rand() - 0.5) * 0.18)
    scene.add(spire)
  }
  for (let i = 0; i < 10; i++) {
    const a = rand() * Math.PI * 2
    const r = 40 + rand() * 70
    const size = 2 + rand() * 5
    const shard = new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), obsidian)
    shard.position.set(
      REALM_X + Math.cos(a) * r,
      26 + rand() * 30,
      REALM_Z + Math.sin(a) * r,
    )
    shard.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI)
    scene.add(shard)
  }
}

// Braziers lining the road to the gate — the only warm light out here.
function buildBraziers(scene: THREE.Scene): void {
  const stone = new THREE.MeshLambertMaterial({ color: 0x2b2534, flatShading: true })
  const coals = new THREE.MeshLambertMaterial({
    color: 0x431105,
    emissive: 0xff5a12,
    flatShading: true,
  })
  for (let i = 0; i < 5; i++) {
    for (const side of [-1, 1]) {
      const x = REALM_X + side * 7
      const z = REALM_Z - 70 + i * 7 // stops short of the gate turrets
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 3.2, 5), stone)
      post.position.set(x, REALM_GROUND + 1.6, z)
      const bowl = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, 0), coals)
      bowl.position.set(x, REALM_GROUND + 3.5, z)
      scene.add(post, bowl)
    }
  }
}

export function createRealm(scene: THREE.Scene): void {
  const terrain = buildRealmTerrain()
  scene.add(terrain)
  addRegion(realmHeightAt, terrain.geometry)

  // The lava sea. Same trick as the island's water: the visible surface sits
  // at y=0 and player.ts floats you chest-deep at WATER_LEVEL beneath it.
  const lava = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.MeshLambertMaterial({ color: 0x5d1403, emissive: 0xff4d0a, flatShading: true }),
  )
  lava.rotateX(-Math.PI / 2)
  lava.position.set(REALM_X, 0, REALM_Z)
  scene.add(lava)

  const rand = mulberry32(31337)
  buildSkyline(scene, rand)
  buildBraziers(scene)
}
