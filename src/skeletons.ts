import * as THREE from 'three'
import { heightAt } from './world'
import { blockFloorAt, wallAt } from './blocks'
import { inRealm } from './realm'
import { GUARD_POSTS } from './castle'
import type { Player } from './player'
import type { Remotes } from './remotes'
import type { Effects } from './effects'
import type { Net } from './net'
import type { Health } from './health'
import { sfx } from './audio'

// The castle garrison. Same multiplayer model as the shark, for the same
// reason: a chase depends on player positions that land at different times on
// every client, so it can't be deterministic like the terrain. Exactly one
// client — the lowest player id in the room — simulates the whole roster and
// pushes it ~10x/sec; everyone else interpolates. Host handoff is automatic,
// and alone you host your own.
//
// Damage follows the same split as everything else in this game: a skeleton's
// blow is applied by the victim to itself, and damage *to* a skeleton is
// relayed as `skelhit` for the host to apply.

export type SkelState = 'idle' | 'chase' | 'strike' | 'dead'
const STATES: SkelState[] = ['idle', 'chase', 'strike', 'dead']

// Packed as five numbers each so the whole roster fits one small message.
export const SKEL_FIELDS = 5

const MAX_HP = 60
const AGGRO_R = 24 // notices you from about a courtyard away
const LEASH_R = 34 // ...and gives up once you're this far from its post
const STRIKE_R = 2.4
const REACH_R = 2.9 // the swing still lands if you back off a step mid-wind-up
const WINDUP = 0.45 // telegraph, so a swing is dodgeable
const RECOVER = 0.85
const SPEED = 5.4 // slower than a walk (9): outrunnable one-on-one, not in a pack
const GRAVITY = 26
const STRIKE_DAMAGE = 11
const RESPAWN_TIME = 25
const STALE_HOST = 2
const SEND_INTERVAL = 0.1
const BONE = 0xd9d3bb

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a))
}

interface Rig {
  root: THREE.Group
  armL: THREE.Group
  armR: THREE.Group
  legL: THREE.Group
  legR: THREE.Group
  jaw: THREE.Mesh
}

function buildSkeleton(): { group: THREE.Group; rig: Rig } {
  const group = new THREE.Group()
  const root = new THREE.Group()
  const bone = new THREE.MeshLambertMaterial({ color: BONE, flatShading: true })
  const dark = new THREE.MeshLambertMaterial({ color: 0x18140f, flatShading: true })
  const rust = new THREE.MeshLambertMaterial({ color: 0x6e4a32, flatShading: true })
  const blade = new THREE.MeshLambertMaterial({ color: 0x9aa0a8, flatShading: true })

  const box = (w: number, h: number, d: number, m: THREE.Material) =>
    new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)

  // Skull with sunken sockets and a hanging jaw.
  const head = new THREE.Group()
  const skull = box(0.52, 0.48, 0.48, bone)
  head.add(skull)
  for (const side of [-1, 1]) {
    const socket = box(0.14, 0.14, 0.06, dark)
    socket.position.set(side * 0.13, 0.04, 0.24)
    head.add(socket)
  }
  const jaw = box(0.4, 0.12, 0.36, bone)
  jaw.position.set(0, -0.29, 0.04)
  head.add(jaw)
  head.position.y = 1.72
  root.add(head)

  // Ribcage: a thin core with slats, so it reads hollow at 320x240.
  const spine = box(0.16, 0.66, 0.16, bone)
  spine.position.y = 1.12
  root.add(spine)
  for (let i = 0; i < 3; i++) {
    const rib = box(0.5, 0.09, 0.3, bone)
    rib.position.y = 1.34 - i * 0.2
    root.add(rib)
  }
  const hips = box(0.42, 0.16, 0.24, bone)
  hips.position.y = 0.78
  root.add(hips)

  const limb = (x: number, y: number, len: number): THREE.Group => {
    const g = new THREE.Group()
    const b = box(0.13, len, 0.13, bone)
    b.position.y = -len / 2
    g.add(b)
    g.position.set(x, y, 0)
    root.add(g)
    return g
  }
  const armL = limb(-0.33, 1.42, 0.68)
  const armR = limb(0.33, 1.42, 0.68)
  const legL = limb(-0.14, 0.78, 0.78)
  const legR = limb(0.14, 0.78, 0.78)

  // A notched sword in the right hand, because a skeleton with bare fists is
  // just a sad skeleton.
  const hilt = box(0.09, 0.22, 0.09, rust)
  hilt.position.y = -0.72
  const guard = box(0.34, 0.07, 0.1, rust)
  guard.position.y = -0.82
  const steel = box(0.11, 0.86, 0.05, blade)
  steel.position.y = -1.28
  armR.add(hilt, guard, steel)

  group.add(root)
  return { group, rig: { root, armL, armR, legL, legR, jaw } }
}

interface Skel {
  group: THREE.Group
  rig: Rig
  post: { x: number; y: number; z: number }
  x: number
  z: number
  y: number
  velY: number
  yaw: number
  hp: number
  st: SkelState
  timer: number // wind-up / recovery / respawn countdown
  phase: number // walk cycle
  flash: number
  // Non-host clients lerp toward whatever the host last said.
  netX: number
  netZ: number
  netY: number
  netYaw: number
  // Has this swing already landed on us? Latched per strike rather than timed
  // off the wall clock: the sim runs on dt, and in a throttled tab a
  // wall-clock cooldown expires mid-swing and lets one blow hit three times.
  struck: boolean
}

// The prefix targets() stamps on a skeleton's id, with its index after it.
// Callers that damage by id (the sniper's hitscan) match on this.
export const SKEL_TARGET_PREFIX = 'skel:'

export class Skeletons {
  private list: Skel[] = []
  private sinceNet = 99
  private sendT = 0
  private tmp = new THREE.Vector3()

  constructor(
    scene: THREE.Scene,
    private net: Net,
    private remotes: Remotes,
    private effects: Effects,
    private health: Health,
  ) {
    for (const post of GUARD_POSTS) {
      const built = buildSkeleton()
      built.group.position.set(post.x, post.y, post.z)
      scene.add(built.group)
      this.list.push({
        group: built.group,
        rig: built.rig,
        post,
        x: post.x,
        z: post.z,
        y: post.y,
        velY: 0,
        yaw: 0,
        hp: MAX_HP,
        st: 'idle',
        timer: 0,
        phase: 0,
        flash: 0,
        netX: post.x,
        netZ: post.z,
        netY: post.y,
        netYaw: 0,
        struck: false,
      })
    }

    this.net.onSkeletons = (packed) => {
      this.sinceNet = 0
      if (this.isHost) return // our own sim wins; a stale host notices and stops
      for (let i = 0; i < this.list.length; i++) {
        const o = i * SKEL_FIELDS
        if (o + SKEL_FIELDS > packed.length) break
        const s = this.list[i]
        s.netX = packed[o]
        s.netZ = packed[o + 1]
        s.netY = packed[o + 2]
        s.netYaw = packed[o + 3]
        const code = packed[o + 4]
        s.hp = Math.max(0, code >> 2) // hp and state share one number
        this.setState(s, STATES[code & 3] ?? 'idle')
      }
    }
    this.net.onSkeletonHit = (i, dmg) => {
      const s = this.list[i]
      if (s) this.applyDamage(s, dmg, false)
    }
  }

  // Lowest player id in the room hosts, so everyone agrees without a
  // handshake and the next-lowest takes over the moment the host leaves.
  private get isHost(): boolean {
    let low = this.net.id
    for (const { id } of this.remotes.targets()) if (low === null || id < low) low = id
    return low === null || low === this.net.id
  }

  // --- taking hits -------------------------------------------------------

  // A katana/shovel swing from the local player. True if it connected, so the
  // caller can stop looking for something else to hit.
  swing(from: THREE.Vector3, yaw: number, dmg: number): boolean {
    let best: Skel | null = null
    let bestD = 3.2
    for (const s of this.list) {
      if (s.st === 'dead') continue
      const dx = s.x - from.x
      const dz = s.z - from.z
      if (Math.abs(s.y - from.y) > 2.6) continue
      const d = Math.hypot(dx, dz)
      if (d > bestD) continue
      if (Math.abs(wrapAngle(Math.atan2(dx, dz) - yaw)) > 1.3) continue
      best = s
      bestD = d
    }
    if (!best) return false
    this.hit(best, dmg)
    return true
  }

  // Our own rocket went off. Only the rocket's owner calls this, matching the
  // crater rule, so one blast can't be counted once per player in the room.
  blast(center: THREE.Vector3, radius = 7): void {
    for (const s of this.list) {
      if (s.st === 'dead') continue
      const d = this.tmp.set(s.x, s.y + 0.9, s.z).distanceTo(center)
      if (d > radius) continue
      this.hit(s, 90 * (1 - d / radius))
    }
  }

  // A hitscan round from the local player connected with the skeleton that
  // targets() called `id`. Same ownership rule as swing(): the shooter mints
  // the damage and tells the room.
  shot(id: string, dmg: number): void {
    const s = this.list[Number(id.slice(SKEL_TARGET_PREFIX.length))]
    if (!s || s.st === 'dead') return
    this.hit(s, dmg)
  }

  private hit(s: Skel, dmg: number): void {
    this.applyDamage(s, dmg, true)
    this.net.sendSkeletonHit(this.list.indexOf(s), dmg)
  }

  private applyDamage(s: Skel, dmg: number, local: boolean): void {
    if (s.st === 'dead' || dmg <= 0) return
    s.hp -= dmg
    s.flash = 0.22
    this.effects.spawnDebris(this.tmp.set(s.x, s.y + 1.1, s.z), BONE, 5, 4)
    if (s.hp <= 0) {
      this.setState(s, 'dead')
      s.timer = RESPAWN_TIME
      sfx.boneShatter(local ? 1 : 0.55)
      this.effects.spawnDebris(this.tmp.set(s.x, s.y + 0.9, s.z), BONE, 14, 8)
    } else {
      sfx.boneRattle(local ? 0.9 : 0.5)
    }
  }

  // --- simulation --------------------------------------------------------

  update(dt: number, player: Player): void {
    this.sinceNet += dt
    const host = this.isHost
    // If the elected host isn't actually streaming — most likely a background
    // tab throttled to no frames — take over rather than freeze the garrison.
    const simulate = host || this.sinceNet > STALE_HOST

    // Everyone the garrison can see: us plus every remote in the realm.
    const targets: { pos: THREE.Vector3 }[] = []
    if (inRealm(player.group.position.x, player.group.position.z) && !player.dead) {
      targets.push({ pos: player.group.position })
    }
    for (const t of this.remotes.targets()) {
      if (inRealm(t.pos.x, t.pos.z)) targets.push({ pos: t.pos })
    }

    for (const s of this.list) {
      // Tick the wind-up here, not inside simulate(), because followers need
      // it too: the swing that lands on you has to finish on YOUR client (you
      // apply your own damage, same rule as blast knockback), and the strike
      // animation has to play. Ticking it only on the host meant everyone but
      // the host stood in front of a skeleton frozen mid-swing, unhurt.
      if (s.timer > 0) s.timer -= dt
      if (simulate) this.simulate(dt, s, targets)
      else this.follow(dt, s)
      this.applyToMe(s, player)
      this.render(dt, s)
    }

    if (simulate && this.net.connected) {
      this.sendT -= dt
      if (this.sendT <= 0) {
        this.sendT = SEND_INTERVAL
        const packed: number[] = []
        for (const s of this.list) {
          packed.push(
            Math.round(s.x * 100) / 100,
            Math.round(s.z * 100) / 100,
            Math.round(s.y * 100) / 100,
            Math.round(s.yaw * 100) / 100,
            // hp and state in one number: hp << 2 | state index.
            (Math.max(0, Math.ceil(s.hp)) << 2) | STATES.indexOf(s.st),
          )
        }
        this.net.sendSkeletons(packed)
      }
    }
  }

  private simulate(dt: number, s: Skel, targets: { pos: THREE.Vector3 }[]): void {
    if (s.st === 'dead') {
      if (s.timer <= 0) {
        s.hp = MAX_HP
        s.x = s.post.x
        s.z = s.post.z
        s.y = s.post.y
        s.velY = 0
        this.setState(s, 'idle')
      }
      return
    }

    // Nearest target inside aggro, and not so far from our post that chasing
    // would strand the whole garrison in the badlands.
    let prey: THREE.Vector3 | null = null
    let preyD = AGGRO_R
    for (const t of targets) {
      const d = Math.hypot(t.pos.x - s.x, t.pos.z - s.z)
      if (d > preyD) continue
      if (Math.hypot(t.pos.x - s.post.x, t.pos.z - s.post.z) > LEASH_R) continue
      prey = t.pos
      preyD = d
    }

    if (s.st === 'strike') {
      if (s.timer <= 0) this.setState(s, prey ? 'chase' : 'idle')
      if (prey) s.yaw += wrapAngle(Math.atan2(prey.x - s.x, prey.z - s.z) - s.yaw) * Math.min(1, 6 * dt)
      this.fall(dt, s)
      return
    }

    if (!prey) {
      // Drift back to the post and face out from it.
      const dx = s.post.x - s.x
      const dz = s.post.z - s.z
      const d = Math.hypot(dx, dz)
      if (d > 1) {
        this.setState(s, 'chase')
        this.step(dt, s, dx / d, dz / d, SPEED * 0.6)
      } else {
        this.setState(s, 'idle')
      }
      this.fall(dt, s)
      return
    }

    const dx = prey.x - s.x
    const dz = prey.z - s.z
    const d = Math.max(0.001, Math.hypot(dx, dz))
    s.yaw += wrapAngle(Math.atan2(dx, dz) - s.yaw) * Math.min(1, 7 * dt)
    if (d <= STRIKE_R) {
      this.setState(s, 'strike')
      s.timer = WINDUP + RECOVER
      sfx.boneRattle(0.35)
    } else {
      this.setState(s, 'chase')
      this.step(dt, s, dx / d, dz / d, SPEED)
    }
    this.fall(dt, s)
  }

  // Move with per-axis wall checks, the same rule the player walks by. If both
  // axes are blocked it just grinds against the wall — good enough for a
  // castle full of straight corridors, and no pathfinder to keep in sync.
  private step(dt: number, s: Skel, dx: number, dz: number, speed: number): void {
    const mx = dx * speed * dt
    const mz = dz * speed * dt
    const R = 0.35
    if (mx !== 0 && !wallAt(s.x + mx + Math.sign(mx) * R, s.z, s.y) && this.standable(s.x + mx, s.z, s.y)) {
      s.x += mx
    }
    if (mz !== 0 && !wallAt(s.x, s.z + mz + Math.sign(mz) * R, s.y) && this.standable(s.x, s.z + mz, s.y)) {
      s.z += mz
    }
    s.phase += dt * 9
  }

  // Nothing walks knowingly into the lava, and nothing steps off a ledge it
  // can't survive — the garrison would empty itself into the void in a minute.
  private standable(x: number, z: number, feetY: number): boolean {
    const floor = Math.max(heightAt(x, z), blockFloorAt(x, z, feetY))
    return floor > 0.2 && floor > feetY - 3
  }

  private fall(dt: number, s: Skel): void {
    s.velY -= GRAVITY * dt
    s.y += s.velY * dt
    const floor = Math.max(heightAt(s.x, s.z), blockFloorAt(s.x, s.z, s.y))
    if (s.y <= floor) {
      s.y = floor
      s.velY = 0
    }
  }

  private follow(dt: number, s: Skel): void {
    const k = Math.min(1, 10 * dt)
    if (Math.hypot(s.netX - s.x, s.netZ - s.z) > 12) {
      s.x = s.netX
      s.z = s.netZ
      s.y = s.netY
    } else {
      s.x += (s.netX - s.x) * k
      s.z += (s.netZ - s.z) * k
      s.y += (s.netY - s.y) * k
    }
    s.yaw += wrapAngle(s.netYaw - s.yaw) * k
    if (s.st === 'chase') s.phase += dt * 9
  }

  // What it does to US. Every client runs this for its own player only, the
  // same rule blast knockback follows — so nobody's health moves because of
  // somebody else's laggy simulation.
  private applyToMe(s: Skel, player: Player): void {
    if (s.st !== 'strike' || player.dead || s.struck) return
    // Land the blow at the end of the wind-up, once per swing.
    if (s.timer > RECOVER) return
    const p = player.group.position
    if (Math.hypot(p.x - s.x, p.z - s.z) > REACH_R) return
    if (Math.abs(p.y - s.y) > 2.4) return
    s.struck = true
    this.health.damage(STRIKE_DAMAGE)
    sfx.boneHit()
    player.applyImpulse(Math.sin(s.yaw) * 5, 3, Math.cos(s.yaw) * 5)
  }

  private setState(s: Skel, st: SkelState): void {
    if (s.st === st) return
    s.st = st
    s.group.visible = st !== 'dead'
    if (st === 'strike') {
      s.timer = WINDUP + RECOVER
      s.struck = false // a fresh swing gets a fresh chance to land
    }
  }

  private render(dt: number, s: Skel): void {
    s.group.position.set(s.x, s.y, s.z)
    s.group.rotation.y = s.yaw
    if (s.flash > 0) s.flash -= dt
    const { rig } = s
    if (s.st === 'strike') {
      // Wind the sword arm up over the skull, then chop.
      const t = 1 - Math.max(0, s.timer - RECOVER) / WINDUP
      const chop = s.timer <= RECOVER ? 1 - s.timer / RECOVER : 0
      rig.armR.rotation.x = -2.4 * t + 3.1 * chop
      rig.armL.rotation.x = -0.3
      rig.legL.rotation.x = 0
      rig.legR.rotation.x = 0
      rig.jaw.rotation.x = -0.35
      rig.root.rotation.x = 0.12 * chop
    } else {
      const swing = s.st === 'chase' ? Math.sin(s.phase) * 0.75 : Math.sin(s.phase * 0.15) * 0.06
      rig.legL.rotation.x = swing
      rig.legR.rotation.x = -swing
      rig.armL.rotation.x = -swing * 0.7
      rig.armR.rotation.x = swing * 0.7 - 0.25
      rig.jaw.rotation.x = -0.12 + Math.sin(s.phase * 0.5) * 0.06
      rig.root.rotation.x = 0
      // A permanent lurch, because they're held together with spite.
      rig.root.rotation.z = Math.sin(s.phase * 0.5) * 0.05
    }
  }

  // Minimap blips: where the living ones are.
  *blips(): Generator<{ x: number; z: number; hunting: boolean }> {
    for (const s of this.list) {
      if (s.st === 'dead') continue
      yield { x: s.x, z: s.z, hunting: s.st !== 'idle' }
    }
  }

  // Something a rocket should burst against, in the shape effects.ts wants.
  // Without this a rocket sails straight through a skeleton and only kills it
  // if it happens to hit the floor nearby. The ids can't collide with a
  // shooter's (server ids are uuid slices, ours is 'me'), so a rocket is never
  // stopped by its own owner check. `group.position` is the live one — render()
  // writes it every frame — so this allocates nothing.
  *targets(): Generator<{ id: string; pos: THREE.Vector3 }> {
    for (let i = 0; i < this.list.length; i++) {
      const s = this.list[i]
      if (s.st === 'dead') continue
      yield { id: `${SKEL_TARGET_PREFIX}${i}`, pos: s.group.position }
    }
  }

  // ...and the shape arrows.ts wants, so they stick in the ribcage. Cosmetic
  // only, exactly as arrows are against players.
  *stickTargets(): Generator<{ id: string; group: THREE.Group }> {
    for (let i = 0; i < this.list.length; i++) {
      const s = this.list[i]
      if (s.st === 'dead') continue
      yield { id: `skel:${i}`, group: s.group }
    }
  }

  get aliveCount(): number {
    return this.list.reduce((n, s) => n + (s.st === 'dead' ? 0 : 1), 0)
  }
}
