import * as THREE from 'three'
import { heightAt } from './world'
import { VOXEL } from './voxelbody'
import { COLLECT_TOP, sfx } from './audio'

// Loose voxels on the ground. Everything destroyed in the game ends up here —
// bored out of a body, knocked off a structure, dug out of a hillside — and
// everything anyone eats comes from here. One economy, no transfer accounting.
//
// Spawning is DERIVED. The events that create pickups (`bhit`, `bore`,
// `crater`, `kill`) are already on the wire, so every client spawns the same
// pickups from them with no extra message. Only the claim is synced, keyed by
// where the pickup came from rather than by a counter — two clients that saw
// events in a different order still agree that `b:a41f9c2e:412` is one
// particular voxel out of one particular body.
//
// Collection is one voxel at a time, Sonic's rings rather than a vacuum: each
// one bursts out on its own arc, bounces, has to be walked over, and pays out
// with its own note up a climbing scale. The batching that used to swallow a
// whole pile in a single silent frame is gone — a spill is something you go
// and gather, which is the entire reason losing mass stings.

const LIFETIME = 45 // seconds before an uncollected voxel is gone for good
const BLINK = 6 // final seconds, spent flickering out like a dying ring
const CAP = 600 // live pickups; oldest evicted past this
const BASE_REACH = 1.6 // collection radius at base size, scaled by the eater
const GRAVITY = 30
const BOUNCE = 0.42 // how much of the impact speed comes back off the ground
const REST_V = 1.4 // slower than this on landing and it stops bouncing
const ARM = 0.5 // seconds before a fresh voxel can be eaten
const EVERY = 0.06 // seconds between collections — the ding-ding-ding rate
// Collecting is deliberately faster than it's worth hearing. Walking a big
// pile at seventeen notes a second is a smoke alarm, so the ladder only
// advances on the notes that actually sound; the rest are silent. It climbs to
// the top, RESTS, and starts over from the bottom — a repeating phrase. Never
// parking on the top note is the whole point: a chain that only reset when you
// stopped finding things never reset at all on a big pile, because on a big
// pile you never stop finding things.
const NOTE_EVERY = 0.56
// Silence at the top of the ladder before the next run. A multiple of the note
// gap rather than a number of its own, so widening the gap can never leave the
// "rest" shorter than an ordinary step and speed the phrase up at the wrap.
const CHAIN_REST = NOTE_EVERY * 2
const CHAIN_LAPSE = 0.85 // found nothing for this long and the phrase restarts
const TAKE = 0.22 // seconds a collected voxel spends flying into the eater

interface Pickup {
  key: string
  x: number
  y: number
  z: number
  size: number
  vx: number
  vy: number
  vz: number
  rest: boolean
  arm: number
  age: number
  // Progress of the flight into the eater, 0..1; -1 until collected.
  taken: number
  inst: number
}

export class Pickups {
  // Claims made but not yet flushed. Batched because sprinting through a
  // collapsed colossus would otherwise be three hundred messages.
  private pending: string[] = []
  private live = new Map<string, Pickup>()
  private claimed = new Set<string>()
  private mesh: THREE.InstancedMesh
  private free: number[] = []
  private used = 0
  private dummy = new THREE.Object3D()
  private cool = 0
  private noteCool = 0
  private chain = 0
  private chainIdle = 0

  // main.ts feeds these to Mass.eat and flushes the claim over the wire.
  onCollect: (keys: string[]) => void = () => {}

  constructor(scene: THREE.Scene) {
    // A unit cube, sized per instance: block rubble comes off the world three
    // voxels at a time and shouldn't render the same as a fleck of flesh.
    const geo = new THREE.BoxGeometry(1, 1, 1)
    // Colour rides instanceColor via setColorAt — NOT the vertexColors flag,
    // which reads a per-vertex attribute this box doesn't have and multiplies
    // every cube to black.
    const mat = new THREE.MeshLambertMaterial({ flatShading: true })
    this.mesh = new THREE.InstancedMesh(geo, mat, CAP)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3)
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    scene.add(this.mesh)
  }

  // `key` must be derived from where the voxel came from, never a counter —
  // see the header. It also seeds the burst, so the same voxel tumbles out to
  // the same spot on every screen without anybody sending a position.
  spawn(key: string, x: number, y: number, z: number, color: number, size = VOXEL * 0.7): void {
    if (this.live.has(key) || this.claimed.has(key)) return
    if (this.live.size >= CAP) this.evictOldest()
    const inst = this.free.pop() ?? this.used++
    const b = burst(key)
    const p: Pickup = {
      key,
      x,
      y,
      z,
      size,
      vx: b.vx,
      vy: b.vy,
      vz: b.vz,
      rest: false,
      arm: ARM,
      age: 0,
      taken: -1,
      inst,
    }
    this.live.set(key, p)
    this.mesh.count = Math.max(this.mesh.count, this.used)
    this.mesh.setColorAt(inst, tmpColor.setHex(color))
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    this.write(p)
  }

  // Somebody else got there first. Never resurrects: a claimed key stays
  // claimed, so a late-arriving spawn for it is a no-op.
  claimRemote(keys: string[]): void {
    for (const key of keys) {
      this.claimed.add(key)
      const p = this.live.get(key)
      if (p) this.retire(p)
    }
  }

  // The thing a key named exists again — a block rebuilt in an eaten cell, a
  // healed wound that can be bored a second time. Without this, a key is one
  // voxel per SESSION rather than per event, and the second break of any
  // rebuilt cell spills nothing.
  unclaim(key: string): void {
    this.claimed.delete(key)
  }

  // A whole body's worth at once: respawns reset every `b:<id>:` key.
  unclaimPrefix(prefix: string): void {
    for (const key of this.claimed) {
      if (key.startsWith(prefix)) this.claimed.delete(key)
    }
  }

  // Walk over them to eat them, one at a time. Reach scales with the eater, so
  // a colossus gathers a wide swathe and a base player has to be precise — but
  // even a colossus takes them in sequence, nearest first, because a pile
  // vanishing in one frame is the thing that never felt like picking anything
  // up.
  update(dt: number, eater: THREE.Vector3, scale: number): void {
    const reach = BASE_REACH * scale
    this.cool -= dt
    this.noteCool -= dt
    this.chainIdle += dt
    if (this.chainIdle > CHAIN_LAPSE) this.chain = 0
    let best: Pickup | null = null
    let bestD = reach * reach
    // Map iteration tolerates deleting the current entry, so no copy needed.
    for (const p of this.live.values()) {
      p.age += dt
      if (p.taken >= 0) {
        p.taken += dt / TAKE
        if (p.taken >= 1) this.retire(p)
        else this.writeTaken(p, eater, scale)
        continue
      }
      if (p.age > LIFETIME) {
        this.retire(p)
        continue
      }
      if (p.arm > 0) p.arm -= dt
      if (!p.rest) this.fall(p, dt)
      // The spin and bob are what separate "food you can eat" from the
      // cosmetic debris that tumbles once and fades.
      this.write(p)
      if (p.arm > 0) continue
      const dx = p.x - eater.x
      const dz = p.z - eater.z
      const dy = p.y - eater.y
      const d = dx * dx + dz * dz + dy * dy * 0.25
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    if (best && this.cool <= 0) {
      this.cool = EVERY
      this.chainIdle = 0
      best.taken = 0
      this.claimed.add(best.key)
      this.pending.push(best.key)
      if (this.noteCool <= 0) {
        sfx.collect(this.chain++)
        const topped = this.chain >= COLLECT_TOP
        if (topped) this.chain = 0
        this.noteCool = topped ? CHAIN_REST : NOTE_EVERY
      }
      this.onCollect([best.key])
    }
  }

  // Everything collected since the last call, for one batched message.
  drainClaims(): string[] {
    if (!this.pending.length) return []
    const out = this.pending
    this.pending = []
    return out
  }

  clear(): void {
    for (const p of this.live.values()) this.retire(p)
    this.claimed.clear()
  }

  // Ages march in lockstep, so spawn order IS age order and the Map's first
  // entry is always the oldest.
  private evictOldest(): void {
    const oldest = this.live.values().next().value
    if (oldest) this.retire(oldest)
  }

  // The burst out and the landing. Ground is re-sampled while it's moving and
  // then forgotten — a settled voxel doesn't pay for a terrain lookup a frame
  // for the next forty-five seconds.
  private fall(p: Pickup, dt: number): void {
    p.vy -= GRAVITY * dt
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.z += p.vz * dt
    const floor = heightAt(p.x, p.z) + p.size * 0.5
    if (p.y > floor) return
    p.y = floor
    if (-p.vy > REST_V) {
      p.vy = -p.vy * BOUNCE
      p.vx *= 0.6
      p.vz *= 0.6
      return
    }
    p.rest = true
    p.vx = 0
    p.vy = 0
    p.vz = 0
  }

  private retire(p: Pickup): void {
    this.live.delete(p.key)
    this.free.push(p.inst)
    this.dummy.position.set(0, -9999, 0)
    this.dummy.scale.setScalar(0)
    this.dummy.updateMatrix()
    this.mesh.setMatrixAt(p.inst, this.dummy.matrix)
    this.mesh.instanceMatrix.needsUpdate = true
  }

  private write(p: Pickup): void {
    const bob = p.rest ? Math.abs(Math.sin(p.age * 2.6)) * 0.14 : 0
    this.dummy.position.set(p.x, p.y + bob, p.z)
    // Hard on/off flicker for the last few seconds, so a voxel about to expire
    // reads as one worth running for.
    const doomed = p.age > LIFETIME - BLINK && Math.floor(p.age * 8) % 2 === 0
    this.dummy.scale.setScalar(doomed ? 0 : p.size)
    this.dummy.rotation.set(p.rest ? 0 : p.age * 4.5, p.age * 2.2, 0)
    this.dummy.updateMatrix()
    this.mesh.setMatrixAt(p.inst, this.dummy.matrix)
    this.mesh.instanceMatrix.needsUpdate = true
  }

  // The payoff frame: it leaps off the ground into the eater's chest and pops.
  // Retiring it outright is what made a hundred voxels disappear like a bug.
  private writeTaken(p: Pickup, eater: THREE.Vector3, scale: number): void {
    const t = p.taken * p.taken
    this.dummy.position.set(
      p.x + (eater.x - p.x) * t,
      p.y + (eater.y + 0.7 * scale - p.y) * t,
      p.z + (eater.z - p.z) * t,
    )
    this.dummy.scale.setScalar(p.size * (1 - p.taken) * (1 + p.taken * 0.9))
    this.dummy.rotation.set(p.taken * 7, p.taken * 10, 0)
    this.dummy.updateMatrix()
    this.mesh.setMatrixAt(p.inst, this.dummy.matrix)
    this.mesh.instanceMatrix.needsUpdate = true
  }
}

// Which way a voxel flies, hashed off its key. Deterministic on purpose: the
// key is the one thing every client already agrees on, so seeding the burst
// with it keeps the same rubble in the same place on every screen for free.
function burst(key: string): { vx: number; vy: number; vz: number } {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  }
  const a = (((h >>> 7) & 1023) / 1024) * Math.PI * 2
  const speed = 1.7 + (((h >>> 17) & 255) / 256) * 2.6
  return {
    vx: Math.cos(a) * speed,
    vy: 3.6 + (((h >>> 25) & 63) / 64) * 3.4,
    vz: Math.sin(a) * speed,
  }
}

const tmpColor = new THREE.Color()
