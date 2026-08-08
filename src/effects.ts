import * as THREE from 'three'
import { heightAt, propInPath } from './world'

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

export class Effects {
  onBlast: (center: THREE.Vector3) => void = () => {}
  // Fires only for the local player's own rockets. Craters hang off this so
  // exactly one client (the shooter) mints the world damage — per-client sim
  // divergence must never fork the terrain.
  onOwnExplosion: (center: THREE.Vector3) => void = () => {}
  private rockets: Rocket[] = []
  private puffs: Puff[] = []
  private explosions: Explosion[] = []
  private splashRings: SplashRing[] = []
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

  spawnHeadPop(pos: THREE.Vector3): void {
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.6, 0.6),
      new THREE.MeshLambertMaterial({ color: 0xe0b088 }),
    )
    head.position.copy(pos)
    this.scene.add(head)
    this.puffs.push({
      mesh: head,
      t: 0,
      lifetime: 2.4,
      vel: new THREE.Vector3((Math.random() - 0.5) * 5, 7 + Math.random() * 2, (Math.random() - 0.5) * 5),
      spin: new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4),
      bounce: true,
    })
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
      if (hitGround || hitPlayer || propInPath(p) || r.life <= 0) {
        this.explode(p.clone(), r.ownerId)
        this.scene.remove(r.mesh)
        this.rockets.splice(i, 1)
      }
    }

    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i]
      e.t += dt / EXPLOSION_TIME
      if (e.t >= 1) {
        this.scene.remove(e.mesh)
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
        this.scene.remove(r.mesh)
        this.splashRings.splice(i, 1)
        continue
      }
      r.mesh.scale.setScalar(1 + 3.2 * r.t)
      const mat = r.mesh.material as THREE.MeshLambertMaterial
      mat.opacity = 0.85 * (1 - r.t)
    }

    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const s = this.puffs[i]
      s.t += dt
      if (s.t >= s.lifetime) {
        this.scene.remove(s.mesh)
        this.puffs.splice(i, 1)
        continue
      }
      s.vel.y -= (s.bounce ? 20 : 2) * dt
      s.mesh.position.addScaledVector(s.vel, dt)
      s.mesh.rotation.x += s.spin.x * dt
      s.mesh.rotation.y += s.spin.y * dt
      s.mesh.rotation.z += s.spin.z * dt
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

  private explode(center: THREE.Vector3, ownerId: string): void {
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
    this.burst(center, 0x333338, 10, 9)
    this.onBlast(center)
    if (ownerId === 'me') this.onOwnExplosion(center)
  }

  // A handful of flying cubes: debris, blood, whatever the occasion calls for.
  private burst(center: THREE.Vector3, color: number, count: number, power: number): void {
    for (let i = 0; i < count; i++) {
      const cube = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.14, 0.14),
        new THREE.MeshLambertMaterial({ color, flatShading: true }),
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
