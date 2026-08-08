// Emotes: silly canned poses you fire from the radial menu (see emotewheel.ts).
//
// The active emote rides in PlayerState.emote, so remotes replay it the same
// way they replay a weapon — no new message type. Each client runs its own
// clock for the animation; a few frames of drift between machines is fine for
// a wave.

import type * as THREE from 'three'
import type { Rig } from './character'

export interface EmoteDef {
  id: string
  icon: string
  label: string
  seconds: number
}

// Order is the wheel order: index 0 sits at 12 o'clock, then clockwise.
export const EMOTES: EmoteDef[] = [
  { id: 'wave', icon: '👋', label: 'wave', seconds: 2.6 },
  { id: 'dance', icon: '🕺', label: 'dance', seconds: 12 },
  { id: 'clap', icon: '👏', label: 'clap', seconds: 3.2 },
  { id: 'laugh', icon: '😂', label: 'laugh', seconds: 3.4 },
  { id: 'flex', icon: '💪', label: 'flex', seconds: 3.6 },
  { id: 'bow', icon: '🙇', label: 'bow', seconds: 2.4 },
]

// How long a rocket trip takes, in two halves. These live here rather than in
// rocket.ts because the flight POSE animates off them — it has to know when
// you stop climbing and start diving — and this way the pose module never
// imports the system that triggers it. rocket.ts flies the same numbers.
export const ROCKET_ASCENT_S = 1.9
export const ROCKET_DESCENT_S = 2.3
export const ROCKET_FLIGHT_S = ROCKET_ASCENT_S + ROCKET_DESCENT_S

// Poses the wheel never offers, played by a system instead of a player. They
// still ride PlayerState.emote like any other emote, which is the whole point:
// remotes replay a launch and a landing with no new message and no new code.
export const POSES: EmoteDef[] = [
  // A shade longer than the flight, so the pose can't lapse on the frame
  // before touchdown and drop you into a walk cycle at 90 metres up.
  { id: 'rocketfly', icon: '🚀', label: 'liftoff', seconds: ROCKET_FLIGHT_S + 0.4 },
  { id: 'hero', icon: '🦸', label: 'landing', seconds: 2.8 },
]

export function emoteById(id: string): EmoteDef | undefined {
  return EMOTES.find((e) => e.id === id) ?? POSES.find((e) => e.id === id)
}

// Channels only emotes touch. animateCharacter rewrites limb rotations and
// body/head Y every frame, but not these — so wipe them before posing, or a
// finished emote leaves the character bent over forever. The group's X tilt
// is fair game because facing only ever uses Y.
export function clearEmotePose(group: THREE.Group, rig: Rig): void {
  group.rotation.x = 0
  rig.body.rotation.set(0, 0, 0)
  rig.body.scale.set(1, 1, 1)
  rig.body.position.z = 0
  rig.head.rotation.set(0, 0, 0)
  rig.head.position.z = 0
  rig.armL.scale.set(1, 1, 1)
  rig.armR.scale.set(1, 1, 1)
}

// Pose the rig for `id`, `t` seconds in. Limbs pivot at the shoulder/hip and
// hang down -Y, so a negative rotation.x swings a limb forward (+Z) and a
// positive rotation.z swings it toward +X.
export function applyEmote(
  group: THREE.Group,
  rig: Rig,
  id: string,
  t: number,
  riding: boolean,
): void {
  const legs = !riding // the wheelchair owns the legs; leave them seated

  if (id === 'wave') {
    const s = Math.sin(t * 9)
    // Straight up, not tipped forward: a tipped arm foreshortens into a stub
    // that looks detached from the shoulder. Waggle purely sideways.
    rig.armR.rotation.x = -3.0
    rig.armR.rotation.z = -0.2 - s * 0.45
    rig.armL.rotation.x = 0.1
    rig.armL.rotation.z = -0.15
    rig.head.rotation.z = s * 0.07
  } else if (id === 'dance') {
    // Disco point: one arm stabs up-and-out while the other crosses low,
    // hips twisting against them, whole body bouncing on the offbeat.
    const s = Math.sin(t * 7)
    const bounce = Math.abs(Math.cos(t * 7)) * 0.12
    rig.armR.rotation.x = -1.5 - 1.3 * s
    rig.armL.rotation.x = -1.5 + 1.3 * s
    rig.armR.rotation.z = 0.7 + 0.3 * s
    rig.armL.rotation.z = -0.7 + 0.3 * s
    rig.body.rotation.y = s * 0.35
    rig.head.rotation.y = -s * 0.3
    rig.body.position.y += bounce
    rig.head.position.y += bounce
    rig.armL.position.y += bounce
    rig.armR.position.y += bounce
    if (legs) {
      rig.legL.rotation.x = 0.35 * s
      rig.legR.rotation.x = -0.35 * s
    }
  } else if (id === 'clap') {
    const c = Math.abs(Math.sin(t * 7))
    rig.armL.rotation.x = -1.45
    rig.armR.rotation.x = -1.45
    rig.armL.rotation.z = 0.5 + 0.35 * c
    rig.armR.rotation.z = -0.5 - 0.35 * c
    rig.body.rotation.x = -0.12 * c
    rig.head.rotation.x = -0.1 * c
  } else if (id === 'laugh') {
    // Point at them, rock back howling.
    const s = Math.sin(t * 11)
    rig.armR.rotation.x = -1.6 + s * 0.12
    rig.armR.rotation.z = -0.25
    rig.armL.rotation.x = -0.9
    rig.armL.rotation.z = 0.55
    rig.body.rotation.x = 0.2 + s * 0.08
    rig.head.rotation.x = 0.35 + s * 0.1
    rig.head.position.z = -0.06
  } else if (id === 'flex') {
    // No elbows in this rig, so "double biceps" is arms up in a V plus an
    // arm that visibly swells. Reads fine at 320x240.
    const p = 0.5 + 0.5 * Math.sin(t * 6)
    const bulge = 1 + 0.55 * p
    rig.armL.rotation.x = -0.15
    rig.armR.rotation.x = -0.15
    rig.armL.rotation.z = -2.25 + 0.15 * p
    rig.armR.rotation.z = 2.25 - 0.15 * p
    rig.armL.scale.set(bulge, 0.85, bulge)
    rig.armR.scale.set(bulge, 0.85, bulge)
    rig.body.scale.set(1 + 0.12 * p, 1, 1 + 0.08 * p)
    rig.head.rotation.x = -0.12 * p
  } else if (id === 'bow') {
    // One dip: fold down over ~0.45s, hold, straighten by t=2.0.
    const down = Math.min(1, t / 0.45)
    const up = Math.max(0, (t - 1.5) / 0.5)
    const d = Math.max(0, Math.min(1, down - up))
    // There's no waist joint, so hinge the whole character forward at the
    // feet and pitch the torso a little further on top of it. Folding the
    // torso alone just buries the head in the chest.
    group.rotation.x = -0.55 * d
    rig.body.rotation.x = -0.4 * d
    rig.body.position.y -= 0.1 * d
    rig.body.position.z = 0.14 * d
    rig.head.rotation.x = -0.7 * d
    rig.head.position.y -= 0.3 * d
    rig.head.position.z = 0.5 * d
    rig.armL.rotation.x = -0.55 * d
    rig.armR.rotation.x = -0.55 * d
    rig.armL.rotation.z = -0.1
    rig.armR.rotation.z = 0.1
    if (legs) {
      rig.legL.rotation.x = 0
      rig.legR.rotation.x = 0
    }
  } else if (id === 'rocketfly') {
    // Strapped to the rocket: arms pinned back along the body, legs pressed
    // together, and the whole character pitched — nose up off the pad, easing
    // over the top, then diving at whatever you aimed at. Positive group X
    // leans back (the bow emote hinges forward with negative), and the phase
    // comes off the emote clock, so remotes fly the identical arc on their own
    // timer without a single byte crossing the wire.
    const climbing = t < ROCKET_ASCENT_S
    const u = climbing
      ? t / ROCKET_ASCENT_S
      : Math.min(1, (t - ROCKET_ASCENT_S) / ROCKET_DESCENT_S)
    group.rotation.x = climbing ? 0.9 - 0.55 * u : 0.35 - 1.25 * u
    const shake = Math.sin(t * 26) * 0.05 // engine rattle
    rig.body.rotation.z = shake
    rig.head.rotation.x = -0.25
    rig.armL.rotation.x = 0.95 + shake
    rig.armR.rotation.x = 0.95 - shake
    rig.armL.rotation.z = -0.2
    rig.armR.rotation.z = 0.2
    if (legs) {
      rig.legL.rotation.x = 0.15
      rig.legR.rotation.x = 0.15
      rig.legL.rotation.z = 0.04
      rig.legR.rotation.z = -0.04
    }
  } else if (id === 'hero') {
    // The superhero landing, held while the dust clears. Two beats: dropped
    // into the crater with a fist planted in the dirt, then chest up and both
    // arms flung wide. In the chair the legs stay seated, which is the joke —
    // you can absolutely stick a three-point landing sitting down.
    const land = Math.max(0, 1 - t / 0.75) // 1 on impact, gone by 0.75s
    const up = Math.min(1, Math.max(0, (t - 0.6) / 0.6))
    rig.body.position.y -= 0.34 * land
    rig.head.position.y -= 0.36 * land
    rig.body.rotation.x = -0.5 * land + 0.2 * up
    rig.head.rotation.x = -0.55 * land + 0.35 * up
    // Right fist drives into the ground and stays low; left sweeps back on
    // impact, then both open out into the pose.
    rig.armR.rotation.x = 0.2 - 0.15 * land
    rig.armR.rotation.z = 0.1 + 0.75 * up
    rig.armL.rotation.x = 1.05 * land + 0.2 * up
    rig.armL.rotation.z = -0.1 - 0.75 * up
    if (legs) {
      rig.legL.rotation.x = -1.2 * land
      rig.legR.rotation.x = 0.4 * land
      rig.legL.rotation.z = 0
      rig.legR.rotation.z = 0
    }
  }
}

// Tracks which emote the local player is playing and when it should stop.
// Owns no scene objects — main.ts hooks onChange to pose the character and
// to fold the id into the state we broadcast.
export class EmoteController {
  current = 'none'
  onChange: (id: string) => void = () => {}
  private until = 0

  play(id: string): void {
    const def = emoteById(id)
    if (!def) return
    this.current = id
    this.until = performance.now() + def.seconds * 1000
    this.onChange(id)
  }

  stop(): void {
    if (this.current === 'none') return
    this.current = 'none'
    this.until = 0
    this.onChange('none')
  }

  // Call every frame. `cancel` is "the player did something else" — moving,
  // jumping, attacking, dying.
  update(cancel: boolean): void {
    if (this.current === 'none') return
    if (cancel || performance.now() > this.until) this.stop()
  }
}
