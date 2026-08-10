import * as THREE from 'three'
import { buildA10, poseA10, A10_MUZZLE } from './a10'
import { heightAt } from './world'
import { makeNameTag } from './character'
import { RESIDENTS, drawMeckieFace, type MeckieMood } from './meckies'
import { sfx } from './audio'

// Fire missions: Droid flies the A-10 so you don't have to. One `cas`
// message carries the target `{x, z}`; the run-in heading, the whole flight
// path and the gun window are all closed-form functions of it, so every
// client watches the same aircraft fly the same line — the firework trick,
// at 85 units a second. Nothing is stored: a run lasts ~11 seconds and a
// late joiner just misses the show.
//
// Damage follows the fifty's rule: every client draws the tracers and the
// dirt, but only the CALLER's client resolves what a burst broke, minting it
// through the ordinary hit / bhit / crater messages (see onBurst in main.ts).
// Per-client drift in where a cosmetic tracer lands can never fork the world.

const SPEED = 85
const START_D = 430 // spawn this far out along the run-in line
const END_D = 480 // and vanish this far past the target
const CRUISE_ALT = 62
const DIVE_ALT = 16 // low enough to feel it, high enough to clear the castle
const GUN_FROM = -215 // signed distance along the line where the gun opens
const GUN_TO = -55 // ...and where Droid checks fire and pulls up
const BURST_S = 0.09 // one aim-and-damage tick of the gun
const BRRRT_S = 0.42 // the sound is one long burp, not per-tick
const RUMBLE_S = 0.24
const PUFF_S = 0.2 // marker smoke cadence on the target
const MAX_RUNS = 4
const FACE_PX = 64

interface Run {
  owner: string // player id, 'me' for our own
  target: THREE.Vector3 // y = ground height at call time
  dir: THREE.Vector3 // horizontal run-in heading, unit length
  t: number // seconds since the call
  plane: THREE.Group
  faceCtx: CanvasRenderingContext2D
  faceTex: THREE.CanvasTexture
  faceDrawn: string
  sinceBurst: number
  sinceBrrrt: number
  sinceRumble: number
  sincePuff: number
  burstN: number
}

export class A10Strikes {
  // One gun tick landing at `impact`. Fires on every client for every run —
  // main.ts draws the dirt for all of them and mints damage only when
  // `owner` is 'me'.
  onBurst: (owner: string, impact: THREE.Vector3) => void = () => {}
  // Tracer from the muzzle to the impact, cosmetic everywhere.
  onTracer: (from: THREE.Vector3, to: THREE.Vector3) => void = () => {}
  // Marker smoke on the target while the run is inbound.
  onPuff: (pos: THREE.Vector3) => void = () => {}
  private runs: Run[] = []

  constructor(private scene: THREE.Scene) {}

  // Somebody keyed the radio. Deterministic per (x, z); returns false only
  // when the sky is already full.
  call(owner: string, x: number, z: number): boolean {
    if (this.runs.length >= MAX_RUNS) return false
    const target = new THREE.Vector3(x, Math.max(heightAt(x, z), 0), z)
    // Heading hashed off the target itself, so every client flies the same
    // line without a heading ever crossing the wire.
    const h = (Math.abs(Math.sin(x * 12.9898 + z * 78.233)) * 43758.5453) % (Math.PI * 2)
    const dir = new THREE.Vector3(Math.sin(h), 0, Math.cos(h))

    const plane = buildA10()
    // Droid in the canopy: their face on a little screen where a pilot's
    // head would be, plus the family name tag. They are DELIGHTED to be here.
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = FACE_PX
    const ctx = canvas.getContext('2d')!
    const tex = new THREE.CanvasTexture(canvas)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.62, 0.62),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
    )
    face.position.set(0, 2.0, 0.62)
    plane.add(face)
    const tag = makeNameTag(RESIDENTS[0]?.name ?? 'Droid')
    tag.position.y = 3.7
    plane.add(tag)
    this.scene.add(plane)

    const run: Run = {
      owner,
      target,
      dir,
      t: 0,
      plane,
      faceCtx: ctx,
      faceTex: tex,
      faceDrawn: '',
      sinceBurst: 0,
      sinceBrrrt: 0,
      sinceRumble: 0,
      sincePuff: 0,
      burstN: 0,
    }
    this.paintFace(run, 'excited')
    this.place(run, 0)
    return this.runs.push(run) > 0
  }

  // True while anyone's run is still in the air — daynight fog and the
  // minimap don't care, but tests of "is the sky busy" might someday.
  get active(): boolean {
    return this.runs.length > 0
  }

  update(dt: number, listener: THREE.Vector3): void {
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const run = this.runs[i]
      run.t += dt
      const d = this.place(run, run.t)

      // Done: well past the target and climbing away into the fog.
      if (d > END_D) {
        this.scene.remove(run.plane)
        run.faceTex.dispose()
        this.runs.splice(i, 1)
        continue
      }

      const vol = Math.max(0, 1 - run.plane.position.distanceTo(listener) / 240)

      // Engine: a rumble tick, louder the closer the pass.
      run.sinceRumble += dt
      if (run.sinceRumble >= RUMBLE_S) {
        run.sinceRumble = 0
        sfx.jet(vol)
      }

      // Marker smoke on the target while the run is inbound.
      if (d < GUN_TO) {
        run.sincePuff += dt
        if (run.sincePuff >= PUFF_S) {
          run.sincePuff = 0
          this.onPuff(run.target)
        }
      }

      const gunOpen = d >= GUN_FROM && d <= GUN_TO
      this.paintFace(run, gunOpen ? 'furious' : 'excited')
      if (!gunOpen) continue

      // BRRRT. The sound is one long burp; the ticks underneath it are the
      // aim points, walking a line through the target.
      run.sinceBrrrt += dt
      if (run.sinceBrrrt >= BRRRT_S) {
        run.sinceBrrrt = 0
        sfx.brrrt(Math.max(0.35, vol))
      }
      run.sinceBurst += dt
      while (run.sinceBurst >= BURST_S) {
        run.sinceBurst -= BURST_S
        run.burstN++
        const u = (d - GUN_FROM) / (GUN_TO - GUN_FROM)
        // Walk from short of the target to just past it, with a hashed
        // wobble so the line reads as gunfire rather than a laser cut.
        const wob = (Math.abs(Math.sin(run.burstN * 91.7 + run.target.x)) * 437.53) % 1
        const alongT = -11 + 25 * u
        const impact = run.target
          .clone()
          .addScaledVector(run.dir, alongT)
          .add(new THREE.Vector3(run.dir.z, 0, -run.dir.x).multiplyScalar((wob * 2 - 1) * 1.6))
        impact.y = Math.max(heightAt(impact.x, impact.z), 0)
        run.plane.updateMatrixWorld()
        this.onTracer(run.plane.localToWorld(A10_MUZZLE.clone()), impact)
        this.onBurst(run.owner, impact)
      }
    }
  }

  // Closed-form flight: signed distance along the line is just time times
  // speed; altitude dips from cruise to the gun-run deck around the target
  // and climbs back out the other side. Returns d for the caller.
  private place(run: Run, t: number): number {
    const d = -START_D + SPEED * t
    const pos = run.target.clone().addScaledVector(run.dir, d)
    pos.y = run.target.y + altAt(d)
    // Pitch the same way the flight model does: sin(pitch) is the climb per
    // unit flown, so the nose leads the path exactly like a flown ship.
    const slope = (altAt(d + 4) - altAt(d)) / 4
    run.plane.position.copy(pos)
    run.plane.rotation.y = Math.atan2(run.dir.x, run.dir.z)
    run.plane.rotation.x = Math.asin(Math.max(-0.6, Math.min(0.6, slope)))
    poseA10(run.plane, 0.85)
    return d
  }

  private paintFace(run: Run, mood: MeckieMood): void {
    if (run.faceDrawn === mood) return
    run.faceDrawn = mood
    drawMeckieFace(run.faceCtx, RESIDENTS[0]?.color ?? '#2fb6e8', mood)
    run.faceTex.needsUpdate = true
  }
}

// The dive-and-climb profile: flat at CRUISE_ALT far out, down on the deck
// through the gun window, symmetric on the way out.
function altAt(d: number): number {
  const s = Math.min(1, Math.max(0, (Math.abs(d) - 60) / 190))
  return DIVE_ALT + (CRUISE_ALT - DIVE_ALT) * s * s * (3 - 2 * s)
}
