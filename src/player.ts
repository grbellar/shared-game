import * as THREE from 'three'
import { createCharacter, animateCharacter } from './character'
import { heightAt } from './world'

const SPEED = 9
const GRAVITY = 30
const JUMP_VELOCITY = 11
const WATER_LEVEL = -0.6 // you float waist-deep instead of sinking forever

export class Player {
  group: THREE.Group
  dead = false
  private velY = 0
  private velX = 0
  private velZ = 0
  private onGround = false
  private walkPhase = 0

  constructor(scene: THREE.Scene, color: string, name: string) {
    this.group = createCharacter(color, name)
    this.group.position.set(0, heightAt(0, 0), 0)
    scene.add(this.group)
  }

  // Shove from an explosion (or whatever else wants to throw the player).
  applyImpulse(x: number, y: number, z: number): void {
    this.velX += x
    this.velZ += z
    this.velY += y
    if (y > 0) this.onGround = false
  }

  // Headless pause, then respawn near the island center.
  die(): void {
    if (this.dead) return
    this.dead = true
    setTimeout(() => {
      const x = (Math.random() - 0.5) * 10
      const z = (Math.random() - 0.5) * 10
      this.group.position.set(x, heightAt(x, z), z)
      this.velX = this.velY = this.velZ = 0
      this.dead = false
    }, 2500)
  }

  update(dt: number, input: { f: number; s: number; jump: boolean }, camYaw: number): void {
    let { f, s } = input
    if (this.dead) {
      f = 0
      s = 0
    }
    const mag = Math.hypot(f, s)

    let moving = 0
    if (mag > 0.15) {
      if (mag > 1) {
        f /= mag
        s /= mag
      }
      // Camera sits behind the player at +camYaw, so forward is -camYaw.
      const fx = -Math.sin(camYaw)
      const fz = -Math.cos(camYaw)
      let dx = fx * f - fz * s
      let dz = fz * f + fx * s
      const len = Math.hypot(dx, dz)
      dx /= len
      dz /= len
      const speed = Math.min(mag, 1)
      this.group.position.x += dx * SPEED * speed * dt
      this.group.position.z += dz * SPEED * speed * dt
      // Face the direction of travel, taking the short way around.
      const target = Math.atan2(dx, dz)
      const delta = Math.atan2(
        Math.sin(target - this.group.rotation.y),
        Math.cos(target - this.group.rotation.y),
      )
      this.group.rotation.y += delta * Math.min(1, 12 * dt)
      moving = speed
      this.walkPhase += dt * 11 * speed
    }

    // Knockback impulses decay with heavy friction.
    this.group.position.x += this.velX * dt
    this.group.position.z += this.velZ * dt
    const friction = Math.pow(0.03, dt)
    this.velX *= friction
    this.velZ *= friction

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
    if (input.jump && this.onGround && !this.dead) {
      this.velY = JUMP_VELOCITY
      this.onGround = false
    }

    animateCharacter(this.group, this.walkPhase, moving)
  }
}
