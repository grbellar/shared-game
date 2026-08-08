import * as THREE from 'three'
import type { Player } from './player'
import type { Settings } from './settings'

const ORBIT_SPEED = 2.2
const DISTANCE = 9
const HEIGHT = 6
const LOOK_HEIGHT = 2
const POSITION_LERP = 8
const FOLLOW_RATE = 4

// Third-person orbit camera, steered with Q/E.
export class GameCamera {
  private camYaw = 0
  private readonly offset = new THREE.Vector3()
  private readonly lookTarget = new THREE.Vector3()

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    camera.position.set(0, 12, 14)
  }

  // Movement is camera-relative; main.ts feeds this to player.update.
  get yaw(): number {
    return this.camYaw
  }

  update(dt: number, keys: Set<string>, player: Player, settings: Settings): void {
    if (keys.has('KeyQ')) this.camYaw += ORBIT_SPEED * dt
    if (keys.has('KeyE')) this.camYaw -= ORBIT_SPEED * dt

    // Follow cam: while the player moves, ease in behind the character
    // (their yaw + π), taking the short way around. Q/E peeks still work —
    // while held they settle at a small offset; on release the camera
    // glides back behind. Standing still, a peek sticks.
    if (settings.cameraFollow && player.moving) {
      const behind = player.group.rotation.y + Math.PI
      const delta = Math.atan2(Math.sin(behind - this.camYaw), Math.cos(behind - this.camYaw))
      this.camYaw += delta * Math.min(1, FOLLOW_RATE * dt)
    }

    this.offset.set(Math.sin(this.camYaw) * DISTANCE, HEIGHT, Math.cos(this.camYaw) * DISTANCE)
    this.lookTarget.copy(player.group.position).add(this.offset)
    this.camera.position.lerp(this.lookTarget, Math.min(1, POSITION_LERP * dt))
    this.lookTarget.copy(player.group.position)
    this.lookTarget.y += LOOK_HEIGHT
    this.camera.lookAt(this.lookTarget)
  }
}
