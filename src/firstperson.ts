import * as THREE from 'three'
import { heightAt } from './world'
import { buildBazooka, buildKatana, buildShovel, SLASH_DURATION } from './character'
import type { Player } from './player'

// First-person aiming: pointer-lock mouse look with a chunky crosshair.
// Active only while the setting is on and a weapon is equipped — main.ts
// decides and calls setActive every frame. Mouse yaw goes straight onto the
// player group (so it syncs over the net like any other turn); pitch is
// local aim only and rides the fire message as the rocket direction.

const SENSITIVITY = 0.0035 // rad per px of mouse travel
const PITCH_LIMIT = 1.25
const EYE_HEIGHT = 1.9
const DIG_REACH = 8
const KICK_TIME = 0.25 // bazooka recoil, seconds

// View-model pose per weapon, in camera space (camera looks down -Z).
// The bazooka is built pointing +Z so it flips around; the katana and
// shovel are built blade-down (-Y) so a positive X tilt raises the
// business end up-forward into a ready stance.
const VIEW_POSES: Record<string, { pos: [number, number, number]; rot: [number, number, number] }> = {
  gun: { pos: [0.5, -0.4, -0.9], rot: [0, Math.PI, 0] },
  sword: { pos: [0.42, -0.5, -0.8], rot: [1.9, 0, 0.15] },
  shovel: { pos: [0.42, -0.38, -0.6], rot: [1.55, 0, 0.12] },
}

export class FirstPersonAim {
  pitch = 0
  private active = false
  private readonly crosshair: HTMLDivElement
  private viewModel: THREE.Group | null = null
  private viewWeapon = 'none'
  private swingT = -1 // 0..1 while a chop plays, -1 idle
  private kickT = -1 // 0..1 while recoil plays, -1 idle

  constructor(
    private readonly player: Player,
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    const style = document.createElement('style')
    style.textContent = `
      #crosshair {
        position: fixed;
        left: 50%;
        top: 50%;
        width: 14px;
        height: 14px;
        margin: -7px 0 0 -7px;
        pointer-events: none;
        opacity: 0.85;
      }
      #crosshair::before, #crosshair::after {
        content: '';
        position: absolute;
        background: #fff;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
      }
      #crosshair::before { left: 6px; top: 0; width: 2px; height: 14px; }
      #crosshair::after { left: 0; top: 6px; width: 14px; height: 2px; }
    `
    document.head.appendChild(style)
    this.crosshair = document.createElement('div')
    this.crosshair.id = 'crosshair'
    this.crosshair.hidden = true
    document.body.append(this.crosshair)

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return
      // Mouse right turns right: facing is (sin ry, cos ry), and with the
      // camera looking along it screen-right is -X, so yaw decreases.
      this.player.group.rotation.y -= e.movementX * SENSITIVITY
      this.pitch = Math.max(
        -PITCH_LIMIT,
        Math.min(PITCH_LIMIT, this.pitch - e.movementY * SENSITIVITY),
      )
    })
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas
  }

  get isActive(): boolean {
    return this.active
  }

  // Called every frame with "should first person be on right now" and the
  // currently equipped weapon (drives the view model in the corner).
  setActive(active: boolean, weapon = 'none'): void {
    const want = active ? weapon : 'none'
    if (want !== this.viewWeapon) {
      if (this.viewModel) this.camera.remove(this.viewModel)
      this.viewModel = null
      this.viewWeapon = want
      this.swingT = this.kickT = -1
      if (want !== 'none') {
        const model =
          want === 'gun' ? buildBazooka() : want === 'sword' ? buildKatana() : buildShovel()
        const pose = VIEW_POSES[want]
        model.position.set(...pose.pos) // overrides the shoulder-mount offset baked into buildBazooka
        model.rotation.set(...pose.rot)
        this.viewModel = model
        this.camera.add(model)
      }
    }

    if (active === this.active) return
    this.active = active
    this.crosshair.hidden = !active
    // Hide our own model so we're not staring at the inside of our head.
    // Local-only: remote clients render this character normally.
    this.player.group.visible = !active
    if (!active) {
      this.pitch = 0
      if (this.locked) document.exitPointerLock()
    }
  }

  // Chop arc for the katana/shovel view model; call on attack.
  swing(): void {
    if (this.active) this.swingT = 0
  }

  // Bazooka recoil; call on fire.
  kick(): void {
    if (this.active) this.kickT = 0
  }

  // Per-frame view-model animation: everything eases back to the idle pose.
  update(dt: number): void {
    if (!this.viewModel) return
    const pose = VIEW_POSES[this.viewWeapon]
    let rx = pose.rot[0]
    let z = pose.pos[2]
    if (this.swingT >= 0) {
      this.swingT += dt / SLASH_DURATION
      if (this.swingT >= 1) this.swingT = -1
      // Smaller x-rotation tips the raised blade down-forward: a chop.
      else rx -= Math.sin(this.swingT * Math.PI) * 1.5
    }
    if (this.kickT >= 0) {
      this.kickT += dt / KICK_TIME
      if (this.kickT >= 1) this.kickT = -1
      else {
        const k = Math.sin(this.kickT * Math.PI)
        z += k * 0.3 // shove back toward the shoulder
        rx += k * 0.15 // muzzle bucks up (tube is Y-flipped, so positive x lifts it)
      }
    }
    this.viewModel.rotation.x = rx
    this.viewModel.position.z = z
  }

  // First click in first person grabs the pointer instead of attacking.
  // Returns true if this click was consumed for the grab.
  claimClickForLock(): boolean {
    if (!this.active || this.locked) return false
    this.canvas.requestPointerLock()
    return true
  }

  // Where the crosshair points.
  aimDir(out: THREE.Vector3): THREE.Vector3 {
    const ry = this.player.group.rotation.y
    const cp = Math.cos(this.pitch)
    return out.set(Math.sin(ry) * cp, Math.sin(this.pitch), Math.cos(ry) * cp)
  }

  // March the aim ray until it meets the ground — the shovel digs there.
  // Null when aiming at the sky or past reach (caller falls back to the
  // dig-at-your-feet behavior).
  aimedDigPoint(): { x: number; z: number } | null {
    const p = this.player.group.position
    const ry = this.player.group.rotation.y
    const cp = Math.cos(this.pitch)
    const sp = Math.sin(this.pitch)
    for (let t = 1; t <= DIG_REACH; t += 0.4) {
      const x = p.x + Math.sin(ry) * cp * t
      const z = p.z + Math.cos(ry) * cp * t
      const y = p.y + EYE_HEIGHT + sp * t
      if (y <= Math.max(heightAt(x, z), 0) + 0.1) return { x, z }
    }
    return null
  }
}
