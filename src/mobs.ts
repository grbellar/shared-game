import * as THREE from 'three'
import { heightAt } from './world'
import { inRealm } from './realm'
import type { Player } from './player'
import type { Remotes } from './remotes'
import type { Effects } from './effects'
import type { Net } from './net'
import type { Mass } from './mass'
import { animateCharacter, createCharacter, popHead, startJabber, type Rig } from './character'
import { sfx } from './audio'

// Land mobs: a bear that lives in the trees and Gary, a wild-eyed weirdo who
// mostly wanders in circles until somebody gets close enough to bother them.
//
// Same multiplayer model as the shark (see shark.ts): they chase player
// positions, so the sim can't be deterministic — the lowest player id hosts
// it and streams `mob` state ~10x/sec, everyone else interpolates. Damage
// *to* a mob is relayed as `mobhit` and only the attacker sends it; damage a
// mob does *to you* is decided on your own client through mass.damage,
// exactly like shark bites and blast knockback.

export type MobState = 'wander' | 'chase' | 'dead'

export interface MobNetState {
  i: number
  x: number
  z: number
  ry: number
  hp: number
  st: MobState
}

const SEND_INTERVAL = 0.1
const STALE_HOST = 2 // seconds of silence before we sim privately (shark rule)
const HOST_GRACE = 3 // a fresh join adopts the incumbent's sim before hosting
const LEASH = 62 // island only — nobody follows you into the sea or the fog

interface MobDef {
  name: string
  maxHp: number
  anchor: [number, number]
  wanderR: number
  wanderSpeed: number
  chaseSpeed: number
  turn: number // rad/sec
  aggroR: number // starts a chase only when somebody enters this radius
  loseR: number
  hitR: number
  dmg: number
  knock: number
  hitCd: number
  respawn: number
}

const BEAR: MobDef = {
  name: 'bear',
  maxHp: 90,
  anchor: [-30, 26],
  wanderR: 26,
  wanderSpeed: 2.6,
  chaseSpeed: 10.4, // outruns walking (9); a wheelchair (16) gets away
  turn: 2.4,
  aggroR: 16,
  loseR: 28,
  hitR: 2.6,
  dmg: 18,
  knock: 12,
  hitCd: 1.2,
  respawn: 32,
}

const GARY: MobDef = {
  name: 'gary',
  maxHp: 45,
  anchor: [26, -18],
  wanderR: 34,
  wanderSpeed: 4,
  chaseSpeed: 11,
  turn: 5,
  aggroR: 14,
  loseR: 26,
  hitR: 2.2,
  dmg: 8,
  knock: 14, // barely hurts, launches you anyway
  hitCd: 0.9,
  respawn: 26,
}

// What Gary yells when he picks you. Local-random per client — the timing is
// synced through the state stream, the exact nonsense is not, and that's fine.
const GARY_LINES = [
  'AAAAAAAAAAAA',
  'IT IS GARY TIME',
  'i am the bus now',
  'FREE HUGS!!!!',
  'wanna see a trick',
  'the rocks told me about you',
  'TAG!! you are it forever',
]
const GARY_IDLE_LINES = ['mmm rocks', 'hehehehe', 'where did i put it', '?????', 'nice day for it']

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a))
}

// Ease off approaching the target: full speed keeps the turn radius wider
// than the hit range, so an overshoot becomes an endless orbit around a
// victim it can never quite reach.
function closeSpeed(def: MobDef, dist: number): number {
  return dist < 6 ? Math.max(3.5, (def.chaseSpeed * dist) / 6) : def.chaseSpeed
}

// First patch of dry land near a spot — anchors are hand-picked but the
// terrain is analytic, so trust nothing and walk outward until it's dry.
function landNear(x0: number, z0: number): THREE.Vector2 {
  if (heightAt(x0, z0) > 0.8) return new THREE.Vector2(x0, z0)
  for (let r = 3; r < 42; r += 3)
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
      const x = x0 + Math.sin(a) * r
      const z = z0 + Math.cos(a) * r
      if (heightAt(x, z) > 0.8) return new THREE.Vector2(x, z)
    }
  return new THREE.Vector2(0, 20)
}

interface BearRig {
  legs: THREE.Mesh[]
  head: THREE.Group
  jaw: THREE.Mesh
}

// Blocky bear, forward is +Z like everything else. Big on purpose — it has
// to read as "run" from across the island at 320x240.
function buildBear(): { group: THREE.Group; rig: BearRig } {
  const group = new THREE.Group()
  const fur = new THREE.MeshLambertMaterial({ color: 0x6b4a2b, flatShading: true })
  const muzzle = new THREE.MeshLambertMaterial({ color: 0x9a7a4e, flatShading: true })
  const dark = new THREE.MeshLambertMaterial({ color: 0x241610, flatShading: true })

  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.4, 2.5), fur)
  torso.position.y = 1.5
  const hump = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 1.0), fur)
  hump.position.set(0, 2.3, -0.5)

  const head = new THREE.Group()
  head.position.set(0, 2.15, 1.45)
  const skull = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.85, 0.85), fur)
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.5), muzzle)
  snout.position.set(0, -0.15, 0.6)
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.15, 0.1), dark)
  nose.position.set(0, -0.05, 0.86)
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.16, 0.46), dark)
  jaw.position.set(0, -0.42, 0.55)
  const earGeo = new THREE.BoxGeometry(0.26, 0.26, 0.14)
  const earL = new THREE.Mesh(earGeo, fur)
  earL.position.set(-0.34, 0.52, -0.1)
  const earR = new THREE.Mesh(earGeo, fur)
  earR.position.set(0.34, 0.52, -0.1)
  const eyeGeo = new THREE.BoxGeometry(0.12, 0.12, 0.06)
  const eyeMat = new THREE.MeshLambertMaterial({ color: 0x111111 })
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat)
  eyeL.position.set(-0.24, 0.14, 0.44)
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat)
  eyeR.position.set(0.24, 0.14, 0.44)
  head.add(skull, snout, nose, jaw, earL, earR, eyeL, eyeR)

  const legGeo = new THREE.BoxGeometry(0.46, 1.0, 0.46)
  legGeo.translate(0, -0.5, 0) // pivot at the hip
  const legs: THREE.Mesh[] = []
  for (const [x, z] of [
    [-0.52, 0.95],
    [0.52, 0.95],
    [-0.52, -0.95],
    [0.52, -0.95],
  ]) {
    const leg = new THREE.Mesh(legGeo, fur)
    leg.position.set(x, 1.0, z)
    legs.push(leg)
    group.add(leg)
  }

  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), fur)
  tail.position.set(0, 1.7, -1.35)

  group.add(torso, hump, head, tail)
  return { group, rig: { legs, head, jaw } }
}

// Gary is just a player character who was never told the rules.
function buildGary(): THREE.Group {
  const group = createCharacter('#6fbf3f', 'gary')
  // Mismatched googly eyes: one huge, one small. Instantly deranged.
  let first = true
  group.traverse((o) => {
    if (o.name !== 'eye') return
    o.scale.set(first ? 2.6 : 1.4, first ? 2.6 : 1.4, 1)
    first = false
  })
  return group
}

interface Mob {
  def: MobDef
  kind: 'bear' | 'gary'
  group: THREE.Group
  bearRig: BearRig | null
  pos: THREE.Vector2
  yaw: number
  hp: number
  st: MobState
  heading: number
  headT: number // seconds until the next wander heading
  speed: number // current wander speed
  deadT: number
  fell: number // seconds spent dead, drives the fall-over/sink pose
  hitCd: number // local: min gap between swipes on OUR player
  roarCd: number // local: ambient roaring while it chases
  sayCd: number // local: Gary's idle mutterings
  walkPhase: number
  moving: number
  netTarget: { x: number; z: number; ry: number }
  // The id targets() yields for this mob, built once — the generator runs
  // every frame and a template literal per yield adds up.
  tid: string
}

// The prefix targets() stamps on a mob's id, with its index after it. Callers
// that damage by id (the sniper's hitscan) match on this.
export const MOB_TARGET_PREFIX = 'mob:'

export class Mobs {
  // Name plus where it fell — a dead mob leaves a pile of voxels behind.
  onDeath: (name: string, at: THREE.Vector3, i: number) => void = () => {}
  // A mob "spoke" — main.ts pins a chat bubble on it.
  onSay: (group: THREE.Group, text: string) => void = () => {}
  private mobs: Mob[] = []
  private sinceNet = 0
  private sendT = 0
  private uptime = 0

  constructor(
    scene: THREE.Scene,
    private net: Net,
    private effects: Effects,
    private remotes: Remotes,
    private mass: Mass,
  ) {
    for (const def of [BEAR, GARY]) {
      const bear = def === BEAR ? buildBear() : null
      const spawn = landNear(def.anchor[0], def.anchor[1])
      const mob: Mob = {
        def,
        kind: bear ? 'bear' : 'gary',
        group: bear ? bear.group : buildGary(),
        bearRig: bear ? bear.rig : null,
        pos: spawn.clone(),
        yaw: 0,
        hp: def.maxHp,
        st: 'wander',
        heading: 0,
        headT: 0,
        speed: def.wanderSpeed,
        deadT: 0,
        fell: 0,
        hitCd: 0,
        roarCd: 0,
        sayCd: 15,
        walkPhase: 0,
        moving: 0,
        netTarget: { x: spawn.x, z: spawn.y, ry: 0 },
        tid: `${MOB_TARGET_PREFIX}${this.mobs.length}`,
      }
      mob.group.position.set(spawn.x, Math.max(heightAt(spawn.x, spawn.y), 0), spawn.y)
      scene.add(mob.group)
      this.mobs.push(mob)
    }

    this.net.onMob = (s) => {
      this.sinceNet = 0
      if (this.isHost) return // our own sim wins
      const m = this.mobs[s.i]
      if (!m) return
      m.netTarget = { x: s.x, z: s.z, ry: s.ry }
      m.hp = s.hp
      this.setState(m, s.st)
    }
    this.net.onMobHit = (i, dmg) => {
      const m = this.mobs[i]
      if (m) this.applyDamage(m, dmg, false)
    }
  }

  // Host election, copied from the shark: lowest id sims, everyone agrees
  // without a handshake, next-lowest takes over the moment the host leaves.
  private get isHost(): boolean {
    let low = this.net.id
    let others = false
    for (const { id } of this.remotes.targets()) {
      others = true
      if (low === null || id < low) low = id
    }
    // A fresh join defers hosting even with the winning id: it holds only
    // constructor defaults, and needs a few seconds of the incumbent's
    // stream before taking over — otherwise every join can snap the mobs
    // back to their anchors at full health.
    if (others && this.uptime < HOST_GRACE) return false
    return low === null || low === this.net.id
  }

  // Something a rocket should burst against, in the shape effects.ts wants.
  // Without this a rocket sails straight through a bear and only hurts it if
  // it happens to hit the ground nearby. The ids can't collide with a
  // shooter's (server ids are uuid slices, ours is 'me'), so a rocket is never
  // stopped by its own owner check.
  *targets(): Generator<{ id: string; pos: THREE.Vector3 }> {
    for (const m of this.mobs) {
      if (m.st === 'dead') continue
      yield { id: m.tid, pos: m.group.position }
    }
  }

  // --- taking hits (attacker mints damage, same rule as sharkhit) ---------

  // Landed on from above. Unlike a skeleton a bear takes the weight rather
  // than dying to it, so the stomper sizes the damage by their own mass.
  stomp(feet: THREE.Vector3, dmg: number): boolean {
    for (const m of this.mobs) {
      if (m.st === 'dead') continue
      const p = m.group.position
      if (Math.hypot(p.x - feet.x, p.z - feet.z) > 1.8) continue
      const dy = feet.y - p.y
      if (dy < 1.0 || dy > 4.2) continue
      this.hit(m, dmg)
      return true
    }
    return false
  }

  blast(center: THREE.Vector3): void {
    for (const m of this.mobs) {
      if (m.st === 'dead') continue
      const d = m.group.position.distanceTo(center)
      if (d > 9) continue
      this.hit(m, 70 * (1 - d / 9))
    }
  }

  swing(from: THREE.Vector3, yaw: number, dmg: number): boolean {
    for (const m of this.mobs) {
      if (m.st === 'dead') continue
      const to = m.group.position.clone().sub(from)
      // Same vertical gate skeletons use — no swording a bear from a tower.
      if (Math.abs(to.y) > (m.kind === 'bear' ? 3.2 : 2.6)) continue
      to.y = 0
      if (to.length() > (m.kind === 'bear' ? 4.2 : 3.4)) continue
      if (Math.abs(wrapAngle(Math.atan2(to.x, to.z) - yaw)) > 1.3) continue
      this.hit(m, dmg)
      return true
    }
    return false
  }

  // A hitscan round from the local player connected with the mob that
  // targets() called `id`. Same ownership rule as swing(): the shooter mints
  // the damage and tells the room.
  shot(id: string, dmg: number): void {
    const m = this.mobs[Number(id.slice(MOB_TARGET_PREFIX.length))]
    if (!m || m.st === 'dead') return
    this.hit(m, dmg)
  }

  private hit(m: Mob, dmg: number): void {
    this.applyDamage(m, dmg, true)
    this.net.sendMobHit(this.mobs.indexOf(m), dmg)
  }

  private applyDamage(m: Mob, dmg: number, local: boolean): void {
    if (m.st === 'dead' || dmg <= 0) return
    m.hp -= dmg
    if (m.kind === 'bear') sfx.sharkHurt(local ? 0.8 : 0.4)
    else sfx.hurt(local ? 0.6 : 0.3)
    this.effects.spawnDebris(
      m.group.position.clone().add(new THREE.Vector3(0, 1.4, 0)),
      0x8a1f1f,
      6,
      5,
    )
    if (m.hp <= 0 && this.isHost) this.setState(m, 'dead')
  }

  private setState(m: Mob, next: MobState): void {
    if (next === m.st) return
    if (next === 'dead') {
      m.deadT = m.def.respawn
      m.fell = 0
      m.hp = 0
      if (m.kind === 'bear') {
        sfx.roar(this.volFor(m) * 0.9)
      } else {
        // Gary goes the way of every warrior here: head first.
        const headPos = popHead(m.group)
        if (headPos) this.effects.spawnHeadPop(headPos)
        sfx.pop(this.volFor(m))
      }
      this.effects.spawnDebris(m.group.position.clone().add(new THREE.Vector3(0, 1, 0)), 0x8a1f1f, 12, 7)
      this.onDeath(m.def.name, m.group.position.clone(), this.mobs.indexOf(m))
    } else if (m.st === 'dead') {
      // Back up: clear the fall-over pose.
      m.group.rotation.set(0, m.yaw, 0)
      m.hp = m.def.maxHp
    }
    if (next === 'chase') {
      if (m.kind === 'bear') {
        sfx.roar(this.volFor(m))
      } else {
        sfx.scream(this.volFor(m))
        startJabber(m.group, 2000)
        this.onSay(m.group, GARY_LINES[Math.floor(Math.random() * GARY_LINES.length)])
      }
    }
    m.st = next
  }

  // Distance falloff for mob noises — they happen away from the camera.
  private volFor(m: Mob): number {
    const p = this.playerPos
    if (!p) return 0.6
    const d = Math.hypot(p.x - m.pos.x, p.z - m.pos.y)
    return Math.max(0.05, Math.min(1, 1 - d / 80))
  }

  private playerPos: THREE.Vector3 | null = null

  // --- simulation (host only) ---------------------------------------------

  private simulate(m: Mob, dt: number, candidates: { id: string; pos: THREE.Vector3 }[]): void {
    if (m.st === 'dead') {
      m.deadT -= dt
      if (m.deadT <= 0) {
        const spawn = landNear(m.def.anchor[0], m.def.anchor[1])
        m.pos.copy(spawn)
        this.setState(m, 'wander')
      }
      return
    }

    // Only islanders count: nobody gets mauled in the shadow realm, and the
    // sea is the shark's jurisdiction.
    const reachable = candidates.filter(
      (c) => !inRealm(c.pos.x, c.pos.z) && Math.hypot(c.pos.x, c.pos.z) < LEASH,
    )

    const aggroRange = m.st === 'chase' ? m.def.loseR : m.def.aggroR
    let prey: { id: string; pos: THREE.Vector3 } | null = null
    let preyD = aggroRange
    for (const c of reachable) {
      const d = Math.hypot(c.pos.x - m.pos.x, c.pos.z - m.pos.y)
      if (d < preyD) {
        preyD = d
        prey = c
      }
    }
    // Swimmers are safe from land mobs — move() refuses water, so chasing
    // them would only leave the mob pacing the shore forever.
    if (prey && heightAt(prey.pos.x, prey.pos.z) < -0.5) prey = null
    if (prey) {
      this.setState(m, 'chase')
      let desired = Math.atan2(prey.pos.x - m.pos.x, prey.pos.z - m.pos.y)
      if (m.kind === 'gary') {
        // Gary still weaves once provoked, but no longer picks distant victims.
        desired += Math.sin(performance.now() * 0.005) * Math.min(0.7, preyD * 0.08)
      }
      this.move(m, desired, closeSpeed(m.def, preyD), dt)
      return
    }
    this.setState(m, 'wander')

    // Wandering: meander near the anchor. Gary re-rolls constantly and at
    // random speeds (including zero, staring at nothing), which is the joke.
    m.headT -= dt
    if (m.headT <= 0) {
      const gary = m.kind === 'gary'
      m.headT = gary ? 0.4 + Math.random() * 1.3 : 2 + Math.random() * 3
      m.heading = Math.random() * Math.PI * 2
      m.speed = gary ? Math.random() * 7 : m.def.wanderSpeed
      const home = Math.hypot(m.def.anchor[0] - m.pos.x, m.def.anchor[1] - m.pos.y)
      if (home > m.def.wanderR)
        m.heading = Math.atan2(m.def.anchor[0] - m.pos.x, m.def.anchor[1] - m.pos.y)
    }
    this.move(m, m.heading, m.speed, dt)
  }

  private move(m: Mob, desired: number, speed: number, dt: number): void {
    const turn = m.def.turn
    m.yaw += Math.max(-turn * dt, Math.min(turn * dt, wrapAngle(desired - m.yaw)))
    const nx = m.pos.x + Math.sin(m.yaw) * speed * dt
    const nz = m.pos.y + Math.cos(m.yaw) * speed * dt
    // Land animals: no sea, no crater lakes, no leaving the island.
    if (heightAt(nx, nz) > 0.35 && Math.hypot(nx, nz) < LEASH) m.pos.set(nx, nz)
    else m.headT = 0 // dead end — pick a new direction next tick
  }

  // --- per-frame ------------------------------------------------------------

  update(dt: number, player: Player): void {
    this.playerPos = player.group.position
    this.uptime += dt
    this.sinceNet += dt
    // Same stale-host fallback as the shark: if the elected host runs a build
    // without mobs, sim privately (no broadcast) instead of showing statues.
    const orphaned = !this.isHost && this.sinceNet > STALE_HOST
    const host = this.isHost

    if (host || orphaned) {
      const candidates = [
        { id: this.net.id ?? 'me', pos: player.group.position },
        ...this.remotes.targets(),
      ]
      for (const m of this.mobs) this.simulate(m, dt, candidates)
      this.sendT -= dt
      if (this.sendT <= 0 && !orphaned) {
        this.sendT = SEND_INTERVAL
        this.mobs.forEach((m, i) =>
          this.net.sendMob({ i, x: m.pos.x, z: m.pos.y, ry: m.yaw, hp: m.hp, st: m.st }),
        )
      }
    } else {
      for (const m of this.mobs) {
        const k = Math.min(1, 9 * dt)
        const jump = Math.hypot(m.netTarget.x - m.pos.x, m.netTarget.z - m.pos.y) > 25
        if (jump) m.pos.set(m.netTarget.x, m.netTarget.z)
        else
          m.pos.set(
            m.pos.x + (m.netTarget.x - m.pos.x) * k,
            m.pos.y + (m.netTarget.z - m.pos.y) * k,
          )
        m.yaw += wrapAngle(m.netTarget.ry - m.yaw) * k
        if (m.st === 'dead') m.deadT -= dt
      }
    }

    for (const m of this.mobs) {
      this.pose(m, dt)
      this.affectPlayer(m, dt, player)
      this.ambience(m, dt)
    }
  }

  private pose(m: Mob, dt: number): void {
    // Estimate speed from actual movement so remote interpolation animates too.
    const dx = m.pos.x - m.group.position.x
    const dz = m.pos.y - m.group.position.z
    const v = dt > 0 ? Math.hypot(dx, dz) / dt : 0
    m.moving += (Math.min(1, v / 5) - m.moving) * Math.min(1, 8 * dt)
    m.walkPhase += dt * (2 + v * 1.4)

    const ground = Math.max(heightAt(m.pos.x, m.pos.y), 0)

    if (m.st === 'dead') {
      m.fell += dt
      const over = Math.min(1, m.fell * 2.5)
      // Tip over sideways, then quietly sink away just before respawning.
      const sink = Math.max(0, m.fell - (m.def.respawn - 5)) * 0.6
      m.group.position.set(m.pos.x, ground - sink, m.pos.y)
      m.group.rotation.y = m.yaw
      m.group.rotation.z = (Math.PI / 2) * over
      return
    }

    m.group.position.set(m.pos.x, ground, m.pos.y)
    m.group.rotation.y = m.yaw
    m.group.rotation.z = 0

    if (m.kind === 'bear' && m.bearRig) {
      const swing = Math.sin(m.walkPhase * 2) * 0.7 * m.moving
      m.bearRig.legs[0].rotation.x = swing
      m.bearRig.legs[1].rotation.x = -swing
      m.bearRig.legs[2].rotation.x = -swing
      m.bearRig.legs[3].rotation.x = swing
      // Head up and jaw open when it means it.
      const angry = m.st === 'chase' ? 1 : 0
      m.bearRig.head.rotation.x += (-0.35 * angry - m.bearRig.head.rotation.x) * Math.min(1, 6 * dt)
      m.bearRig.jaw.position.y = -0.42 - 0.14 * angry
    } else if (m.kind === 'gary') {
      animateCharacter(m.group, dt, m.walkPhase * 2.2, m.moving)
      if (m.st === 'chase') {
        // Arms straight up, flailing. The international sign for Gary.
        const rig = m.group.userData.rig as Rig
        rig.armL.rotation.x = -Math.PI + Math.sin(m.walkPhase * 6) * 0.5
        rig.armR.rotation.x = -Math.PI - Math.sin(m.walkPhase * 6) * 0.5
        rig.armL.rotation.z = -0.25
        rig.armR.rotation.z = 0.25
      }
    }
  }

  // Everything a mob does *to you* is decided here, on your own client.
  private affectPlayer(m: Mob, dt: number, player: Player): void {
    if (m.hitCd > 0) m.hitCd -= dt
    if (m.st !== 'chase' || player.dead || this.mass.dead) return
    const p = player.group.position
    if (inRealm(p.x, p.z)) return
    const flat = Math.hypot(p.x - m.pos.x, p.z - m.pos.y)
    if (flat > m.def.hitR || m.hitCd > 0) return
    // No swiping at the sky: someone above head height (flying, jumping off a
    // block, mid-rocket-arc) is out of reach. Same rule skeletons follow.
    if (p.y - m.group.position.y > 2.6) return
    m.hitCd = m.def.hitCd
    if (m.kind === 'bear') sfx.crunch(1)
    else sfx.slash(0.8)
    this.mass.damage(m.def.dmg)
    const len = Math.max(0.001, flat)
    player.applyImpulse(
      ((p.x - m.pos.x) / len) * m.def.knock,
      5,
      ((p.z - m.pos.y) / len) * m.def.knock,
    )
  }

  // Local flavor on a timer: bears roar mid-chase, Gary mutters at nothing.
  private ambience(m: Mob, dt: number): void {
    if (m.st === 'chase' && m.kind === 'bear') {
      m.roarCd -= dt
      if (m.roarCd <= 0) {
        m.roarCd = 2.5 + Math.random() * 2
        sfx.roar(this.volFor(m) * 0.7)
      }
    }
    if (m.st === 'chase' && m.kind === 'gary') startJabber(m.group, 400)
    if (m.kind === 'gary' && m.st === 'wander') {
      m.sayCd -= dt
      if (m.sayCd <= 0) {
        m.sayCd = 14 + Math.random() * 20
        if (this.volFor(m) > 0.4) {
          startJabber(m.group, 1500)
          this.onSay(m.group, GARY_IDLE_LINES[Math.floor(Math.random() * GARY_IDLE_LINES.length)])
        }
      }
    }
  }
}
