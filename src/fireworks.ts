import * as THREE from 'three'
import { disposeSubtree } from './character'
import { heightAt } from './world'

// Plantable fireworks: jam a tube into the dirt, watch the fuse sizzle, then
// it whistles into the sky and opens into a shell burst. Purely cosmetic —
// no knockback, no craters — which is why it's allowed to be this loud.
//
// Sync model: planting and lighting are both relayed (net.ts 'fw' / 'fwgo').
// The ascent is deterministic — fixed rise time, and the lean comes from a
// hash of the plant spot — so every client sees the shell open in the same
// patch of sky. Only the spark scatter is locally random; nobody can tell.

export interface Shell {
  core: number
  accent: number
}

// Shell palettes, indexed by the `c` field in the 'fw' message.
export const SHELLS: Shell[] = [
  { core: 0xff3b3b, accent: 0xffd23b }, // red / gold
  { core: 0x4f9cff, accent: 0xffffff }, // blue / white
  { core: 0x4dff8a, accent: 0xfff36b }, // green / lemon
  { core: 0xff6bd0, accent: 0xa87bff }, // pink / violet
  { core: 0xffc93b, accent: 0xff7a2a }, // gold / orange
  { core: 0x6be8ff, accent: 0xffffff }, // cyan / white
]

const FUSE_TIME = 5 // burns down on its own if nobody lights it
const LIT_FUSE = 0.18 // "launch now" still gives you a beat of sizzle
const RISE_TIME = 1.6 // fixed so every client bursts at the same height
const RISE_SPEED = 27
const RISE_GRAVITY = 13
const FLASH_TIME = 0.35
const MAX_PER_OWNER = 16
// Three size classes, because points are sized in world units and these are
// viewed from wildly different distances: fuse sizzle at arm's length, the
// exhaust trail from 5-40m, shell stars from 25m+. One shared size would
// either fill the screen up close or vanish sub-pixel far away.
const FUSE_CAPACITY = 400
const FUSE_SIZE = 0.26
const TRAIL_CAPACITY = 900
const TRAIL_SIZE = 0.5
const STAR_CAPACITY = 2200
const STAR_SIZE = 1.0

const GOLD = new THREE.Color(0xffb648)
const WHITE = new THREE.Color(0xfff4d0)

// One geometry for every burst flash. The material can't be shared — each
// flash tints its emissive to the shell and fades its own opacity — so it's
// disposed when the flash dies instead.
const FLASH_GEO = new THREE.IcosahedronGeometry(1, 0)

// Sparks live in one Points cloud per size class — one draw call each for the
// whole show. Alpha is per-particle, which works because a 4-component color
// attribute switches three's shader to vec4 vertex colors.
//
// Deliberately NOT additive: the sky here is bright daylight blue, and
// additive sparks over it clip straight to white, so every shell would come
// out the same colour. Plain alpha keeps the reds red.
class SparkPool {
  readonly points: THREE.Points
  private pos: Float32Array
  private col: Float32Array // rgba
  private vel: Float32Array
  private life: Float32Array
  private span: Float32Array
  private drag: Float32Array
  private grav: Float32Array
  private twinkle: Float32Array
  private head = 0
  private alive = 0
  private clock = 0

  constructor(
    private capacity: number,
    size: number,
  ) {
    this.pos = new Float32Array(capacity * 3)
    this.col = new Float32Array(capacity * 4)
    this.vel = new Float32Array(capacity * 3)
    this.life = new Float32Array(capacity)
    this.span = new Float32Array(capacity)
    this.drag = new Float32Array(capacity)
    this.grav = new Float32Array(capacity)
    this.twinkle = new Float32Array(capacity)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4))
    // Square, unfiltered, no texture: chunky pixels for free. Fog is off so
    // a shell fired across the island still reads as sharp bright dots.
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        fog: false,
      }),
    )
    this.points.frustumCulled = false
  }

  emit(
    p: THREE.Vector3,
    v: THREE.Vector3,
    color: THREE.Color,
    life: number,
    gravity: number,
    drag: number,
    twinkle = false,
  ): void {
    const i = this.head
    this.head = (this.head + 1) % this.capacity
    if (this.life[i] > 0) this.alive-- // recycled a live one; don't double-count
    const j = i * 3
    const c = i * 4
    this.pos[j] = p.x
    this.pos[j + 1] = p.y
    this.pos[j + 2] = p.z
    this.vel[j] = v.x
    this.vel[j + 1] = v.y
    this.vel[j + 2] = v.z
    this.col[c] = color.r
    this.col[c + 1] = color.g
    this.col[c + 2] = color.b
    this.col[c + 3] = 1
    this.life[i] = life
    this.span[i] = life
    this.grav[i] = gravity
    this.drag[i] = drag
    this.twinkle[i] = twinkle ? 1 : 0
    this.alive++
  }

  update(dt: number): void {
    if (this.alive === 0) return
    this.clock += dt
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue
      const j = i * 3
      const c = i * 4
      this.life[i] -= dt
      if (this.life[i] <= 0) {
        this.col[c + 3] = 0
        this.alive--
        continue
      }
      const decay = Math.pow(0.5, dt * this.drag[i])
      this.vel[j] *= decay
      this.vel[j + 1] = this.vel[j + 1] * decay - this.grav[i] * dt
      this.vel[j + 2] *= decay
      this.pos[j] += this.vel[j] * dt
      this.pos[j + 1] += this.vel[j + 1] * dt
      this.pos[j + 2] += this.vel[j + 2] * dt
      // Hold full brightness for most of the life, then fall off a cliff.
      let a = Math.min(1, (this.life[i] / this.span[i]) * 2.2)
      if (this.twinkle[i]) a *= 0.25 + 0.75 * Math.abs(Math.sin(this.clock * 24 + i))
      this.col[c + 3] = a
    }
    this.points.geometry.attributes.position.needsUpdate = true
    this.points.geometry.attributes.color.needsUpdate = true
  }
}

interface Live {
  ownerId: string
  mesh: THREE.Group
  shell: Shell
  fuse: number // seconds of fuse left; <= 0 once lit
  flight: number // -1 while planted, else seconds since liftoff
  base: THREE.Vector3
  drift: THREE.Vector3
  emitT: number
}

interface Flash {
  mesh: THREE.Mesh
  t: number
}

// Deterministic 0..1 from the plant spot, so the lean of a rocket is the
// same on every client without spending bytes on it.
function hash01(x: number, z: number, salt: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453
  return s - Math.floor(s)
}

export class Fireworks {
  // Fired on this client when a rocket leaves the ground / opens in the sky.
  // main.ts hangs distance-attenuated audio off these.
  onLaunch: (pos: THREE.Vector3) => void = () => {}
  onBurst: (pos: THREE.Vector3) => void = () => {}
  private live: Live[] = []
  private flashes: Flash[] = []
  private fuseSparks = new SparkPool(FUSE_CAPACITY, FUSE_SIZE)
  private trail = new SparkPool(TRAIL_CAPACITY, TRAIL_SIZE)
  private stars = new SparkPool(STAR_CAPACITY, STAR_SIZE)
  private tmp = new THREE.Vector3()
  private tmpV = new THREE.Vector3()
  private tmpC = new THREE.Color()

  constructor(private scene: THREE.Scene) {
    scene.add(this.fuseSparks.points, this.trail.points, this.stars.points)
  }

  // Does this owner have anything planted? main.ts uses it to decide whether
  // pressing the launch key is worth a network message.
  hasPlanted(ownerId: string): boolean {
    return this.live.some((f) => f.ownerId === ownerId && f.flight < 0)
  }

  // Stand a fresh tube in the dirt at (x, z). The ground height is resolved
  // per-client so a firework planted in a crater sits in the crater.
  plant(ownerId: string, x: number, z: number, shellIdx: number): void {
    const shell = SHELLS[shellIdx] ?? SHELLS[0]
    const mine = this.live.filter((f) => f.ownerId === ownerId)
    if (mine.length >= MAX_PER_OWNER) this.remove(mine[0])
    const y = Math.max(heightAt(x, z), 0)
    const mesh = buildTube(shell)
    mesh.position.set(x, y, z)
    mesh.rotation.y = hash01(x, z, shellIdx) * Math.PI * 2
    this.scene.add(mesh)
    const lean = hash01(x, z, shellIdx + 9) * Math.PI * 2
    this.live.push({
      ownerId,
      mesh,
      shell,
      fuse: FUSE_TIME,
      flight: -1,
      base: new THREE.Vector3(x, y, z),
      drift: new THREE.Vector3(Math.sin(lean) * 1.6, 0, Math.cos(lean) * 1.6),
      emitT: 0,
    })
  }

  // Light every tube this owner has planted. Relayed, so a whole battery goes
  // up in sync for everybody watching.
  launchAll(ownerId: string): void {
    for (const f of this.live) {
      if (f.ownerId === ownerId && f.flight < 0) f.fuse = Math.min(f.fuse, LIT_FUSE)
    }
  }

  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const f = this.live[i]
      if (f.flight < 0) {
        f.fuse -= dt
        // Sizzle at the fuse tip, and shiver a little more as it burns down.
        f.emitT -= dt
        if (f.emitT <= 0) {
          f.emitT = 0.055
          f.mesh.localToWorld(this.tmp.set(0.17, 0.55, 0))
          this.tmpV.set((Math.random() - 0.5) * 1.6, 1.2 + Math.random(), (Math.random() - 0.5) * 1.6)
          this.fuseSparks.emit(this.tmp, this.tmpV, GOLD, 0.32, 3, 2.4)
        }
        const shiver = 0.02 * (1 - f.fuse / FUSE_TIME)
        f.mesh.rotation.z = Math.sin(performance.now() * 0.03) * shiver
        if (f.fuse <= 0) {
          f.flight = 0
          this.onLaunch(f.mesh.position.clone())
        }
        continue
      }

      f.flight += dt
      const t = f.flight
      f.mesh.position.set(
        f.base.x + f.drift.x * t,
        f.base.y + RISE_SPEED * t - 0.5 * RISE_GRAVITY * t * t,
        f.base.z + f.drift.z * t,
      )
      f.mesh.rotation.y += dt * 9
      f.mesh.rotation.z = 0
      // Exhaust trail: a couple of sparks a frame, spat downward.
      f.emitT -= dt
      if (f.emitT <= 0) {
        f.emitT = 0.022
        for (let k = 0; k < 2; k++) {
          this.tmp.set(f.mesh.position.x, f.mesh.position.y - 0.35, f.mesh.position.z)
          this.tmpV.set(
            (Math.random() - 0.5) * 2.5,
            -3 - Math.random() * 3,
            (Math.random() - 0.5) * 2.5,
          )
          this.trail.emit(this.tmp, this.tmpV, k ? GOLD : WHITE, 0.5, 2, 1.6)
        }
      }
      if (t >= RISE_TIME) {
        const at = f.mesh.position.clone()
        this.burst(at, f.shell)
        this.onBurst(at)
        this.remove(f)
      }
    }

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const flash = this.flashes[i]
      flash.t += dt / FLASH_TIME
      if (flash.t >= 1) {
        this.scene.remove(flash.mesh)
        ;(flash.mesh.material as THREE.Material).dispose()
        this.flashes.splice(i, 1)
        continue
      }
      flash.mesh.scale.setScalar(0.4 + 7 * flash.t)
      ;(flash.mesh.material as THREE.MeshLambertMaterial).opacity = 0.8 * (1 - flash.t)
    }

    this.fuseSparks.update(dt)
    this.trail.update(dt)
    this.stars.update(dt)
  }

  // The money shot: a flash, a peony of core-colored stars, an accent ring
  // cutting through it, and slow twinkling glitter that hangs behind.
  private burst(at: THREE.Vector3, shell: Shell): void {
    const core = new THREE.Color(shell.core)
    const accent = new THREE.Color(shell.accent)

    const flash = new THREE.Mesh(
      FLASH_GEO,
      new THREE.MeshLambertMaterial({
        color: 0x000000,
        emissive: shell.core,
        flatShading: true,
        transparent: true,
      }),
    )
    flash.position.copy(at)
    this.scene.add(flash)
    this.flashes.push({ mesh: flash, t: 0 })

    // Peony: an even shell of stars, each nudged off the core hue so the
    // ball has some shimmer to it instead of reading as one flat blob.
    for (let i = 0; i < 120; i++) {
      this.randomDir(this.tmpV).multiplyScalar(12 + Math.random() * 3)
      this.tmpC.copy(core).offsetHSL((Math.random() - 0.5) * 0.06, 0, (Math.random() - 0.5) * 0.25)
      this.stars.emit(at, this.tmpV, this.tmpC, 1.6 + Math.random() * 0.7, 5, 2)
    }

    // Ring: stars confined to one random plane, thrown harder so the disc
    // outruns the peony and shows up as a halo.
    const axis = this.randomDir(new THREE.Vector3())
    const u = new THREE.Vector3(-axis.z, 0, axis.x)
    if (u.lengthSq() < 0.01) u.set(1, 0, 0)
    u.normalize()
    const v = new THREE.Vector3().crossVectors(axis, u)
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2 + Math.random() * 0.06
      this.tmpV
        .copy(u)
        .multiplyScalar(Math.cos(a))
        .addScaledVector(v, Math.sin(a))
        .multiplyScalar(17 + Math.random() * 2)
      this.stars.emit(at, this.tmpV, accent, 1.4 + Math.random() * 0.4, 5, 2.2)
    }

    // Glitter: slow, long-lived, flickering. This is the part that makes it
    // feel like a firework rather than an explosion.
    for (let i = 0; i < 36; i++) {
      this.randomDir(this.tmpV).multiplyScalar(3 + Math.random() * 5)
      this.stars.emit(at, this.tmpV, WHITE, 2.2 + Math.random() * 0.9, 2.4, 1, true)
    }

    // Pistil: a tight accent-colored heart inside the shell.
    for (let i = 0; i < 26; i++) {
      this.randomDir(this.tmpV).multiplyScalar(4 + Math.random() * 2)
      this.stars.emit(at, this.tmpV, accent, 1.1 + Math.random() * 0.4, 4, 2.6)
    }
  }

  // Uniform point on the unit sphere (no clustering at the poles).
  private randomDir(out: THREE.Vector3): THREE.Vector3 {
    const y = Math.random() * 2 - 1
    const a = Math.random() * Math.PI * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    return out.set(Math.cos(a) * r, y, Math.sin(a) * r)
  }

  private remove(f: Live): void {
    const i = this.live.indexOf(f)
    if (i >= 0) this.live.splice(i, 1)
    disposeSubtree(f.mesh)
    this.scene.remove(f.mesh)
  }
}

// A stubby paper tube on a stick, standing on the ground (local origin sits
// at the dirt line so the stick disappears into it).
function buildTube(shell: Shell): THREE.Group {
  const group = new THREE.Group()
  const paper = new THREE.MeshLambertMaterial({ color: shell.core, flatShading: true })
  const cap = new THREE.MeshLambertMaterial({ color: shell.accent, flatShading: true })
  const wood = new THREE.MeshLambertMaterial({ color: 0x8a5a2b, flatShading: true })
  const dark = new THREE.MeshLambertMaterial({ color: 0x2a2016, flatShading: true })

  const stick = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.2, 0.06), wood)
  stick.position.y = 0.25
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.7, 6), paper)
  tube.position.y = 0.75
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.185, 0.185, 0.12, 6), cap)
  band.position.y = 0.6
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.34, 6), cap)
  nose.position.y = 1.26
  const fuse = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.05), dark)
  fuse.position.set(0.17, 0.52, 0)
  fuse.rotation.z = -0.5

  group.add(stick, tube, band, nose, fuse)
  return group
}
