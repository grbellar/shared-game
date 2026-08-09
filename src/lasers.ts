import * as THREE from 'three'
import { heightAt, propInPath, WATER_LEVEL } from './world'

// Laser cannon bolts from the X-wing's wingtips. Same split as rockets and
// arrows: the `laser` message carries an origin and a direction, every client
// simulates the identical bolt, and only the client that fired it resolves
// what it hit. Victims still subtract their own damage from a relayed `hit`,
// so nobody's head comes off because of somebody else's lag.

const SPEED = 210
const LIFE = 1.0
const HIT_R = 1.9 // bolts are fat and fast; be generous or nothing ever lands

interface Bolt {
  mesh: THREE.Mesh
  vel: THREE.Vector3
  ownerId: string
  life: number
}

export interface LaserTarget {
  id: string
  pos: THREE.Vector3
  // Hit radius, when this target isn't person-shaped (an X-wing).
  r?: number
}

// One shared geometry and material for every bolt in the air — a long thin
// bar, emissive so it reads as light rather than a red stick.
const BOLT_GEO = new THREE.BoxGeometry(0.14, 0.14, 3.2)
const BOLT_MAT = new THREE.MeshLambertMaterial({
  color: 0xff3b2a,
  emissive: 0xff2a14,
  emissiveIntensity: 1.6,
})

export class Lasers {
  // Built blocks the bolts should stop on; main.ts wires it, the same way
  // effects.ts stays ignorant of the block grid.
  solidAt: (p: THREE.Vector3) => boolean = () => false
  // A bolt reached the end of its flight. `hitId` is set when it was a
  // player. Only ever called with `ownerId === 'me'` in mind — main.ts checks.
  onImpact: (pos: THREE.Vector3, yaw: number, ownerId: string, hitId?: string) => void = () => {}
  private bolts: Bolt[] = []

  constructor(private scene: THREE.Scene) {}

  spawn(ownerId: string, origin: THREE.Vector3, dir: THREE.Vector3): void {
    const mesh = new THREE.Mesh(BOLT_GEO, BOLT_MAT)
    mesh.position.copy(origin)
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize())
    this.scene.add(mesh)
    this.bolts.push({
      mesh,
      vel: dir.clone().normalize().multiplyScalar(SPEED),
      ownerId,
      life: LIFE,
    })
  }

  update(dt: number, targets: LaserTarget[]): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i]
      b.life -= dt
      // 210 units/sec is three or four whole blocks per frame, so step the
      // bolt in slices — otherwise it tunnels through everything it passes.
      const steps = Math.max(1, Math.ceil((SPEED * dt) / 1.2))
      let hitId: string | undefined
      let done = b.life <= 0
      for (let s = 0; s < steps && !done; s++) {
        b.mesh.position.addScaledVector(b.vel, dt / steps)
        const p = b.mesh.position
        for (const t of targets) {
          if (t.id === b.ownerId) continue
          const hr = t.r ?? HIT_R
          // Aim at the chest, not the feet, where the group's origin sits.
          if (Math.abs(p.y - (t.pos.y + 1.1)) > hr) continue
          if (Math.hypot(p.x - t.pos.x, p.z - t.pos.z) > hr) continue
          hitId = t.id
          done = true
          break
        }
        if (done) break
        if (p.y <= Math.max(heightAt(p.x, p.z), WATER_LEVEL) || propInPath(p) || this.solidAt(p)) {
          done = true
        }
      }
      if (!done) continue
      const yaw = Math.atan2(b.vel.x, b.vel.z)
      // A bolt that simply timed out in open air fizzles quietly.
      if (b.life > 0) this.onImpact(b.mesh.position.clone(), yaw, b.ownerId, hitId)
      this.scene.remove(b.mesh)
      this.bolts.splice(i, 1)
    }
  }

  clear(): void {
    for (const b of this.bolts) this.scene.remove(b.mesh)
    this.bolts.length = 0
  }
}
