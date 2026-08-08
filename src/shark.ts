import * as THREE from 'three'
import { heightAt } from './world'
import { inRealm } from './realm'
import { WATER_LEVEL, type Player } from './player'
import type { Remotes } from './remotes'
import type { Effects } from './effects'
import type { Net } from './net'
import type { Health } from './health'
import { sfx } from './audio'

// The shark: one per room, patrolling the deep water around the island.
//
// Multiplayer model — the room is a dumb relay, and a chase depends on player
// positions that arrive at different times on every client, so the sim can't
// be deterministic the way the terrain is. Instead exactly one client hosts
// it: the lowest player id in the room owns the sim and pushes state ~10x/sec,
// everyone else interpolates what they receive. Host handoff is automatic —
// when the host leaves, the next-lowest id starts simulating on its next
// frame. Alone (or offline) you host your own shark.
//
// Damage is local, the same way blast knockback is: each client decides what
// the shark does to *its* player. Damage *to* the shark is relayed as
// 'sharkhit' so the host can apply it, and only the attacker sends it.

export type SharkState = 'patrol' | 'hunt' | 'grab' | 'dead' | 'land'

export interface SharkNetState {
  x: number
  z: number
  ry: number
  hp: number
  st: SharkState
  grab: string // id of the player in its jaws, '' when nobody is
}

const MAX_HP = 120
const SWIM_Y = -1.3 // body sits just under the surface; the fin cuts through
const DEEP = -2.0 // terrain below this is deep enough for it to swim
const PATROL_DEPTH = -3.5 // the depth contour it prefers to cruise along
const PATROL_R = 80 // fallback ring if the coast search comes up empty
const ROAM_R = 150 // hard leash so it never wanders into the fog forever
// The whole map is inside this: anyone who gets in the water is hunted, from
// wherever the shark happens to be. A short aggro range meant it only ever
// noticed you if it was already on your side of the island, and one lap of
// the coast takes minutes — so you'd swim, see nothing, and give up.
const AGGRO_R = 220
const CHARGE_R = 16
const GRAB_R = 2.6
const BITE_R = 3.0
const PATROL_SPEED = 5
const HUNT_SPEED = 11
const CRUISE_SPEED = 16 // closing in from across the map
const CRUISE_R = 70 // ...beyond this far
const CHARGE_SPEED = 17
const DRAG_SPEED = 9
const GRAB_TIME = 4
const GRAB_COOLDOWN = 5 // breathing room after it lets go
const RESPAWN_TIME = 22
// Every so often it forgets it's a fish and flops up the beach after someone.
const LAND_TIME = 14 // how long a raid lasts before it heads back to sea
const LAND_SPEED = 8.5 // walking (9) barely escapes; any ride does
const LAND_RANGE = 58 // it'll chase anyone on the island proper
const STALE_HOST = 2 // seconds of silence before we assume the host can't sim
const BITE_DAMAGE = 16
const CHOMP_DAMAGE = 22 // the initial grab
const DRAG_DPS = 9
const SEND_INTERVAL = 0.1

interface Rig {
  body: THREE.Group
  tail: THREE.Group
  jaw: THREE.Group
  mat: THREE.MeshLambertMaterial
}

function buildShark(): { group: THREE.Group; rig: Rig } {
  const group = new THREE.Group()
  const body = new THREE.Group()
  const mat = new THREE.MeshLambertMaterial({ color: 0x5c6b78, flatShading: true })
  const belly = new THREE.MeshLambertMaterial({ color: 0xd6d2c0, flatShading: true })
  const dark = new THREE.MeshLambertMaterial({ color: 0x2a1216, flatShading: true })
  const teeth = new THREE.MeshLambertMaterial({ color: 0xf2f2ea, flatShading: true })
  const eyeMat = new THREE.MeshLambertMaterial({ color: 0x111111 })

  // Torso: blocky trunk, cone snout. Forward is +Z, like everything else.
  const trunk = new THREE.Mesh(new THREE.BoxGeometry(1.25, 1.15, 2.3), mat)
  const snout = new THREE.Mesh(new THREE.ConeGeometry(0.66, 1.6, 4).rotateX(Math.PI / 2), mat)
  snout.position.z = 1.95
  snout.rotation.z = Math.PI / 4
  const gut = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.4, 2.1), belly)
  gut.position.y = -0.52

  // Tail: a tapering stalk plus two flattened triangles, all on one pivot so
  // the whole back half swings.
  const tail = new THREE.Group()
  tail.position.z = -1.15
  const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 1.0), mat)
  stalk.position.z = -0.4
  const lobeGeo = new THREE.ConeGeometry(0.5, 1.6, 3)
  const upper = new THREE.Mesh(lobeGeo, mat)
  upper.scale.set(0.13, 1, 1)
  upper.position.set(0, 0.5, -0.95)
  upper.rotation.x = -0.5
  const lower = new THREE.Mesh(lobeGeo, mat)
  lower.scale.set(0.13, 0.6, 1)
  lower.position.set(0, -0.4, -0.9)
  lower.rotation.set(0.5, 0, Math.PI)
  tail.add(stalk, upper, lower)

  // The bit everyone actually sees from the beach — oversized on purpose so
  // it still reads as a fin at 320x240 from across the water.
  const fin = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.8, 3), mat)
  fin.scale.set(0.14, 1, 1)
  fin.position.set(0, 1.25, -0.2)
  fin.rotation.x = -0.3

  const pecGeo = new THREE.BoxGeometry(1.4, 0.1, 0.55)
  const pecL = new THREE.Mesh(pecGeo, mat)
  pecL.position.set(-0.95, -0.35, 0.35)
  pecL.rotation.set(0, 0.4, 0.35)
  const pecR = new THREE.Mesh(pecGeo, mat)
  pecR.position.set(0.95, -0.35, 0.35)
  pecR.rotation.set(0, -0.4, -0.35)

  const eyeGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16)
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat)
  eyeL.position.set(-0.55, 0.28, 1.05)
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat)
  eyeR.position.set(0.55, 0.28, 1.05)

  // Hinged lower jaw so it can gape while charging. Silly > realistic.
  const jaw = new THREE.Group()
  jaw.position.set(0, -0.3, 0.85)
  const gum = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.3, 1.3), dark)
  gum.position.z = 0.6
  jaw.add(gum)
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.22, 1.2), dark)
  roof.position.set(0, -0.12, 1.4)

  const toothGeo = new THREE.ConeGeometry(0.09, 0.26, 3)
  for (let i = 0; i < 5; i++) {
    const x = -0.36 + i * 0.18
    const up = new THREE.Mesh(toothGeo, teeth)
    up.position.set(x, -0.32, 1.35 + (i % 2) * 0.12)
    up.rotation.x = Math.PI
    body.add(up)
    const down = new THREE.Mesh(toothGeo, teeth)
    down.position.set(x, 0.16, 0.6 + (i % 2) * 0.12)
    jaw.add(down)
  }

  const gillGeo = new THREE.BoxGeometry(0.06, 0.5, 0.1)
  for (let i = 0; i < 3; i++) {
    const gl = new THREE.Mesh(gillGeo, dark)
    gl.position.set(-0.64, 0, 0.55 - i * 0.26)
    const gr = new THREE.Mesh(gillGeo, dark)
    gr.position.set(0.64, 0, 0.55 - i * 0.26)
    body.add(gl, gr)
  }

  body.add(trunk, snout, gut, tail, fin, pecL, pecR, eyeL, eyeR, roof, jaw)
  group.add(body)
  return { group, rig: { body, tail, jaw, mat } }
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a))
}

// The one bit of HUD the shark owns: without it, being yanked out to sea just
// reads as broken controls.
function buildPrompt(): HTMLDivElement {
  const style = document.createElement('style')
  style.textContent = `
    #shark-grab {
      position: fixed;
      left: 0;
      right: 0;
      top: 38%;
      text-align: center;
      color: #fff;
      font: bold 22px monospace;
      text-shadow: 0 2px 0 #000, 0 0 8px #e23b3b;
      pointer-events: none;
      display: none;
      z-index: 5;
    }
    #shark-grab.show {
      display: block;
      animation: shark-shake 0.12s steps(2, end) infinite;
    }
    @keyframes shark-shake { 50% { transform: translateX(3px); } }
  `
  document.head.appendChild(style)
  const el = document.createElement('div')
  el.id = 'shark-grab'
  el.textContent = '🦈 MASH WASD! 🦈'
  document.body.append(el)
  return el
}

// The id the shark answers to inside a target list, matching the convention
// skeletons and mobs use. Can't collide with a shooter's id: server ids are
// hex uuid slices and ours is 'me'.
export const SHARK_TARGET_ID = 'shark'

export class Shark {
  onDeath: () => void = () => {}
  private group: THREE.Group
  private rig: Rig
  private pos = new THREE.Vector2(0, PATROL_R)
  private yaw = Math.PI / 2
  private hp = MAX_HP
  private st: SharkState = 'patrol'
  private grabId = ''
  private grabT = 0
  private grabCd = 0
  private deadT = 0
  private swimPhase = 0
  private coastCache = PATROL_R
  private coastT = 0
  private sinceNet = 0
  private sinkY = 0
  private flash = 0
  private sendT = 0
  private biteCd = 0
  private landCd = 40 + Math.random() * 50 // countdown to the next land raid
  private landT = 0
  private wasGrabbingMe = false
  private netTarget = { x: 0, z: PATROL_R, ry: Math.PI / 2 }
  private mouth = new THREE.Vector3()
  private prompt = buildPrompt()

  constructor(
    scene: THREE.Scene,
    private net: Net,
    private effects: Effects,
    private remotes: Remotes,
    private health: Health,
  ) {
    const built = buildShark()
    this.group = built.group
    this.rig = built.rig
    this.group.position.set(this.pos.x, SWIM_Y, this.pos.y)
    scene.add(this.group)

    this.net.onShark = (s) => {
      this.sinceNet = 0
      if (this.isHost) return // our own sim wins; a stale host will notice and stop
      this.netTarget = { x: s.x, z: s.z, ry: s.ry }
      this.hp = s.hp
      this.grabId = s.grab
      this.setState(s.st)
    }
    this.net.onSharkHit = (dmg) => this.applyDamage(dmg, false)
  }

  // Lowest player id in the room hosts, so everyone agrees without a
  // handshake and the next-lowest takes over the moment the host leaves.
  // Derived on every read rather than cached per frame: the websocket
  // handlers below need the right answer even before the first tick.
  private get hostId(): string | null {
    let low = this.net.id
    for (const { id } of this.remotes.targets()) if (low === null || id < low) low = id
    return low
  }

  // Alone or offline there is nobody else, so we host our own shark.
  private get isHost(): boolean {
    const low = this.hostId
    return low === null || low === this.net.id
  }

  // The id the local player answers to. Offline there is no id, so the shark
  // still has something to latch onto.
  private get myId(): string {
    return this.net.id ?? 'me'
  }

  get position(): THREE.Vector3 {
    return this.group.position
  }

  get alive(): boolean {
    return this.st !== 'dead'
  }

  // --- taking hits -----------------------------------------------------

  // A rocket went off. Only the owner of the rocket calls this, matching the
  // crater rule, so one blast can't be counted once per player in the room.
  blast(center: THREE.Vector3): void {
    if (this.st === 'dead') return
    const d = this.group.position.distanceTo(center)
    if (d > 9) return
    this.hit(70 * (1 - d / 9))
  }

  // A katana/shovel swing from the local player. Returns true if it connected.
  swing(from: THREE.Vector3, yaw: number, dmg: number): boolean {
    if (this.st === 'dead') return false
    const to = this.group.position.clone().sub(from)
    to.y = 0
    if (to.length() > 3.6) return false
    if (Math.abs(wrapAngle(Math.atan2(to.x, to.z) - yaw)) > 1.3) return false
    this.hit(dmg)
    return true
  }

  // Where a bullet can find it, in the shape hitscan wants. Empty once it's
  // dead so rounds pass through the carcass.
  targets(): { id: string; pos: THREE.Vector3 }[] {
    return this.st === 'dead' ? [] : [{ id: SHARK_TARGET_ID, pos: this.group.position }]
  }

  // A hitscan round from the local player connected. Same ownership rule as
  // swing(): the shooter mints the damage and tells the room.
  shot(dmg: number): void {
    if (this.st === 'dead') return
    this.hit(dmg)
  }

  // Mashing keys while it has hold of you. Hurts it a little; any hit at all
  // makes it let go, so struggling always works — it just takes a few tries.
  struggle(): void {
    if (this.grabId === '') return
    this.hit(6)
  }

  private hit(dmg: number): void {
    this.applyDamage(dmg, true)
    this.net.sendSharkHit(dmg)
  }

  private applyDamage(dmg: number, local: boolean): void {
    if (this.st === 'dead' || dmg <= 0) return
    this.hp -= dmg
    this.flash = 0.25
    sfx.sharkHurt(local ? 1 : 0.5)
    this.effects.spawnDebris(this.group.position, 0x8a1f1f, 6, 5)
    // Anything that stings makes it spit out whatever it was dragging.
    if (this.grabId !== '') this.release()
    if (this.hp <= 0 && this.isHost) this.setState('dead')
  }

  private release(): void {
    this.grabId = ''
    this.grabT = 0
    this.grabCd = GRAB_COOLDOWN
    if (this.st === 'grab') this.st = 'hunt'
  }

  private setState(next: SharkState): void {
    if (next === this.st) return
    if (next === 'dead') {
      this.deadT = RESPAWN_TIME
      this.sinkY = 0
      this.grabId = ''
      this.hp = 0
      sfx.sharkDie()
      this.effects.spawnDebris(this.group.position, 0x8a1f1f, 16, 8)
      this.onDeath()
    } else if (this.st === 'dead') {
      this.sinkY = 0
      this.rig.body.rotation.z = 0
    }
    // The beaching announces itself — one big thrash as it hits the sand.
    if (next === 'land') sfx.thrash(1)
    this.st = next
  }

  private respawn(): void {
    // Comes back from somewhere else entirely, out past the fog.
    const a = Math.random() * Math.PI * 2
    this.pos.set(Math.sin(a) * (PATROL_R + 20), Math.cos(a) * (PATROL_R + 20))
    this.yaw = a + Math.PI / 2
    this.hp = MAX_HP
    this.grabCd = 0
    this.setState('patrol')
  }

  // --- simulation (host only) -------------------------------------------

  private simulate(dt: number, player: Player, localId: string): void {
    if (this.st === 'dead') {
      this.deadT -= dt
      if (this.deadT <= 0) this.respawn()
      return
    }
    if (this.grabCd > 0) this.grabCd -= dt
    if (this.st !== 'grab') this.landCd -= dt

    // Only people actually in the water are on the menu.
    const candidates = [{ id: localId, pos: player.group.position }, ...this.remotes.targets()]

    // Land raid: flop up the beach after whoever's closest, then drag
    // yourself home. Bites still land (see affectPlayer); no grabbing on
    // land — being towed across a meadow would be a step too far even here.
    if (this.st === 'land') {
      // The raid clock only runs ashore — however far the swim in was, you
      // get the same amount of shark on your lawn.
      const ashore = heightAt(this.pos.x, this.pos.y) > DEEP
      if (ashore) this.landT -= dt
      let prey: THREE.Vector3 | null = null
      let preyD = Infinity
      for (const c of candidates) {
        if (inRealm(c.pos.x, c.pos.z)) continue
        if (Math.hypot(c.pos.x, c.pos.z) > LAND_RANGE) continue
        const d = Math.hypot(c.pos.x - this.pos.x, c.pos.z - this.pos.y)
        if (d < preyD) {
          preyD = d
          prey = c.pos
        }
      }
      if (this.landT > 0 && prey) {
        // Full cruise while still swimming in; ashore, ease off up close, or
        // the turn radius outruns the bite range and it orbits its lunch.
        const speed = !ashore
          ? CRUISE_SPEED
          : preyD < 7
            ? Math.max(3.5, (LAND_SPEED * preyD) / 7)
            : LAND_SPEED
        this.flop(Math.atan2(prey.x - this.pos.x, prey.z - this.pos.y), speed, dt)
      } else {
        // Time's up: straight back out to sea, radially — the shortest wet.
        this.flop(Math.atan2(this.pos.x, this.pos.y), LAND_SPEED, dt)
        if (heightAt(this.pos.x, this.pos.y) <= DEEP) {
          this.setState('patrol')
          this.landCd = 50 + Math.random() * 60
        }
      }
      return
    }
    if (this.landCd <= 0 && this.st !== 'grab') {
      // Anyone strolling the island? Ruin their picnic.
      const someone = candidates.some(
        (c) =>
          !inRealm(c.pos.x, c.pos.z) &&
          Math.hypot(c.pos.x, c.pos.z) < LAND_RANGE &&
          heightAt(c.pos.x, c.pos.z) > 0.5,
      )
      if (someone) {
        this.setState('land')
        this.landT = LAND_TIME
        return
      }
      this.landCd = 15 // nobody ashore — try again in a bit
    }
    let prey: { id: string; pos: THREE.Vector3 } | null = null
    let preyD = AGGRO_R
    for (const c of candidates) {
      if (c.pos.y > WATER_LEVEL + 0.4) continue
      if (heightAt(c.pos.x, c.pos.z) > -1.15) continue
      // Must be in the actual sea. The shoreline never comes inside r=50, so
      // this only rules out someone paddling in a flooded crater — which the
      // shark can't reach, and would otherwise leave it parked against the
      // beach forever instead of patrolling where people can see it.
      if (Math.hypot(c.pos.x, c.pos.z) < 50) continue
      // ...and in THIS sea. Floating in the shadow realm's lava also puts you
      // at WATER_LEVEL, and aggro has no range limit, so without this the
      // shark sets off on an 1800-unit swim across the void.
      if (inRealm(c.pos.x, c.pos.z)) continue
      const d = Math.hypot(c.pos.x - this.pos.x, c.pos.z - this.pos.y)
      if (d < preyD) {
        preyD = d
        prey = c
      }
    }

    if (this.st === 'grab') {
      const still = candidates.find((c) => c.id === this.grabId)
      this.grabT -= dt
      // Let go when the timer runs out, at the end of the leash, or if the
      // victim isn't where its teeth are any more (they respawned).
      const slipped =
        !still || Math.hypot(still.pos.x - this.pos.x, still.pos.z - this.pos.y) > 6
      if (slipped || this.grabT <= 0 || this.pos.length() > ROAM_R - 5) {
        this.release()
      } else {
        // Straight out to sea, where it's deep and nobody can help you.
        const out = this.pos.lengthSq() > 1 ? this.pos.clone().normalize() : new THREE.Vector2(0, 1)
        this.steer(Math.atan2(out.x, out.y), DRAG_SPEED, dt, 1.4)
        return
      }
    }

    if (prey && this.grabCd <= 0) {
      this.st = 'hunt'
      const desired = Math.atan2(prey.pos.x - this.pos.x, prey.pos.z - this.pos.y)
      const charging = preyD < CHARGE_R
      const speed = charging ? CHARGE_SPEED : preyD > CRUISE_R ? CRUISE_SPEED : HUNT_SPEED
      this.steer(desired, speed, dt, charging ? 2.6 : 1.8)
      if (preyD < GRAB_R) {
        this.grabId = prey.id
        this.grabT = GRAB_TIME
        this.st = 'grab'
      }
      return
    }

    // Nothing worth chasing: cruise the coastline and wait. Following the
    // shore rather than a fixed circle matters — the island is lumpy, so one
    // radius that clears the beach on the shallow side puts the shark out in
    // the fog on the other, where nobody ever sees it.
    this.st = 'patrol'
    const ang = Math.atan2(this.pos.x, this.pos.y) + 0.45
    const r = this.coastRadius(ang, dt)
    const desired = Math.atan2(Math.sin(ang) * r - this.pos.x, Math.cos(ang) * r - this.pos.y)
    this.steer(desired, PATROL_SPEED, dt, 1.2)
  }

  // Radius of the first properly-deep water at this bearing. Sampled a few
  // times a second, not every frame: it barely moves as the shark orbits, and
  // heightAt walks the whole crater list.
  private coastRadius(angle: number, dt: number): number {
    this.coastT -= dt
    if (this.coastT > 0) return this.coastCache
    this.coastT = 0.4
    // Start outside the island mass so a flooded crater inland can't pass for
    // the sea, and require the water to keep going — a pond is only a pond.
    for (let r = 50; r < ROAM_R; r += 3) {
      if (heightAt(Math.sin(angle) * r, Math.cos(angle) * r) > PATROL_DEPTH) continue
      if (heightAt(Math.sin(angle) * (r + 7), Math.cos(angle) * (r + 7)) > DEEP) continue
      this.coastCache = r + 5
      return this.coastCache
    }
    this.coastCache = PATROL_R
    return this.coastCache
  }

  // Land movement: no depth rules, no leash — just lurching surges timed to
  // the tail thrash. It's a fish. It is not built for this. That's the bit.
  private flop(desired: number, speed: number, dt: number): void {
    this.yaw += Math.max(-2.2 * dt, Math.min(2.2 * dt, wrapAngle(desired - this.yaw)))
    const surge = 0.3 + Math.abs(Math.sin(this.swimPhase * 1.9)) * 1.4
    this.pos.x += Math.sin(this.yaw) * speed * surge * dt
    this.pos.y += Math.cos(this.yaw) * speed * surge * dt
  }

  private steer(desired: number, speed: number, dt: number, turnRate: number): void {
    // Never beach itself, never leave the leash: shallow water ahead turns it
    // seaward, and the far edge turns it back toward the island.
    const look = 6
    const r = this.pos.length()
    if (heightAt(this.pos.x + Math.sin(desired) * look, this.pos.y + Math.cos(desired) * look) > DEEP) {
      desired = Math.atan2(this.pos.x, this.pos.y)
    } else if (r > ROAM_R) {
      desired = Math.atan2(-this.pos.x, -this.pos.y)
    }
    this.yaw += Math.max(-turnRate * dt, Math.min(turnRate * dt, wrapAngle(desired - this.yaw)))
    const nx = this.pos.x + Math.sin(this.yaw) * speed * dt
    const nz = this.pos.y + Math.cos(this.yaw) * speed * dt
    const hNew = heightAt(nx, nz)
    // Move if the water there is deep, or at least deeper than where it is.
    if (hNew <= DEEP || hNew < heightAt(this.pos.x, this.pos.y)) this.pos.set(nx, nz)
  }

  // --- per-frame --------------------------------------------------------

  update(dt: number, player: Player): void {
    this.sinceNet += dt
    // If the elected host isn't actually streaming — most likely it's a tab
    // running a build from before the shark existed, which happens every time
    // this ships — fall back to simulating privately rather than staring at a
    // shark frozen on its spawn point. Deliberately does NOT broadcast: two
    // clients taking over at once would fight, and a slightly desynced shark
    // beats an invisible one. Any real host state snaps us back in sync.
    const orphaned = !this.isHost && this.sinceNet > STALE_HOST

    if (this.isHost || orphaned) {
      this.simulate(dt, player, this.myId)
      this.sendT -= dt
      if (this.sendT <= 0 && !orphaned) {
        this.sendT = SEND_INTERVAL
        this.net.sendShark({
          x: this.pos.x,
          z: this.pos.y,
          ry: this.yaw,
          hp: this.hp,
          st: this.st,
          grab: this.grabId,
        })
      }
    } else {
      // Follow the host's stream. Snap on big jumps (respawns) so it doesn't
      // go skating across the map.
      const k = Math.min(1, 9 * dt)
      const jump = Math.hypot(this.netTarget.x - this.pos.x, this.netTarget.z - this.pos.y) > 30
      if (jump) this.pos.set(this.netTarget.x, this.netTarget.z)
      else this.pos.set(this.pos.x + (this.netTarget.x - this.pos.x) * k, this.pos.y + (this.netTarget.z - this.pos.y) * k)
      this.yaw += wrapAngle(this.netTarget.ry - this.yaw) * k
      if (this.st === 'dead') this.deadT -= dt
    }

    this.pose(dt)
    this.affectPlayer(dt, player)
  }

  private pose(dt: number): void {
    const dead = this.st === 'dead'
    const land = this.st === 'land'
    const speed = dead ? 0 : this.st === 'patrol' ? 1 : this.st === 'grab' ? 2.4 : land ? 2.8 : 2
    this.swimPhase += dt * (3 + speed * 2.5)

    if (dead) {
      // Belly up, drifting slowly to the surface, then sinking away.
      this.sinkY += dt
      this.rig.body.rotation.z += (Math.PI - this.rig.body.rotation.z) * Math.min(1, 3 * dt)
      const rise = Math.min(this.sinkY, 1.5) * 0.45 // rolls over and floats up
      const sink = Math.max(0, this.sinkY - 16) * 0.9 // then quietly goes under
      this.group.position.set(this.pos.x, SWIM_Y + 0.55 + rise - sink, this.pos.y)
      this.group.rotation.y = this.yaw
      this.rig.tail.rotation.y = Math.sin(this.swimPhase * 0.5) * 0.15
      this.rig.jaw.rotation.x = 0.5
      return
    }

    // Ashore: ride the terrain, hopping with each thrash of the tail.
    // Everyone computes the same y from the same synced ground, so this
    // never needs to cross the wire.
    const y = land
      ? Math.max(heightAt(this.pos.x, this.pos.y), 0) + 0.75 + Math.abs(Math.sin(this.swimPhase * 1.9)) * 0.5
      : SWIM_Y + Math.sin(this.swimPhase * 0.7) * 0.06
    this.group.position.set(this.pos.x, y, this.pos.y)
    this.group.rotation.y = this.yaw
    // Tail swings, body rolls a little into the turn — cheap "alive" tell.
    // On land the roll goes wild: it's throwing its whole body at the ground.
    this.rig.tail.rotation.y = Math.sin(this.swimPhase * 2) * (0.25 + speed * 0.12)
    this.rig.body.rotation.z = land ? Math.sin(this.swimPhase * 1.9) * 0.45 : Math.sin(this.swimPhase) * 0.07
    this.rig.body.rotation.x = Math.sin(this.swimPhase * 1.3) * 0.03
    // Gapes when it means business.
    const gape = this.st === 'grab' ? 0.35 : this.st === 'hunt' ? 0.45 : land ? 0.55 : 0.06
    this.rig.jaw.rotation.x += (gape - this.rig.jaw.rotation.x) * Math.min(1, 8 * dt)

    if (this.flash > 0) {
      this.flash -= dt
      this.rig.mat.emissive.setRGB(Math.max(0, this.flash) * 2.4, 0, 0)
    } else {
      this.rig.mat.emissive.setRGB(0, 0, 0)
    }
  }

  // Everything the shark does *to you* is decided here, on your own client —
  // same split as blast knockback. Nobody else's client can hurt you.
  private affectPlayer(dt: number, player: Player): void {
    this.mouth
      .set(Math.sin(this.yaw), 0, Math.cos(this.yaw))
      .multiplyScalar(2.2)
      .add(this.group.position)

    const flat = Math.hypot(player.group.position.x - this.mouth.x, player.group.position.z - this.mouth.z)
    // Latching needs us to actually be at its mouth; once latched we stay
    // latched, since from then on the shark is the thing moving us. Without
    // the range check a respawn mid-grab would yank us back out to sea.
    // Under rocket power you're out of reach, and it must not keep a latch it
    // already had — otherwise it tows the launch straight back into the sea.
    const down = player.dead || this.health.dead || player.flying
    let gotMe =
      this.grabId === this.myId && !down && (this.wasGrabbingMe || flat < GRAB_R + 3)

    if (gotMe) {
      // health.damage drives the shared HUD and announces our own death; we
      // just read `dead` back to know whether that bite was the last one.
      if (!this.wasGrabbingMe) {
        sfx.chomp()
        this.effects.spawnDebris(this.mouth, 0x8a1f1f, 10, 6)
        this.health.damage(CHOMP_DAMAGE)
      }
      if (!this.health.dead) {
        player.grabbed = true
        // Ride along in its jaws, dunked just under the surface.
        player.group.position.set(this.mouth.x, WATER_LEVEL - 0.45, this.mouth.z)
        player.group.rotation.y = this.yaw + Math.PI
        this.health.damage(DRAG_DPS * dt)
        if (Math.random() < dt * 3) sfx.thrash(0.6)
      }
      if (this.health.dead) {
        // Let go rather than towing the corpse out to sea for a frame.
        player.grabbed = false
        this.release()
        gotMe = false
      }
    } else {
      if (this.wasGrabbingMe) player.grabbed = false
      // Still has teeth between grabs: a pass close enough is a bite.
      if (this.biteCd > 0) this.biteCd -= dt
      const inWater =
        player.group.position.y <= WATER_LEVEL + 0.4 && heightAt(player.group.position.x, player.group.position.z) <= -1.15
      // On land its teeth work anywhere it can flop to — that's the raid.
      if (this.st !== 'dead' && !down && (inWater || this.st === 'land') && flat < BITE_R && this.biteCd <= 0) {
        this.biteCd = 1.5
        sfx.chomp()
        this.effects.spawnDebris(this.mouth, 0x8a1f1f, 8, 5)
        this.health.damage(BITE_DAMAGE)
        const away = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw))
        player.applyImpulse(away.x * 9, 5, away.z * 9)
      }
    }
    this.wasGrabbingMe = gotMe
    this.prompt.classList.toggle('show', gotMe)

    // The theme: silence when it's far or floating belly-up, frantic when
    // it's on top of you. Louder still while it's hunting someone.
    if (this.st === 'dead') {
      sfx.sharkTension(0)
      return
    }
    const d = player.group.position.distanceTo(this.group.position)
    let tension = Math.max(0, Math.min(1, (58 - d) / 52))
    if (this.st === 'patrol') tension *= 0.55
    if (gotMe) tension = 1
    sfx.sharkTension(tension * tension)
  }

  // Is the shark currently dragging the local player? main.ts shows a prompt.
  get draggingMe(): boolean {
    return this.wasGrabbingMe
  }
}
