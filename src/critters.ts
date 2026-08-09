import * as THREE from 'three'
import { heightAt } from './world'
import { sfx } from './audio'
import type { Effects } from './effects'

// Two wild animals nobody asked for.
//
// The duck patrols the shoreline. Katana it or blow it up and every player in
// the room hears about it (`egg` message, kind 'duck'); the culprit is fitted
// with the duck as a hat, permanently, as a warning to others.
//
// Nessie loops the island out past the fog line, so from the beach she is a
// rumour. Both animals ride the wall clock rather than a synced tick — a
// second of drift between clients is invisible on a duck.

const DUCK_RADIUS = 74
const DUCK_SPEED = 0.05 // radians/sec
const DUCK_RESPAWN = 60
const DUCK_QUACK_RANGE = 34

const NESSIE_RADIUS = 118
const NESSIE_SPEED = 0.022
const NESSIE_DIVE = 30

// Nessie's look, shared with the ridden copy (character.ts, nessie.ts) so a
// recolor or resize can't fork her silhouette between animal and ride.
export const NESSIE_HIDE = new THREE.MeshLambertMaterial({ color: 0x2f5d43, flatShading: true })
export const NESSIE_BELLY = new THREE.MeshLambertMaterial({ color: 0x8ec08a, flatShading: true })
export const NESSIE_HUMPS = 4
export const NESSIE_HUMP_SPACING = 3.4

export function buildNessieHump(i: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(1.5 - i * 0.18, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2),
    NESSIE_HIDE,
  )
}

function clockSeconds(): number {
  return Date.now() / 1000
}

const partWorld = new THREE.Vector3()

export class Critters {
  private duck: THREE.Group
  private duckAlive = true
  private duckTimer = 0
  private quackTimer = 4
  private nessie: THREE.Group
  private nessieParts: THREE.Object3D[] = []
  private nessieDive = 0
  private nessieClaimed = false

  constructor(
    scene: THREE.Scene,
    private effects: Effects,
  ) {
    this.duck = buildDuck()
    scene.add(this.duck)
    this.nessie = buildNessie(this.nessieParts)
    scene.add(this.nessie)
  }

  get duckPosition(): THREE.Vector3 | null {
    return this.duckAlive ? this.duck.position : null
  }

  // Somebody did it. Feathers everywhere, respawns after a minute.
  killDuck(): void {
    if (!this.duckAlive) return
    this.duckAlive = false
    this.duckTimer = DUCK_RESPAWN
    this.duck.visible = false
    const at = this.duck.position.clone().add(new THREE.Vector3(0, 0.4, 0))
    this.effects.spawnDebris(at, 0xf7f4ea, 16, 7)
    this.effects.spawnDebris(at, 0xf0a02a, 5, 5)
  }

  setNessieClaimed(claimed: boolean): void {
    this.nessieClaimed = claimed
    this.nessie.visible = !claimed
  }

  nessieMountable(pos: THREE.Vector3, radius: number): boolean {
    return this.nessieHitBy(pos, radius)
  }

  // Is this point close enough to any of Nessie's visible parts to touch her?
  // Runs per frame while Space is held (the mount check), so the whole-animal
  // early-out matters; every part sits within ~13 units of the group origin.
  nessieHitBy(center: THREE.Vector3, radius: number): boolean {
    if (this.nessieDive > 0 || this.nessieClaimed) return false
    if (this.nessie.position.distanceTo(center) > radius + 20) return false
    for (const part of this.nessieParts) {
      part.getWorldPosition(partWorld)
      if (partWorld.distanceTo(center) < radius) return true
    }
    return false
  }

  diveNessie(): void {
    this.nessieDive = NESSIE_DIVE
  }

  update(dt: number, listener: THREE.Vector3): void {
    const now = clockSeconds()

    // --- duck ---
    if (!this.duckAlive) {
      this.duckTimer -= dt
      if (this.duckTimer <= 0) {
        this.duckAlive = true
        this.duck.visible = true
      }
    }
    if (this.duckAlive) {
      const a = now * DUCK_SPEED
      const x = Math.cos(a) * DUCK_RADIUS
      const z = Math.sin(a) * DUCK_RADIUS
      // Ducks float, so wherever the island has sunk below the waterline the
      // duck just paddles. No terrain edge case can strand it.
      const ground = Math.max(heightAt(x, z), 0)
      this.duck.position.set(x, ground + Math.sin(now * 3) * 0.04, z)
      // Tangent of the circle, so it always waddles forwards. Characters and
      // critters face +Z, so rotation.y is atan2(dirX, dirZ).
      this.duck.rotation.y = Math.atan2(-Math.sin(a), Math.cos(a))
      this.duck.rotation.z = Math.sin(now * 7) * 0.13

      this.quackTimer -= dt
      if (this.quackTimer <= 0) {
        this.quackTimer = 5 + Math.random() * 7
        const d = this.duck.position.distanceTo(listener)
        if (d < DUCK_QUACK_RANGE) sfx.quack(1 - d / DUCK_QUACK_RANGE)
      }
    }

    // --- nessie ---
    if (this.nessieDive > 0) this.nessieDive -= dt
    const submerge = this.nessieDive > 0 ? 1 : 0
    const sink = (this.nessie.userData.sink as number) ?? 0
    const nextSink = sink + (submerge - sink) * Math.min(1, dt * 1.4)
    this.nessie.userData.sink = nextSink

    const na = now * NESSIE_SPEED
    this.nessie.position.set(Math.cos(na) * NESSIE_RADIUS, -7 * nextSink, Math.sin(na) * NESSIE_RADIUS)
    this.nessie.rotation.y = Math.atan2(-Math.sin(na), Math.cos(na))
    // Neck and humps breathe in and out of the water on their own phases.
    for (let i = 0; i < this.nessieParts.length; i++) {
      const part = this.nessieParts[i]
      const base = part.userData.baseY as number
      part.position.y = base + Math.sin(now * 1.1 - i * 0.8) * (i === 0 ? 0.7 : 0.55)
    }
  }
}

// Blocky duck, facing +Z.
function buildDuck(): THREE.Group {
  const duck = new THREE.Group()
  const cream = new THREE.MeshLambertMaterial({ color: 0xf7f4ea, flatShading: true })
  const bill = new THREE.MeshLambertMaterial({ color: 0xf0a02a, flatShading: true })
  const ink = new THREE.MeshLambertMaterial({ color: 0x111111 })

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.4, 0.78), cream)
  body.position.y = 0.34
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.34, 4).rotateX(-Math.PI / 2), cream)
  tail.position.set(0, 0.44, -0.5)
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.34, 0.2), cream)
  neck.position.set(0, 0.66, 0.2)
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.28, 0.3), cream)
  head.position.set(0, 0.92, 0.24)
  const beak = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.09, 0.24), bill)
  beak.position.set(0, 0.88, 0.46)
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.04), ink)
    eye.position.set(side * 0.1, 0.97, 0.38)
    duck.add(eye)
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.2), bill)
    foot.position.set(side * 0.14, 0.03, 0.06)
    duck.add(foot)
  }
  duck.add(body, tail, neck, head, beak)
  return duck
}

// Loch-Ness silhouette: a neck with a head, then a train of humps behind it.
// Segments are collected into `parts` so update() can bob them individually.
function buildNessie(parts: THREE.Object3D[]): THREE.Group {
  const nessie = new THREE.Group()
  const hide = NESSIE_HIDE
  const belly = NESSIE_BELLY
  const ink = new THREE.MeshLambertMaterial({ color: 0x111111 })

  const neck = new THREE.Group()
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.15, 5.2, 6), hide)
  column.position.y = 2.6
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.2, 2.4), hide)
  head.position.set(0, 5.4, 0.5)
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.9), belly)
  snout.position.set(0, 5.2, 1.7)
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.26, 0.14), ink)
    eye.position.set(side * 0.5, 5.7, 1.24)
    neck.add(eye)
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.6, 4), belly)
    horn.position.set(side * 0.42, 6.2, 0.2)
    neck.add(horn)
  }
  neck.add(column, head, snout)
  neck.position.set(0, 0, 4)
  neck.userData.baseY = 0.6
  nessie.add(neck)
  parts.push(neck)

  for (let i = 0; i < NESSIE_HUMPS; i++) {
    const hump = buildNessieHump(i)
    hump.position.set(0, 0, -i * NESSIE_HUMP_SPACING)
    hump.userData.baseY = -0.5
    nessie.add(hump)
    parts.push(hump)
  }
  return nessie
}
