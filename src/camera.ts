import * as THREE from 'three'
import { heightAt } from './world'
import type { Player } from './player'
import type { Settings } from './settings'
import type { FirstPersonAim } from './firstperson'

const SENSITIVITY = 0.0035 // rad per px of mouse travel, matches first person
const LOOK_SMOOTH = 30 // how fast the camera chases the mouse (per second)
const DISTANCE = 10.8 // boom length from pivot to camera
const PITCH_DEFAULT = 0.59 // matches the old fixed framing (9 out, 6 up)
const PITCH_MIN = 0.06 // don't quite go flat — the boom would scrape the dirt
const PITCH_MAX = 1.3
const LOOK_HEIGHT = 2
const PIVOT_LERP = 8
const FOLLOW_RATE = 4

// Third-person mouse-look camera. Clicking the canvas grabs the pointer
// (main.ts routes locked mouse movement here), the mouse orbits yaw and
// pitch, Esc lets go. Mouse input steers a target angle and the camera
// chases it with a short lag — that filter, plus a smoothed pivot instead
// of a smoothed camera, is what keeps flicks fluid instead of jittery.
export class GameCamera {
  // Extra boom length, eased in. An X-wing is seven units of ship; at the
  // walking distance the camera sits inside its own engines.
  private boom = 0
  private targetBoom = 0
  private camYaw = 0
  private camPitch = PITCH_DEFAULT
  private targetYaw = 0
  private targetPitch = PITCH_DEFAULT
  private readonly pivot = new THREE.Vector3()
  private started = false
  private readonly offset = new THREE.Vector3()
  private readonly lookTarget = new THREE.Vector3()

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    camera.position.set(0, 12, 14)
  }

  // Movement is camera-relative; main.ts feeds this to player.update.
  get yaw(): number {
    return this.camYaw
  }

  // Direct yaw steering from outside the mouse path (touch drag).
  addYaw(delta: number): void {
    this.targetYaw += delta
  }

  // Pull the camera back for something bigger than a person. Eased, so
  // taking off and setting down are one continuous move.
  pullBack(extra: number): void {
    this.targetBoom = extra
  }

  // Pointer-locked mouse movement; main.ts routes it here in third person.
  // Mouse right pans the view right, mouse up looks up (camera dips).
  addLook(dx: number, dy: number): void {
    this.targetYaw -= dx * SENSITIVITY
    this.targetPitch = Math.max(
      PITCH_MIN,
      Math.min(PITCH_MAX, this.targetPitch + dy * SENSITIVITY),
    )
  }

  // Cut, don't glide. After a teleport the smoothing lerp would spend a
  // second flying the camera (and its pivot) across 1800 units of ocean.
  snapTo(player: Player): void {
    this.camYaw = this.targetYaw = player.group.rotation.y + Math.PI
    this.pivot.copy(player.group.position)
    this.started = true
    this.boom = this.targetBoom
    const cp = Math.cos(this.camPitch)
    const d = DISTANCE + this.boom
    this.offset.set(Math.sin(this.camYaw) * d * cp, Math.sin(this.camPitch) * d, Math.cos(this.camYaw) * d * cp)
    this.camera.position.copy(this.pivot).add(this.offset)
  }

  update(dt: number, player: Player, settings: Settings, fp: FirstPersonAim): void {
    this.boom += (this.targetBoom - this.boom) * Math.min(1, 2.5 * dt)
    if (fp.isActive) {
      // Rigid eye camera: at the head, looking along the crosshair. Follows
      // the crouch squat via the animation blend so ducking actually ducks.
      const anim = player.group.userData.anim as { crouch: number } | undefined
      const eyeY = player.group.position.y + 1.9 - 0.5 * (anim?.crouch ?? 0)
      this.camera.position.set(player.group.position.x, eyeY, player.group.position.z)
      fp.aimDir(this.lookTarget).add(this.camera.position)
      this.camera.lookAt(this.lookTarget)
      // Park the orbit behind the player at the default framing: movement
      // input stays aligned with facing, and dropping out of first person
      // doesn't snap the view.
      this.camYaw = this.targetYaw = player.group.rotation.y + Math.PI
      this.camPitch = this.targetPitch = PITCH_DEFAULT
      this.pivot.copy(player.group.position)
      this.started = true
      return
    }

    // Follow cam: while the player moves, ease in behind the character
    // (their yaw + π), taking the short way around. A mouse peek still
    // works — on release the camera glides back behind. Standing still,
    // a peek sticks.
    if (settings.cameraFollow && player.moving) {
      const behind = player.group.rotation.y + Math.PI
      const delta = Math.atan2(Math.sin(behind - this.targetYaw), Math.cos(behind - this.targetYaw))
      this.targetYaw += delta * Math.min(1, FOLLOW_RATE * dt)
    }

    const k = Math.min(1, LOOK_SMOOTH * dt)
    this.camYaw += (this.targetYaw - this.camYaw) * k
    this.camPitch += (this.targetPitch - this.camPitch) * k

    if (this.started) {
      this.pivot.lerp(player.group.position, Math.min(1, PIVOT_LERP * dt))
    } else {
      this.started = true
      this.pivot.copy(player.group.position)
    }

    const cp = Math.cos(this.camPitch)
    const d = DISTANCE + this.boom
    this.offset.set(Math.sin(this.camYaw) * d * cp, Math.sin(this.camPitch) * d, Math.cos(this.camYaw) * d * cp)
    this.camera.position.copy(this.pivot).add(this.offset)
    // Never sink under the island — low pitches can run the boom into a hill.
    const ground = Math.max(heightAt(this.camera.position.x, this.camera.position.z), 0) + 0.4
    if (this.camera.position.y < ground) this.camera.position.y = ground
    this.lookTarget.copy(this.pivot)
    this.lookTarget.y += LOOK_HEIGHT
    this.camera.lookAt(this.lookTarget)
  }
}
