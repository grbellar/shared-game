import * as THREE from 'three'
import { createCharacter, animateCharacter, type Pose } from './character'
import { heightAt } from './world'
import { blockFloorAt, wallAt } from './blocks'
import { sfx } from './audio'

const SPEED = 9
const RIDE_SPEED = 16 // wheelchair beats walking
const RAMSEY_SPEED = 19 // and four limbs beat two wheels
const GRAVITY = 30
const JUMP_VELOCITY = 11
const WATER_LEVEL = -1.1 // deep water floats you chest-deep instead of sinking forever
const FLOAT_BAND = 0.15 // how close to the surface still counts as floating

// A random dry-land spot so players don't stack on one point. Rejection
// sampling against heightAt (crater-aware, so nobody wakes up at the bottom
// of a freshly dug pond); center of the island as a last resort.
function randomSpawn(): { x: number; y: number; z: number } {
  for (let i = 0; i < 40; i++) {
    const x = (Math.random() - 0.5) * 100
    const z = (Math.random() - 0.5) * 100
    const h = heightAt(x, z)
    if (h > 1.5) return { x, y: h, z }
  }
  return { x: 0, y: heightAt(0, 0), z: 0 }
}

export interface PlayerInput {
  f: number
  s: number
  jump: boolean
  crouch: boolean
  sprint: boolean
  // First-person: keep facing under mouse control instead of turning
  // toward the direction of travel.
  strafe?: boolean
}

export class Player {
  group: THREE.Group
  moving = false // movement input this frame? The follow cam only recenters while true.
  pose: Pose = 'stand'
  dead = false
  ride: 'none' | 'wheelchair' | 'ramsey' = 'none'
  // Called when the respawn timer puts you back on the island.
  onRespawn: () => void = () => {}
  // Fired when we hit water hard enough to splash (main.ts spawns the effect).
  onSplash: (x: number, z: number) => void = () => {}
  private velY = 0
  private velX = 0
  private velZ = 0
  private onGround = false
  private walkPhase = 0
  private bobPhase = 0
  private wasFloating = false

  constructor(scene: THREE.Scene, color: string, name: string) {
    this.group = createCharacter(color, name)
    const spawn = randomSpawn()
    this.group.position.set(spawn.x, spawn.y, spawn.z)
    this.group.rotation.y = Math.random() * Math.PI * 2
    scene.add(this.group)
  }

  // Put the player somewhere else outright, dead still. Portals use this;
  // impulses must not survive a trip across the map.
  teleport(x: number, y: number, z: number, ry: number): void {
    this.group.position.set(x, y, z)
    this.group.rotation.y = ry
    this.velX = this.velY = this.velZ = 0
    this.onGround = false
    this.wasFloating = false
  }

  // Shove from an explosion (or whatever else wants to throw the player).
  applyImpulse(x: number, y: number, z: number): void {
    this.velX += x
    this.velZ += z
    this.velY += y
    if (y > 0) this.onGround = false
  }

  // Horizontal move with per-axis wall checks against built blocks: a
  // single block auto-steps (the floor resolve pops you up), anything
  // taller stops that axis. Terrain itself never blocks — only blocks do.
  private tryMove(mx: number, mz: number): void {
    const p = this.group.position
    const R = 0.35 // leading edge of the blocky torso
    if (mx !== 0 && !wallAt(p.x + mx + Math.sign(mx) * R, p.z, p.y)) p.x += mx
    if (mz !== 0 && !wallAt(p.x, p.z + mz + Math.sign(mz) * R, p.y)) p.z += mz
  }

  // Headless pause, then respawn somewhere fresh on the island.
  die(): void {
    if (this.dead) return
    this.dead = true
    setTimeout(() => {
      const spawn = randomSpawn()
      this.group.position.set(spawn.x, spawn.y, spawn.z)
      this.velX = this.velY = this.velZ = 0
      this.dead = false
      this.onRespawn()
    }, 2500)
  }

  update(dt: number, input: PlayerInput, camYaw: number): void {
    const swimming = this.pose === 'swim'
    const crouching = !swimming && this.ride === 'none' && input.crouch
    const sprinting = !crouching && input.sprint
    let speedMul = swimming ? 0.6 : crouching ? 0.45 : 1
    if (sprinting) speedMul *= 1.6

    let { f, s } = input
    if (this.dead) {
      f = 0
      s = 0
    }
    const mag = Math.hypot(f, s)
    const prevStep = Math.floor(this.walkPhase / Math.PI)

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
      const analog = Math.min(mag, 1)
      const moveSpeed =
        this.ride === 'ramsey' ? RAMSEY_SPEED : this.ride === 'wheelchair' ? RIDE_SPEED : SPEED
      this.tryMove(dx * moveSpeed * speedMul * analog * dt, dz * moveSpeed * speedMul * analog * dt)
      // Face the direction of travel, taking the short way around —
      // unless the mouse owns the facing (first-person strafe).
      if (!input.strafe) {
        const target = Math.atan2(dx, dz)
        const delta = Math.atan2(
          Math.sin(target - this.group.rotation.y),
          Math.cos(target - this.group.rotation.y),
        )
        this.group.rotation.y += delta * Math.min(1, 12 * dt)
      }
      moving = analog
      let cadence = (swimming ? 7 : crouching ? 8 : 11) * analog
      if (sprinting) cadence *= 1.5
      this.walkPhase += dt * cadence
    } else if (swimming) {
      this.walkPhase += dt * 2.8 // lazy paddle while treading water
    }

    // Knockback impulses decay with heavy friction.
    this.tryMove(this.velX * dt, this.velZ * dt)
    const friction = Math.pow(0.03, dt)
    this.velX *= friction
    this.velZ *= friction

    // Gravity, then ground, block-top, or water-surface collision.
    this.velY -= GRAVITY * dt
    this.group.position.y += this.velY * dt
    const ground = heightAt(this.group.position.x, this.group.position.z)
    // Highest built block we could stand on here. A block breaching the
    // surface turns deep water into a dock; a deeply sunk one stays swimmable.
    const blockTop = blockFloorAt(this.group.position.x, this.group.position.z, this.group.position.y)
    const overDeepWater = ground < WATER_LEVEL - 0.01 && blockTop < WATER_LEVEL - 0.01
    let floating = false
    if (
      overDeepWater &&
      this.velY <= 0 &&
      this.group.position.y <= WATER_LEVEL + FLOAT_BAND
    ) {
      // Stick to the water surface with a gentle bob.
      if (!this.wasFloating) {
        sfx.splash()
        this.onSplash(this.group.position.x, this.group.position.z)
      }
      this.bobPhase += dt * 2.5
      this.group.position.y = WATER_LEVEL + Math.sin(this.bobPhase) * 0.07
      this.velY = 0
      this.onGround = true
      floating = true
    } else {
      const floor = Math.max(ground, WATER_LEVEL, blockTop)
      if (this.group.position.y <= floor) {
        if (!this.onGround && this.velY < -5 && floor < -0.05) {
          // Landing feet-underwater in the shallows: splash, not thud.
          sfx.splash()
          this.onSplash(this.group.position.x, this.group.position.z)
        } else if (!this.onGround && this.velY < -7) {
          sfx.land(-this.velY / 25)
        }
        this.group.position.y = floor
        this.velY = 0
        this.onGround = true
      } else {
        this.onGround = false
      }
    }
    if (input.jump && this.onGround && !this.dead) {
      this.velY = JUMP_VELOCITY
      this.onGround = false
      sfx.jump()
    }

    this.moving = moving > 0

    // One footstep (or squeak, or paddle stroke) per half walk cycle. While
    // treading water in place the cycle still ticks, as quiet lapping.
    if (Math.floor(this.walkPhase / Math.PI) !== prevStep && !this.dead) {
      if (floating) moving > 0.15 ? sfx.paddle() : sfx.lap()
      else if (moving > 0.15 && this.onGround) {
        if (this.ride === 'wheelchair') sfx.squeak()
        else if (this.ride === 'ramsey') sfx.gallop()
        else sfx.step()
      }
    }
    this.wasFloating = floating

    this.pose = floating ? 'swim' : crouching ? 'crouch' : 'stand'
    animateCharacter(this.group, dt, this.walkPhase, moving, this.pose)
  }
}
