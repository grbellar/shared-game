import * as THREE from 'three'
import { createCharacter, animateCharacter } from './character'
import { heightAt } from './world'

const SPEED = 9
const GRAVITY = 30
const JUMP_VELOCITY = 11
const WATER_LEVEL = -0.6 // you float waist-deep instead of sinking forever

export class Player {
  group: THREE.Group
  private velY = 0
  private onGround = false
  private walkPhase = 0

  constructor(scene: THREE.Scene, color: string, name: string) {
    this.group = createCharacter(color, name)
    this.group.position.set(0, heightAt(0, 0), 0)
    scene.add(this.group)
  }

  update(dt: number, keys: Set<string>, camYaw: number): void {
    const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0)
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0)

    let moving = 0
    if (fwd !== 0 || strafe !== 0) {
      // Camera sits behind the player at +camYaw, so forward is -camYaw.
      const fx = -Math.sin(camYaw)
      const fz = -Math.cos(camYaw)
      let dx = fx * fwd - fz * strafe
      let dz = fz * fwd + fx * strafe
      const len = Math.hypot(dx, dz)
      dx /= len
      dz /= len
      this.group.position.x += dx * SPEED * dt
      this.group.position.z += dz * SPEED * dt
      // Face the direction of travel, taking the short way around.
      const target = Math.atan2(dx, dz)
      const delta = Math.atan2(
        Math.sin(target - this.group.rotation.y),
        Math.cos(target - this.group.rotation.y),
      )
      this.group.rotation.y += delta * Math.min(1, 12 * dt)
      moving = 1
      this.walkPhase += dt * 11
    }

    // Gravity and ground (or water surface) collision.
    this.velY -= GRAVITY * dt
    this.group.position.y += this.velY * dt
    const floor = Math.max(heightAt(this.group.position.x, this.group.position.z), WATER_LEVEL)
    if (this.group.position.y <= floor) {
      this.group.position.y = floor
      this.velY = 0
      this.onGround = true
    } else {
      this.onGround = false
    }
    if (keys.has('Space') && this.onGround) {
      this.velY = JUMP_VELOCITY
      this.onGround = false
    }

    animateCharacter(this.group, this.walkPhase, moving)
  }
}
