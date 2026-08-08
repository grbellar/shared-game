import * as THREE from 'three'
import { heightAt, propInPath } from './world'
import { spawnPhysicsDebris, attachPhysicsBody } from './physics'

// Transient physical stuff: rockets, explosions, smoke, popped heads, debris.
// Every client simulates the same fire events, so everyone sees the same show;
// knockback is applied per-client via onBlast (each client shoves only itself).

export interface Target {
  id: string
  pos: THREE.Vector3
}

const ROCKET_SPEED = 26
const ROCKET_LIFE = 3
const EXPLOSION_TIME = 0.4

interface Rocket {
  mesh: THREE.Group
  vel: THREE.Vector3
  ownerId: string
  life: number
  smokeT: number
}

interface Puff {
  mesh: THREE.Mesh
  t: number
  lifetime: number
  vel: THREE.Vector3
  spin: THREE.Vector3
  bounce: boolean
  // Swell over the puff's life, as a multiple of its starting size. Dust
  // billows; debris and smoke keep the size they were born at.
  grow?: number
}

interface Explosion {
  mesh: THREE.Mesh
  t: number
}

const SPLASH_RING_TIME = 0.7

interface SplashRing {
  mesh: THREE.Mesh
  t: number
}

// Neon splatter for the `paintball` chat cheat.
const PAINT = [0xff2fa8, 0x2fe0ff, 0xa8ff2f, 0xffe22f, 0xb02fff, 0xff6a2f]

// A bullet tracer or muzzle flash: something bright that fades out fast.
interface Beam {
  mesh: THREE.Mesh
  t: number
  life: number
  grow: number
}

// Take a mesh out of the scene AND free what it holds on the GPU. Every
// transient here mints its own geometry and material, so dropping the scene
// reference alone leaks both — invisible until something spawns them fast
// (the fifty, at fourteen rounds a second), at which point it degrades until
// the frame gives out.
function discard(scene: THREE.Scene, mesh: THREE.Mesh): void {
  scene.remove(mesh)
  mesh.geometry.dispose()
  const mat = mesh.material
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
  else mat.dispose()
}

export class Effects {
  // Toggled by cheats.ts: every burst and fireball goes highlighter-coloured.
  paintball = false
  onBlast: (center: THREE.Vector3) => void = () => {}
  // Fires only for the local player's own rockets. Craters hang off this so
  // exactly one client (the shooter) mints the world damage — per-client sim
  // divergence must never fork the terrain.
  onOwnExplosion: (center: THREE.Vector3) => void = () => {}
  // Extra rocket-stopping solids beyond terrain and props (built blocks).
  // A callback so effects stays ignorant of the blocks module; main.ts wires it.
  solidAt: (p: THREE.Vector3) => boolean = () => false
  private rockets: Rocket[] = []
  private puffs: Puff[] = []
  private explosions: Explosion[] = []
  private splashRings: SplashRing[] = []
  private beams: Beam[] = []
  private tmp = new THREE.Vector3()

  constructor(private scene: THREE.Scene) {}

  spawnRocket(ownerId: string, origin: THREE.Vector3, dir: THREE.Vector3): void {
    const mesh = new THREE.Group()
    const olive = new THREE.MeshLambertMaterial({ color: 0x55603a, flatShading: true })
    const red = new THREE.MeshLambertMaterial({ color: 0xc23b3b, flatShading: true })
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.5, 6).rotateX(Math.PI / 2), olive)
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.26, 6).rotateX(Math.PI / 2), red)
    nose.position.z = 0.38
    mesh.add(body, nose)
    mesh.position.copy(origin)
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize())
    this.scene.add(mesh)
    this.rockets.push({
      mesh,
      vel: dir.clone().normalize().multiplyScalar(ROCKET_SPEED),
      ownerId,
      life: ROCKET_LIFE,
      smokeT: 0,
    })
  }

  // Someone hit the water: foam droplets flying up plus a ring spreading on
  // the surface. Purely cosmetic, so each client spawns its own.
  spawnSplash(x: number, z: number): void {
    const surface = new THREE.Vector3(x, 0.15, z)
    this.burst(surface, 0xffffff, 6, 5)
    this.burst(surface, 0xa8d4ef, 8, 6)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.75, 12).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({
        color: 0xdff2ff,
        emissive: 0x86aec7,
        transparent: true,
        opacity: 0.85,
      }),
    )
    ring.position.set(x, 0.03, z)
    this.scene.add(ring)
    this.splashRings.push({ mesh: ring, t: 0 })
  }

  // Hitscan tracer: a long thin glowing box laid down the bullet's path.
  // Gone in a blink, so at 320x240 it reads as a streak of light.
  spawnTracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const len = from.distanceTo(to)
    if (len < 0.2) return
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.07, len),
      new THREE.MeshLambertMaterial({
        color: 0x8a6a20,
        emissive: 0xffd070,
        flatShading: true,
        transparent: true,
      }),
    )
    mesh.position.copy(from).add(to).multiplyScalar(0.5)
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      this.tmp.copy(to).sub(from).normalize(),
    )
    this.scene.add(mesh)
    this.beams.push({ mesh, t: 0, life: 0.13, grow: 0 })
  }

  // Fat spark at the muzzle for a couple of frames.
  spawnMuzzleFlash(pos: THREE.Vector3): void {
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.28, 0),
      new THREE.MeshLambertMaterial({
        color: 0x8a6000,
        emissive: 0xffc040,
        flatShading: true,
        transparent: true,
      }),
    )
    mesh.position.copy(pos)
    this.scene.add(mesh)
    this.beams.push({ mesh, t: 0, life: 0.09, grow: 1.6 })
  }

  spawnHeadPop(pos: THREE.Vector3): void {
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.6, 0.6),
      new THREE.MeshLambertMaterial({ color: 0xe0b088 }),
    )
    head.position.copy(pos)
    this.scene.add(head)
    const vel = new THREE.Vector3((Math.random() - 0.5) * 5, 7 + Math.random() * 2, (Math.random() - 0.5) * 5)
    // A real rigid body when the engine is up — the head tumbles downhill
    // and rolls to rest; the old fake bounce when it isn't.
    if (!attachPhysicsBody(head, 0.6, vel, 4, (m) => discard(this.scene, m as THREE.Mesh))) {
      this.puffs.push({
        mesh: head,
        t: 0,
        lifetime: 2.4,
        vel,
        spin: new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4),
        bounce: true,
      })
    }
    this.burst(pos, 0xb02020, 9, 5)
  }

  update(dt: number, targets: Target[]): void {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i]
      r.life -= dt
      r.mesh.position.addScaledVector(r.vel, dt)
      r.smokeT -= dt
      if (r.smokeT <= 0) {
        r.smokeT = 0.07
        this.smoke(r.mesh.position)
      }
      const p = r.mesh.position
      const hitGround = p.y <= Math.max(heightAt(p.x, p.z), 0) + 0.15
      // Compare against chest height, since target positions are at the feet.
      const hitPlayer = targets.some(
        (t) => t.id !== r.ownerId && this.tmp.set(t.pos.x, t.pos.y + 1.2, t.pos.z).distanceTo(p) < 1.5,
      )
      if (hitGround || hitPlayer || propInPath(p) || this.solidAt(p) || r.life <= 0) {
        this.explode(p.clone(), r.ownerId)
        this.scene.remove(r.mesh)
        this.rockets.splice(i, 1)
      }
    }

    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i]
      e.t += dt / EXPLOSION_TIME
      if (e.t >= 1) {
        discard(this.scene, e.mesh)
        this.explosions.splice(i, 1)
        continue
      }
      e.mesh.scale.setScalar(0.6 + 8 * e.t)
      const mat = e.mesh.material as THREE.MeshLambertMaterial
      mat.opacity = 0.95 * (1 - e.t)
    }

    for (let i = this.splashRings.length - 1; i >= 0; i--) {
      const r = this.splashRings[i]
      r.t += dt / SPLASH_RING_TIME
      if (r.t >= 1) {
        discard(this.scene, r.mesh)
        this.splashRings.splice(i, 1)
        continue
      }
      r.mesh.scale.setScalar(1 + 3.2 * r.t)
      const mat = r.mesh.material as THREE.MeshLambertMaterial
      mat.opacity = 0.85 * (1 - r.t)
    }

    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i]
      b.t += dt / b.life
      if (b.t >= 1) {
        discard(this.scene, b.mesh)
        this.beams.splice(i, 1)
        continue
      }
      const mat = b.mesh.material as THREE.MeshLambertMaterial
      mat.opacity = 1 - b.t
      if (b.grow) b.mesh.scale.setScalar(1 + b.grow * b.t)
    }

    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const s = this.puffs[i]
      s.t += dt
      if (s.t >= s.lifetime) {
        discard(this.scene, s.mesh)
        this.puffs.splice(i, 1)
        continue
      }
      s.vel.y -= (s.bounce ? 20 : 2) * dt
      s.mesh.position.addScaledVector(s.vel, dt)
      s.mesh.rotation.x += s.spin.x * dt
      s.mesh.rotation.y += s.spin.y * dt
      s.mesh.rotation.z += s.spin.z * dt
      if (s.grow) {
        s.mesh.scale.setScalar(1 + s.grow * (s.t / s.lifetime))
        // Dust punches outward and stalls in a ring, instead of sailing off
        // across the water at its launch speed.
        const drag = Math.pow(0.08, dt)
        s.vel.x *= drag
        s.vel.z *= drag
      }
      if (s.bounce) {
        const floor = Math.max(heightAt(s.mesh.position.x, s.mesh.position.z), 0) + 0.3
        if (s.mesh.position.y < floor && s.vel.y < 0) {
          s.mesh.position.y = floor
          s.vel.y *= -0.45
          s.vel.x *= 0.7
          s.vel.z *= 0.7
        }
      }
      const mat = s.mesh.material as THREE.MeshLambertMaterial
      if (mat.transparent) mat.opacity = Math.min(0.8, 1.5 * (1 - s.t / s.lifetime))
    }
  }

  // Chunks of whatever just got destroyed, flying everywhere.
  spawnDebris(center: THREE.Vector3, color: number, count: number, power: number): void {
    this.burst(center, color, count, power)
  }

  // A single smoke puff — the exhaust trail behind someone under rocket power
  // (rocket.ts for the local player, remotes for everyone else).
  spawnTrail(pos: THREE.Vector3): void {
    this.smoke(pos)
  }

  // Rocket travel touching down (rocket.ts). Deliberately NOT `explode`: it
  // fires no onBlast, because the traveller walks away from their own landing
  // and everybody else shoves themselves in main.ts — the same self-applied
  // rule blast knockback has always followed.
  spawnImpact(center: THREE.Vector3): void {
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshLambertMaterial({
        color: 0x662200,
        emissive: 0xff7a1a,
        flatShading: true,
        transparent: true,
      }),
    )
    mesh.position.copy(center)
    this.scene.add(mesh)
    this.explosions.push({ mesh, t: 0 })
    this.burst(center, 0x6b4526, 14, 11) // dirt
    this.burst(center, 0x333338, 8, 8) // scorch
    this.dustCloud(center, 16)
  }

  // The billow a landing kicks up: fat pale cubes thrown out along the ground
  // that swell and thin as they go. Much bigger and slower than rocket smoke,
  // because the whole job of this cloud is to hang around long enough that the
  // hero pose reads as a silhouette through it.
  private dustCloud(center: THREE.Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.6
      const speed = 3.5 + Math.random() * 4
      const size = 0.5 + Math.random() * 0.7
      const puff = new THREE.Mesh(
        new THREE.BoxGeometry(size, size, size),
        new THREE.MeshLambertMaterial({
          color: 0xbfae8c,
          transparent: true,
          opacity: 0.75,
          flatShading: true,
        }),
      )
      puff.position.copy(center)
      puff.position.y += 0.25
      this.scene.add(puff)
      this.puffs.push({
        mesh: puff,
        t: 0,
        lifetime: 1.8 + Math.random() * 0.9,
        vel: new THREE.Vector3(Math.sin(a) * speed, 1.2 + Math.random() * 1.6, Math.cos(a) * speed),
        spin: new THREE.Vector3(0.6, 0.9, 0.4),
        bounce: false,
        grow: 1.6,
      })
    }
  }

  private paint(): number {
    return PAINT[Math.floor(Math.random() * PAINT.length)]
  }

  private explode(center: THREE.Vector3, ownerId: string): void {
    const splat = this.paintball ? this.paint() : 0
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshLambertMaterial({
        color: this.paintball ? splat : 0x662200,
        emissive: this.paintball ? splat : 0xff7a1a,
        flatShading: true,
        transparent: true,
      }),
    )
    mesh.position.copy(center)
    this.scene.add(mesh)
    this.explosions.push({ mesh, t: 0 })
    this.burst(center, 0x333338, 10, 9)
    this.onBlast(center)
    if (ownerId === 'me') this.onOwnExplosion(center)
  }

  // A handful of flying cubes: debris, blood, whatever the occasion calls
  // for. Real rigid bodies when the physics engine is up (they tumble,
  // stack and roll downhill); the old hand-animated puffs as the fallback
  // while the WASM is still loading.
  private burst(center: THREE.Vector3, color: number, count: number, power: number): void {
    for (let i = 0; i < count; i++) {
      const c = this.paintball ? this.paint() : color
      if (spawnPhysicsDebris(center, c, power)) continue
      const cube = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.14, 0.14),
        new THREE.MeshLambertMaterial({ color: c, flatShading: true }),
      )
      cube.position.copy(center)
      this.scene.add(cube)
      this.puffs.push({
        mesh: cube,
        t: 0,
        lifetime: 0.9,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * power,
          Math.random() * power * 0.8,
          (Math.random() - 0.5) * power,
        ),
        spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, Math.random() * 10),
        bounce: true,
      })
    }
  }

  private smoke(pos: THREE.Vector3): void {
    const puff = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.16, 0.16),
      new THREE.MeshLambertMaterial({ color: 0x9a9aa2, transparent: true, opacity: 0.8 }),
    )
    puff.position.copy(pos)
    this.scene.add(puff)
    this.puffs.push({
      mesh: puff,
      t: 0,
      lifetime: 0.7,
      vel: new THREE.Vector3(0, 0.8, 0),
      spin: new THREE.Vector3(2, 2, 0),
      bounce: false,
    })
  }
}
