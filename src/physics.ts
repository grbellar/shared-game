import * as THREE from 'three'
import type { Collider, RigidBody } from '@dimforge/rapier3d-compat'
import type RAPIER_ from '@dimforge/rapier3d-compat'
import { heightAt, onCraters, terrainVersion, type Crater } from './world'
import { BLOCK, blocksVersion, forEachBlock } from './blocks'
import { REALM_X, REALM_Z } from './realm'

// Real rigid-body physics (Rapier, Rust->WASM) for the cosmetic stuff that
// should tumble, bounce, roll downhill and pile up in craters: debris cubes
// and popped heads. Strictly a CONSUMER of world truth, never a source — the
// colliders are derived from heightAt and the block grid, and nothing here
// touches game state or the network. Every body is client-local eye candy,
// the same authority class as smoke puffs.
//
// The WASM (~1MB gzipped) loads via dynamic import so it stays off the
// critical path; until it's ready every spawn returns false and effects.ts
// falls back to its old hand-rolled puffs.

const STEP = 1 / 60
const GRAVITY = 30 // matches player.ts
const KILL_Y = -4 // under the sea (or the lava): gone
const MAX_DEBRIS = 96

// Terrain heightfields, one per landmass, sampled straight from heightAt so
// they inherit craters. Home and the far rock at ~3.3-unit spacing (the
// render mesh's own resolution); the realm coarser — it's a flat plateau.
const ZONES = [
  { cx: 0, cz: 0, span: 210, n: 64 },
  { cx: 280, cz: 0, span: 160, n: 49 },
  { cx: REALM_X, cz: REALM_Z, span: 810, n: 163 },
]

interface Zone {
  cx: number
  cz: number
  span: number
  n: number
  collider: Collider | null
}

interface Debris {
  body: RigidBody
  life: number
  size: number
}

// A caller-owned mesh riding a physics body (the popped head). We drive the
// transform until life runs out, then hand the mesh back through onDone.
interface Attached {
  mesh: THREE.Object3D
  body: RigidBody
  life: number
  onDone: (mesh: THREE.Object3D) => void
}

let R: typeof RAPIER_ | null = null
let world: InstanceType<typeof RAPIER_.World> | null = null
let acc = 0

const zones: Zone[] = []
const dirtyZones: Zone[] = []
let seenTerrainV = -1
// Craters carved since the last stepPhysics look — only zones one of these
// actually overlaps get resampled (a realm rebuild alone is ~26k heightAt
// calls, far too much to pay for a crater on the beach).
const pendingCraters: Crater[] = []

let voxCollider: Collider | null = null
let voxSet = new Set<string>()
let seenBlocksV = -1

let debrisMesh: THREE.InstancedMesh | null = null
const slots: (Debris | null)[] = new Array(MAX_DEBRIS).fill(null)
let nextSlot = 0
const attached: Attached[] = []

const tmpMat = new THREE.Matrix4()
const tmpQuat = new THREE.Quaternion()
const tmpPos = new THREE.Vector3()
const tmpScale = new THREE.Vector3()
const tmpColor = new THREE.Color()
const GONE = new THREE.Matrix4().makeScale(0, 0, 0)

export async function initPhysics(scene: THREE.Scene): Promise<void> {
  const mod = await import('@dimforge/rapier3d-compat')
  R = mod.default
  await R.init()
  world = new R.World({ x: 0, y: -GRAVITY, z: 0 })

  onCraters((changed) => pendingCraters.push(...changed))
  for (const z of ZONES) {
    const zone: Zone = { ...z, collider: null }
    buildZone(zone)
    zones.push(zone)
  }
  // Craters that landed while the WASM loaded are already baked into the
  // fields we just built.
  pendingCraters.length = 0
  // Debris bounces off the sea surface the way the old puffs always did
  // (they floored at y=0 over water) — a big slab covering both islands.
  // The realm is beyond its edge, so out there debris sinks into the lava.
  world.createCollider(
    R.ColliderDesc.cuboid(500, 1, 500).setTranslation(0, -1.02, 0).setFriction(0.9),
  )
  seenTerrainV = terrainVersion()

  const geo = new THREE.BoxGeometry(1, 1, 1)
  const mat = new THREE.MeshLambertMaterial({ flatShading: true })
  debrisMesh = new THREE.InstancedMesh(geo, mat, MAX_DEBRIS)
  debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  // Debris scatters across landmasses 1800 units apart; one bounding sphere
  // would cull it wrong (same call blocks.ts makes).
  debrisMesh.frustumCulled = false
  debrisMesh.count = 0
  scene.add(debrisMesh)
}

// Sample a landmass into a heightfield collider. Rapier lays heights out as
// heights[ix * n + iz] with both indices ascending along world +x/+z and the
// field centered on the collider (verified empirically against 0.20).
function buildZone(zone: Zone): void {
  if (!R || !world) return
  const n = zone.n
  const heights = new Float32Array(n * n)
  for (let ix = 0; ix < n; ix++)
    for (let iz = 0; iz < n; iz++) {
      const wx = zone.cx + (ix / (n - 1) - 0.5) * zone.span
      const wz = zone.cz + (iz / (n - 1) - 0.5) * zone.span
      // Clamp the island falloff: past the beach it plunges thousands of
      // units, which would give the field absurd near-vertical skirts.
      heights[ix * n + iz] = Math.max(heightAt(wx, wz), -40)
    }
  if (zone.collider) world.removeCollider(zone.collider, false)
  zone.collider = world.createCollider(
    R.ColliderDesc.heightfield(n - 1, n - 1, heights, { x: zone.span, y: 1, z: zone.span })
      .setTranslation(zone.cx, 0, zone.cz)
      .setFriction(0.9),
  )
}

// Mirror the block grid into one sparse voxel collider. Voxel (i) spans
// [i*size, (i+1)*size) per axis, so the grid's xz-centered cells need a
// half-block offset. Small diffs go through setVoxel; a welcome reset (the
// whole castle regenerating) rebuilds the collider outright.
function syncBlocks(): void {
  if (!R || !world) return
  const cur = new Set<string>()
  forEachBlock((s) => cur.add(`${s.gx},${s.gy},${s.gz}`))
  const add: string[] = []
  const del: string[] = []
  for (const k of cur) if (!voxSet.has(k)) add.push(k)
  for (const k of voxSet) if (!cur.has(k)) del.push(k)
  if (add.length === 0 && del.length === 0) return
  if (!voxCollider || add.length + del.length > 400) {
    if (voxCollider) {
      world.removeCollider(voxCollider, false)
      voxCollider = null
    }
    if (cur.size > 0) {
      const data = new Int32Array(cur.size * 3)
      let i = 0
      for (const k of cur) {
        const [gx, gy, gz] = k.split(',').map(Number)
        data[i++] = gx
        data[i++] = gy
        data[i++] = gz
      }
      voxCollider = world.createCollider(
        R.ColliderDesc.voxels(data, { x: BLOCK, y: BLOCK, z: BLOCK })
          .setTranslation(-BLOCK / 2, 0, -BLOCK / 2)
          .setFriction(0.8),
      )
    }
  } else {
    for (const k of add) {
      const [gx, gy, gz] = k.split(',').map(Number)
      voxCollider.setVoxel(gx, gy, gz, true)
    }
    for (const k of del) {
      const [gx, gy, gz] = k.split(',').map(Number)
      voxCollider.setVoxel(gx, gy, gz, false)
    }
  }
  voxSet = cur
}

// The ground moved (crater) or blocks changed — anything asleep on the old
// surface needs to notice.
function wakeAll(): void {
  for (const d of slots) d?.body.wakeUp()
  for (const a of attached) a.body.wakeUp()
}

// Did anything write into the instance buffer since the last upload? Saves
// flagging a GPU re-upload every frame while no debris exists at all.
let instDirty = false

function freeSlot(i: number): void {
  const d = slots[i]
  if (!d) return
  world?.removeRigidBody(d.body)
  slots[i] = null
  debrisMesh?.setMatrixAt(i, GONE)
  instDirty = true
}

// One tumbling debris cube. False when the engine isn't up (or was never
// asked for) — the caller keeps its old fake-puff path as the fallback.
export function spawnPhysicsDebris(center: THREE.Vector3, color: number, power: number): boolean {
  if (!R || !world || !debrisMesh) return false
  const i = nextSlot++ % MAX_DEBRIS
  freeSlot(i)
  const size = 0.13 + Math.random() * 0.15
  const body = world.createRigidBody(
    R.RigidBodyDesc.dynamic()
      .setTranslation(center.x, center.y + 0.1, center.z)
      .setLinvel((Math.random() - 0.5) * power * 1.3, Math.random() * power + 1, (Math.random() - 0.5) * power * 1.3)
      .setAngvel({
        x: (Math.random() - 0.5) * 14,
        y: (Math.random() - 0.5) * 14,
        z: (Math.random() - 0.5) * 14,
      })
      .setCcdEnabled(true),
  )
  world.createCollider(
    R.ColliderDesc.cuboid(size / 2, size / 2, size / 2).setRestitution(0.35).setFriction(0.85),
    body,
  )
  slots[i] = { body, life: 2.8 + Math.random() * 1.8, size }
  debrisMesh.setColorAt(i, tmpColor.set(color))
  debrisMesh.instanceColor!.needsUpdate = true
  if (i >= debrisMesh.count) debrisMesh.count = i + 1
  return true
}

// Put a caller-owned mesh (the popped head) on a physics body. The mesh is
// driven until life runs out or it leaves the world, then handed back.
export function attachPhysicsBody(
  mesh: THREE.Object3D,
  size: number,
  vel: THREE.Vector3,
  life: number,
  onDone: (mesh: THREE.Object3D) => void,
): boolean {
  if (!R || !world) return false
  const body = world.createRigidBody(
    R.RigidBodyDesc.dynamic()
      .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
      .setLinvel(vel.x, vel.y, vel.z)
      .setAngvel({
        x: (Math.random() - 0.5) * 10,
        y: (Math.random() - 0.5) * 10,
        z: (Math.random() - 0.5) * 10,
      })
      .setCcdEnabled(true),
  )
  world.createCollider(
    R.ColliderDesc.cuboid(size / 2, size / 2, size / 2).setRestitution(0.4).setFriction(0.7),
    body,
  )
  attached.push({ mesh, body, life, onDone })
  return true
}

export function stepPhysics(dt: number): void {
  if (!R || !world || !debrisMesh) return

  // Terrain changed (a crater landed): queue the zones it touched for a
  // resample, and rebuild one per frame so a burst of craters never stalls a
  // frame. Zones the crater never overlapped keep their field as-is.
  if (terrainVersion() !== seenTerrainV) {
    seenTerrainV = terrainVersion()
    for (const zone of zones) {
      if (dirtyZones.includes(zone)) continue
      const half = zone.span / 2
      for (const c of pendingCraters) {
        if (
          Math.abs(c.x - zone.cx) <= half + c.r &&
          Math.abs(c.z - zone.cz) <= half + c.r
        ) {
          dirtyZones.push(zone)
          break
        }
      }
    }
    pendingCraters.length = 0
  }
  const dirty = dirtyZones.shift()
  if (dirty) {
    buildZone(dirty)
    if (dirtyZones.length === 0) wakeAll()
  }
  if (blocksVersion() !== seenBlocksV) {
    seenBlocksV = blocksVersion()
    syncBlocks()
    wakeAll()
  }

  acc = Math.min(acc + dt, 0.15)
  while (acc >= STEP) {
    world.step()
    acc -= STEP
  }

  for (let i = 0; i < MAX_DEBRIS; i++) {
    const d = slots[i]
    if (!d) continue
    d.life -= dt
    const t = d.body.translation()
    if (d.life <= 0 || t.y < KILL_Y) {
      freeSlot(i)
      continue
    }
    const r = d.body.rotation()
    // Shrink away over the last third of a second instead of blinking out.
    const s = d.size * Math.min(1, d.life / 0.35)
    tmpMat.compose(
      tmpPos.set(t.x, t.y, t.z),
      tmpQuat.set(r.x, r.y, r.z, r.w),
      tmpScale.setScalar(s),
    )
    debrisMesh.setMatrixAt(i, tmpMat)
    instDirty = true
  }
  if (instDirty) {
    debrisMesh.instanceMatrix.needsUpdate = true
    instDirty = false
  }

  for (let i = attached.length - 1; i >= 0; i--) {
    const a = attached[i]
    a.life -= dt
    const t = a.body.translation()
    if (a.life <= 0 || t.y < KILL_Y) {
      world.removeRigidBody(a.body)
      attached.splice(i, 1)
      a.onDone(a.mesh)
      continue
    }
    const r = a.body.rotation()
    a.mesh.position.set(t.x, t.y, t.z)
    a.mesh.quaternion.set(r.x, r.y, r.z, r.w)
  }
}
