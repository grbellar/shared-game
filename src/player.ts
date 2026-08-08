import * as THREE from 'three'
import { createCharacter, animateCharacter, type Pose } from './character'
import { heightAt } from './world'

const SPEED = 9
const GRAVITY = 30
const JUMP_VELOCITY = 11
const WATER_LEVEL = -1.1 // deep water floats you chest-deep instead of sinking forever
const FLOAT_BAND = 0.15 // how close to the surface still counts as floating

export class Player {
  group: THREE.Group
  pose: Pose = 'stand'
  private velY = 0
  private onGround = false
  private walkPhase = 0
  private bobPhase = 0

  constructor(scene: THREE.Scene, color: string, name: string) {
    this.group = createCharacter(color, name)
    this.group.position.set(0, heightAt(0, 0), 0)
    scene.add(this.group)
  }

  update(dt: number, keys: Set<string>, camYaw: number): void {
    const swimming = this.pose === 'swim'
    const crouching = !swimming && keys.has('KeyC')
    const sprinting = !crouching && (keys.has('ShiftLeft') || keys.has('ShiftRight'))
    let speed = SPEED * (swimming ? 0.6 : crouching ? 0.45 : 1)
    if (sprinting) speed *= 1.6

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
      this.group.position.x += dx * speed * dt
      this.group.position.z += dz * speed * dt
      // Face the direction of travel, taking the short way around.
      const target = Math.atan2(dx, dz)
      const delta = Math.atan2(
        Math.sin(target - this.group.rotation.y),
        Math.cos(target - this.group.rotation.y),
      )
      this.group.rotation.y += delta * Math.min(1, 12 * dt)
      moving = 1
      let cadence = swimming ? 7 : crouching ? 8 : 11
      if (sprinting) cadence *= 1.5
      this.walkPhase += dt * cadence
    } else if (swimming) {
      this.walkPhase += dt * 2.8 // lazy paddle while treading water
    }

    // Gravity, then ground or water-surface collision.
    this.velY -= GRAVITY * dt
    this.group.position.y += this.velY * dt
    const ground = heightAt(this.group.position.x, this.group.position.z)
    const overDeepWater = ground < WATER_LEVEL - 0.01
    let floating = false
    if (
      overDeepWater &&
      this.velY <= 0 &&
      this.group.position.y <= WATER_LEVEL + FLOAT_BAND
    ) {
      // Stick to the water surface with a gentle bob.
      this.bobPhase += dt * 2.5
      this.group.position.y = WATER_LEVEL + Math.sin(this.bobPhase) * 0.07
      this.velY = 0
      this.onGround = true
      floating = true
    } else {
      const floor = Math.max(ground, WATER_LEVEL)
      if (this.group.position.y <= floor) {
        this.group.position.y = floor
        this.velY = 0
        this.onGround = true
      } else {
        this.onGround = false
      }
    }
    if (keys.has('Space') && this.onGround) {
      this.velY = JUMP_VELOCITY
      this.onGround = false
    }

    this.pose = floating ? 'swim' : crouching ? 'crouch' : 'stand'
    animateCharacter(this.group, dt, this.walkPhase, moving, this.pose)
  }
}
