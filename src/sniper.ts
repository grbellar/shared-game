import * as THREE from 'three'
import { heightAt, propInPath } from './world'
import { sfx } from './audio'

// The sniper rifle's two halves: the scope (zoom, overlay, breathing sway)
// and the hitscan that decides what the bullet met. Both are client-local —
// the only thing that goes over the wire is the tracer (`snipe`) and, if it
// landed on somebody, the usual `kill`.

const SCOPED_FOV = 15
const ZOOM_RATE = 14 // fov easing, per second
const SWAY = 0.009 // radians of breathing wobble at full zoom
const RANGE = 220 // bullets stop existing past this
const MARCH = 1 // coarse terrain step, refined by bisection
const HIT_R = 1.1 // how fat a player is to a bullet

export interface Hit {
  point: THREE.Vector3
  /** Player id when the round found somebody, null otherwise. */
  id: string | null
  kind: 'player' | 'ground' | 'prop' | 'sky'
}

// March the ray until it meets terrain, a prop, or the range limit, then see
// whether a player was standing in front of whatever it hit.
export function hitscan(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  targets: { id: string; pos: THREE.Vector3 }[],
): Hit {
  const p = new THREE.Vector3()
  const at = (t: number): THREE.Vector3 => p.copy(dir).multiplyScalar(t).add(origin)
  // Water counts as ground, same as rocket collision in effects.ts.
  const solid = (v: THREE.Vector3): boolean => v.y <= Math.max(heightAt(v.x, v.z), 0)

  let worldT = RANGE
  let kind: Hit['kind'] = 'sky'
  let prev = 0.4
  for (let t = 0.4; t <= RANGE; t += MARCH) {
    at(t)
    if (propInPath(p)) {
      worldT = t
      kind = 'prop'
      break
    }
    if (solid(p)) {
      // Bisect the last step so the impact sits on the surface, not a
      // metre inside the hill.
      let lo = prev
      let hi = t
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2
        if (solid(at(mid))) hi = mid
        else lo = mid
      }
      worldT = hi
      kind = 'ground'
      break
    }
    prev = t
  }

  // Closest approach of the ray to each player's chest, nearest wins.
  const v = new THREE.Vector3()
  let bestId: string | null = null
  let bestT = worldT
  for (const target of targets) {
    v.set(target.pos.x, target.pos.y + 1.3, target.pos.z).sub(origin)
    const t = v.dot(dir)
    if (t < 0.8 || t > bestT) continue
    if (Math.sqrt(Math.max(0, v.lengthSq() - t * t)) > HIT_R) continue
    bestId = target.id
    bestT = t
  }

  return {
    point: at(bestT).clone(),
    id: bestId,
    kind: bestId ? 'player' : kind,
  }
}

// Hold-to-scope: narrows the camera FOV, drops a chunky duplex reticle over
// the screen, and adds a slow breathing sway that the aim actually follows
// (main.ts feeds swayX/swayY into FirstPersonAim, so the shot goes where the
// wobbling crosshair says it does).
export class Scope {
  swayX = 0
  swayY = 0
  private on = false
  private fov: number
  private swayT = 0
  private readonly overlay: HTMLDivElement

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly baseFov: number,
  ) {
    this.fov = baseFov

    const style = document.createElement('style')
    style.textContent = `
      #scope {
        position: fixed;
        left: 50%;
        top: 50%;
        width: min(78vh, 78vw);
        height: min(78vh, 78vw);
        margin: 0;
        transform: translate(-50%, -50%);
        box-sizing: border-box;
        border: 3px solid #000;
        border-radius: 50%;
        background: rgba(96, 152, 124, 0.07);
        box-shadow: 0 0 0 100vmax #000, inset 0 0 34px 16px rgba(0, 0, 0, 0.8);
        pointer-events: none;
      }
      #scope div {
        position: absolute;
        background: #05070a;
      }
      #scope .hair-h { left: 0; right: 0; top: 50%; height: 2px; margin-top: -1px; }
      #scope .hair-v { top: 0; bottom: 0; left: 50%; width: 2px; margin-left: -1px; }
      #scope .duplex-l { left: 0; top: 50%; width: 30%; height: 6px; margin-top: -3px; }
      #scope .duplex-r { right: 0; top: 50%; width: 30%; height: 6px; margin-top: -3px; }
      #scope .duplex-t { top: 0; left: 50%; height: 30%; width: 6px; margin-left: -3px; }
      #scope .duplex-b { bottom: 0; left: 50%; height: 30%; width: 6px; margin-left: -3px; }
      #scope .dot { width: 4px; height: 4px; margin: -2px 0 0 -2px; top: 50%; left: 50%; }
    `
    document.head.appendChild(style)

    this.overlay = document.createElement('div')
    this.overlay.id = 'scope'
    this.overlay.hidden = true
    for (const cls of ['hair-h', 'hair-v', 'duplex-l', 'duplex-r', 'duplex-t', 'duplex-b']) {
      const part = document.createElement('div')
      part.className = cls
      this.overlay.append(part)
    }
    // Mil-dots down the vertical hair: eyeball holdover for a long shot.
    for (const offset of [6, 12, 18]) {
      const dot = document.createElement('div')
      dot.className = 'dot'
      dot.style.marginTop = `${offset}%`
      this.overlay.append(dot)
    }
    document.body.append(this.overlay)
  }

  get active(): boolean {
    return this.on
  }

  // How much narrower the view is than normal. Mouse look divides by this so
  // zoomed aiming stays precise instead of whipping across the island.
  get zoom(): number {
    return this.baseFov / this.fov
  }

  setActive(on: boolean): void {
    if (on === this.on) return
    this.on = on
    this.overlay.hidden = !on
    sfx.scope(on)
    if (!on) this.swayX = this.swayY = 0
  }

  update(dt: number): void {
    const want = this.on ? SCOPED_FOV : this.baseFov
    this.fov += (want - this.fov) * Math.min(1, ZOOM_RATE * dt)
    if (Math.abs(this.fov - want) < 0.05) this.fov = want
    if (this.camera.fov !== this.fov) {
      this.camera.fov = this.fov
      this.camera.updateProjectionMatrix()
    }
    if (!this.on) return
    // Two out-of-phase sines: a lazy figure-eight that never quite repeats
    // on the beat, so holding your breath is never an option.
    this.swayT += dt
    this.swayX = Math.sin(this.swayT * 1.1) * SWAY
    this.swayY = Math.sin(this.swayT * 1.73 + 1.3) * SWAY * 0.6
  }
}
