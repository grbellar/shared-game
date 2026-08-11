import * as THREE from 'three'
import { heightAt } from './world'
import { WICHITA_X, WICHITA_Z } from './wichita'
import { sfx } from './audio'
import type { Player } from './player'

// The twister. It wanders the Kansas prairie (and, regularly, downtown
// Wichita) forever, and its position is a closed-form function of the SHARED
// day/night clock — the cats' trick at F5 scale. No host, no messages, no
// drift that matters: every client computes the same funnel in the same
// place, and scrubbing the room's clock scrubs the storm across the county.
//
// What it does to YOU is decided by your own client, the same split as blast
// knockback: the suction is a local impulse, and the strike — the whole
// point of it — hands you to main.ts, which launches you down the rocket arc
// to Oz. Watching somebody else get taken needs no sync at all: their
// position stream already tells the story.

const TAU = Math.PI * 2
// Integer cycles per 24-hour clock day, so every sine is continuous when the
// clock wraps midnight. Day length is 600 real seconds, which works out to a
// funnel that prowls at up to ~25 units/sec — outrunnable on wheels, not
// always on foot. That's the weather for you.
const PATH = { ax: 800, nx: 3, bx: 350, mx: 7, az: 600, nz: 5, bz: 250, mz: 11 }
const CX = WICHITA_X
const CZ = WICHITA_Z - 150

const FUNNEL_H = 46
const SUCK_R = 55 // start feeling the pull here
const CORE_R = 6 // inside this, you're going to Oz
const SIREN_R = 520 // Sedgwick County's finest, by distance
const SIREN_TICK_S = 3.1
const STRIKE_COOLDOWN_S = 20

export function tornadoAt(hours: number, out: THREE.Vector3): THREE.Vector3 {
  const h = (TAU * hours) / 24
  out.x = CX + PATH.ax * Math.sin(PATH.nx * h) + PATH.bx * Math.sin(PATH.mx * h + 1.7)
  out.z = CZ + PATH.az * Math.sin(PATH.nz * h + 0.9) + PATH.bz * Math.sin(PATH.mz * h + 4.0)
  out.y = Math.max(heightAt(out.x, out.z), 0)
  return out
}

export class Tornado {
  // The funnel swallowed the local player: main.ts sends them to Oz.
  onStrike: () => void = () => {}
  private group = new THREE.Group()
  private tiers: THREE.Mesh[] = []
  private cloud: THREE.Mesh
  private debris: THREE.Mesh[] = []
  private pos = new THREE.Vector3()
  private prev = new THREE.Vector3()
  private spin = 0
  private sirenT = 0
  private cooldown = 0

  constructor(scene: THREE.Scene) {
    // The funnel: stacked open-ended drums, wider with height, dark against
    // the sky. Open cylinders because the camera can end up inside one.
    const cloth = new THREE.MeshLambertMaterial({
      color: 0x4a4a52,
      flatShading: true,
      side: THREE.DoubleSide,
    })
    for (let i = 0; i < 6; i++) {
      const t = i / 5
      const r = 1.6 + t * t * 13
      const tier = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 1.15, r * 0.7, FUNNEL_H / 6 + 1, 8, 1, true),
        cloth,
      )
      tier.position.y = (i + 0.5) * (FUNNEL_H / 6)
      this.tiers.push(tier)
      this.group.add(tier)
    }
    this.cloud = new THREE.Mesh(
      new THREE.CylinderGeometry(30, 20, 7, 9),
      new THREE.MeshLambertMaterial({ color: 0x3a3a44, flatShading: true }),
    )
    this.cloud.position.y = FUNNEL_H + 3
    this.group.add(this.cloud)
    // Junk in orbit: fence posts and roofing, forever going around.
    const junk = new THREE.MeshLambertMaterial({ color: 0x6e5a3a, flatShading: true })
    for (let i = 0; i < 10; i++) {
      const bit = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 1.6), junk)
      this.debris.push(bit)
      this.group.add(bit)
    }
    scene.add(this.group)
  }

  update(dt: number, hours: number, player: Player, canStrike: boolean): void {
    this.prev.copy(this.pos)
    tornadoAt(hours, this.pos)
    this.group.position.copy(this.pos)
    if (this.cooldown > 0) this.cooldown -= dt

    // Spin, counter-rotating tiers, and a lean into the direction of travel.
    this.spin += dt * 7
    this.tiers.forEach((tier, i) => {
      tier.rotation.y = this.spin * (i % 2 ? -1 : 1) * (1.4 - i * 0.12)
    })
    this.cloud.rotation.y = this.spin * 0.2
    const vx = this.pos.x - this.prev.x
    const vz = this.pos.z - this.prev.z
    this.group.rotation.z = Math.max(-0.16, Math.min(0.16, -vx * 0.01))
    this.group.rotation.x = Math.max(-0.16, Math.min(0.16, vz * 0.01))
    this.debris.forEach((bit, i) => {
      const a = this.spin * (0.9 + (i % 3) * 0.13) + i
      const y = 3 + ((i * 7.3) % FUNNEL_H)
      const r = 3 + (y / FUNNEL_H) * 15
      bit.position.set(Math.cos(a) * r, y, Math.sin(a) * r)
      bit.rotation.set(a, a * 1.3, a * 0.7)
    })

    const p = player.group.position
    const d = Math.hypot(p.x - this.pos.x, p.z - this.pos.z)

    // The sirens: distance is the volume knob, and they never quite stop
    // while the funnel is in earshot. Kansas ambience.
    this.sirenT -= dt
    if (d < SIREN_R && this.sirenT <= 0) {
      this.sirenT = SIREN_TICK_S
      sfx.siren(Math.max(0.12, 1 - d / SIREN_R))
    }

    // Suction, self-applied like every other shove in the game.
    if (d < SUCK_R && !player.dead) {
      const k = (1 - d / SUCK_R) * 26 * dt
      player.applyImpulse(((this.pos.x - p.x) / (d || 1)) * k, k * 14, ((this.pos.z - p.z) / (d || 1)) * k)
    }

    // The strike. Your own client decides you were taken — nobody else runs
    // your fate, exactly like health — and the trip itself is the ordinary
    // rocket arc, so remotes watch you leave Kansas with zero new messages.
    if (d < CORE_R && canStrike && this.cooldown <= 0 && !player.dead) {
      this.cooldown = STRIKE_COOLDOWN_S
      this.onStrike()
    }
  }
}
