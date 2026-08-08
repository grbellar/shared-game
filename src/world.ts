import * as THREE from 'three'

const ISLAND_RADIUS = 90

// Deterministic terrain height — the client is the only authority on
// geometry, so everyone computes the identical island from this function.
export function heightAt(x: number, z: number): number {
  let h =
    Math.sin(x * 0.05) * Math.cos(z * 0.05) * 3 +
    Math.sin(x * 0.021 + 1.7) * Math.cos(z * 0.017 - 0.4) * 6 +
    Math.sin(x * 0.11 - 2.1) * Math.sin(z * 0.13) * 1.2 +
    4
  const d = Math.hypot(x, z)
  h -= Math.pow(d / ISLAND_RADIUS, 3) * 18
  return h
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
    const h = heightAt(x, z)
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
  const sky = new THREE.Color(0x9fd4ea)
  scene.background = sky
  scene.fog = new THREE.Fog(sky, 40, 150)

  scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x5a7a4a, 0.9))
  const sun = new THREE.DirectionalLight(0xfff2cc, 1.4)
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
    const h = heightAt(x, z)
    if (h < 1.5 || h > 9) continue
    const tree = buildTree()
    tree.position.set(x, h - 0.1, z)
    const s = 0.7 + rand() * 0.8
    tree.scale.setScalar(s)
    tree.rotation.y = rand() * Math.PI * 2
    scene.add(tree)
  }

  const rockMat = new THREE.MeshLambertMaterial({ color: 0x7d7d85, flatShading: true })
  for (let i = 0; i < 20; i++) {
    const x = (rand() - 0.5) * 2 * (ISLAND_RADIUS - 5)
    const z = (rand() - 0.5) * 2 * (ISLAND_RADIUS - 5)
    const h = heightAt(x, z)
    if (h < 0.5) continue
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5 + rand() * 1.2, 0), rockMat)
    rock.position.set(x, h, z)
    rock.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI)
    scene.add(rock)
  }
}
