import * as THREE from 'three'
import { heightAt, propInPath } from './world'

// Arrow simulation: proper ballistic arcs with gravity, fired from the bow
// (see main.ts). Every client simulates the same `arrow` messages, like
// rockets; hits are cosmetic — arrows embed themselves in terrain, props,
// and players (pincushion, not murder). Each client applies the little
// knockback of an arrow hit to itself only, same trust model as rockets.

export interface StickTarget {
  id: string
  group: THREE.Group
}

const GRAVITY = 18
const MIN_SPEED = 16
const MAX_SPEED = 46
const FLIGHT_LIFE = 6 // seconds before a sky-bound arrow gives up
const STUCK_MS = 25000

interface Flight {
  mesh: THREE.Group
  vel: THREE.Vector3
  ownerId: string
  life: number
}

// Chunky arrow along +Z: wooden shaft, steel tip, red fletching. Exported
// so the first-person bow can show one nocked on the string.
export function buildArrow(): THREE.Group {
  const arrow = new THREE.Group()
  const wood = new THREE.MeshLambertMaterial({ color: 0x9a6a35, flatShading: true })
  const steel = new THREE.MeshLambertMaterial({ color: 0xb9bec6, flatShading: true })
  const red = new THREE.MeshLambertMaterial({ color: 0xc23b3b, flatShading: true })
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.025, 0.8, 5).rotateX(Math.PI / 2),
    wood,
  )
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 5).rotateX(Math.PI / 2), steel)
  tip.position.z = 0.45
  const fletchA = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.12, 0.1), red)
  fletchA.position.z = -0.36
  const fletchB = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.1), red)
  fletchB.position.z = -0.36
  arrow.add(shaft, tip, fletchA, fletchB)
  return arrow
}

export class Arrows {
  // An arrow found my chest: shove me a little. Wired in main.ts.
  onHitMe: (vel: THREE.Vector3) => void = () => {}
  // Something got skewered (ground, prop, or player) — main plays the thunk.
  onStick: (pos: THREE.Vector3) => void = () => {}
  private flights: Flight[] = []
  private readonly tmp = new THREE.Vector3()
  private readonly zAxis = new THREE.Vector3(0, 0, 1)

  constructor(private readonly scene: THREE.Scene) {}

  spawn(ownerId: string, origin: THREE.Vector3, dir: THREE.Vector3, power: number): void {
    const mesh = buildArrow()
    mesh.position.copy(origin)
    const speed = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * Math.max(0, Math.min(1, power))
    const vel = dir.clone().normalize().multiplyScalar(speed)
    mesh.quaternion.setFromUnitVectors(this.zAxis, dir.clone().normalize())
    this.scene.add(mesh)
    this.flights.push({ mesh, vel, ownerId, life: FLIGHT_LIFE })
  }

  update(dt: number, targets: StickTarget[]): void {
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i]
      f.life -= dt
      f.vel.y -= GRAVITY * dt
      f.mesh.position.addScaledVector(f.vel, dt)
      // Nose follows the arc — this is what sells the ballistic flight.
      this.tmp.copy(f.vel).normalize()
      f.mesh.quaternion.setFromUnitVectors(this.zAxis, this.tmp)
      const tip = this.tmp.copy(f.vel).normalize().multiplyScalar(0.45).add(f.mesh.position)

      const victim = targets.find(
        (t) =>
          t.id !== f.ownerId &&
          tip.distanceTo(
            new THREE.Vector3(t.group.position.x, t.group.position.y + 1.2, t.group.position.z),
          ) < 0.9,
      )
      if (victim) {
        this.stickToPlayer(f, victim)
        this.flights.splice(i, 1)
        continue
      }
      if (tip.y <= Math.max(heightAt(tip.x, tip.z), 0) + 0.02 || propInPath(tip)) {
        this.plant(f)
        this.flights.splice(i, 1)
        continue
      }
      if (f.life <= 0) {
        this.scene.remove(f.mesh)
        this.flights.splice(i, 1)
      }
    }
  }

  // Reparent the arrow into the victim's group so it rides along (and turns)
  // with them. Groups only rotate about Y, so undoing that yaw is enough.
  private stickToPlayer(f: Flight, victim: StickTarget): void {
    const group = victim.group
    // Sink the tip in a bit so it reads as embedded, not resting.
    f.mesh.position.addScaledVector(this.tmp.copy(f.vel).normalize(), 0.12)
    f.mesh.position.sub(group.position)
    f.mesh.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), -group.rotation.y)
    f.mesh.quaternion.premultiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -group.rotation.y),
    )
    this.scene.remove(f.mesh)
    group.add(f.mesh)
    this.onStick(group.position)
    if (victim.id === 'me') this.onHitMe(f.vel)
    const mesh = f.mesh
    setTimeout(() => mesh.parent?.remove(mesh), STUCK_MS)
  }

  // Leave the arrow embedded where it stopped, then quietly clean it up.
  private plant(f: Flight): void {
    this.onStick(f.mesh.position)
    const mesh = f.mesh
    setTimeout(() => mesh.parent?.remove(mesh), STUCK_MS)
  }
}
