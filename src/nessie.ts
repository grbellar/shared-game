import * as THREE from 'three'
import { heightAt, WATER_LEVEL } from './world'
import { sfx } from './audio'
import * as blocks from './blocks'
import { FIFTY_BLOCK_DAMAGE, FIFTY_LETHAL } from './fifty'
import { buildNessieHump, NESSIE_HUMPS, NESSIE_HUMP_SPACING } from './critters'
import type { Critters } from './critters'
import type { Effects } from './effects'
import type { Player } from './player'
import type { Building } from './building'
import type { Remotes } from './remotes'
import type { Net } from './net'
import type { Shark } from './shark'
import type { Mobs } from './mobs'
import type { Skeletons } from './skeletons'
import type { Trebuchet } from './trebuchet'
import type { Destruction } from './destruction'
import type { Stripper } from './stripper'
import type { Hud } from './hud'

// Nessie as a ride. The rider's character carries her lowered head (see
// buildNessieMount in character.ts) and streams position like any other ride,
// so this module owns everything that CAN'T sit on the character: the train
// of humps that follows each head along the path it actually took, the dirt
// and farts that keep time with the body wave, and what the local rider's
// head does to the world (the rampage) plus what other riders' heads do to us
// (the shove) and to Destiny (the trample). All of it is derived per client
// from streamed positions — riding her costs the network nothing beyond the
// `ride` field.

const HUMP_LEAD = 4.6 // head to the first hump, along the path
const SAMPLE = 0.6 // minimum travel before the path takes another point
const TRAIL_LEN = HUMP_LEAD + NESSIE_HUMPS * NESSIE_HUMP_SPACING + 4

const NESSIE_DAMAGE = 60 // a bite, not an execution — the fling is the point
const NESSIE_REACH = 3.4

const DIRT = 0x6b4526
const GAS = 0x86a34d

interface Rider {
  id: string
  group: THREE.Group
}

interface Trail {
  group: THREE.Group
  humps: THREE.Mesh[]
  pts: THREE.Vector3[] // oldest first; the head end is pts[pts.length - 1]
  prev: THREE.Vector3
  speed: number
  phase: number
  sprayIn: number
  splashIn: number
}

// Everything the local rider's head can chew on. killDuck/smashTrebuchet stay
// callbacks because the announcement (name, egg message) is main.ts wiring.
export interface NessieWorld {
  building: Building
  remotes: Remotes
  net: Net
  shark: Shark
  mobs: Mobs
  skeletons: Skeletons
  critters: Critters
  trebuchet: Trebuchet
  destruction: Destruction
  hud: Hud
  killDuck: () => void
  smashTrebuchet: () => void
}

export class NessieRide {
  private trails = new Map<string, Trail>()
  private bitAt = new Map<string, number>()
  private prevHead = new THREE.Vector3()
  private carve = 0
  private flungAt = 0

  constructor(
    private scene: THREE.Scene,
    private effects: Effects,
    private volumeAt: (pos: THREE.Vector3, range: number) => number,
    private deps: NessieWorld,
  ) {}

  mount(head: THREE.Vector3): void {
    this.prevHead.copy(head)
    this.bitAt.clear()
    this.carve = 0
  }

  // What the local rider's head does to the world this frame. Only the rider
  // mints damage (the usual mint-once rules).
  rampage(head: THREE.Vector3, now: number, digging: boolean): void {
    const { building, remotes, net, shark, mobs, skeletons, critters, trebuchet, destruction } =
      this.deps
    const moved = Math.min(head.distanceTo(this.prevHead), 3)
    this.prevHead.copy(head)

    // Built blocks (castle included) come apart outright, like the fifty.
    let broken = 0
    const cgx = Math.round(head.x / blocks.BLOCK)
    const cgy = Math.floor((head.y + 0.1) / blocks.BLOCK)
    const cgz = Math.round(head.z / blocks.BLOCK)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        // Four courses up from the (possibly buried) head, so a burrowed run
        // still clears the cell the rider's own head occupies — a surviving
        // top block would wall her off via the head-height check in wallAt.
        for (let dy = 0; dy <= 3 && broken < 14; dy++) {
          const gx = cgx + dx
          const gy = cgy + dy
          const gz = cgz + dz
          if (!blocks.blockAt(gx, gy, gz)) continue
          if (Math.hypot(gx * blocks.BLOCK - head.x, gz * blocks.BLOCK - head.z) > 2.7) continue
          building.hit(gx, gy, gz, FIFTY_BLOCK_DAMAGE)
          broken++
        }
      }
    }

    // Players in the path take a bite; the shove is theirs to self-apply
    // (see shove below), the same split as blast knockback.
    for (const { id, pos } of remotes.targets()) {
      const dx = pos.x - head.x
      const dz = pos.z - head.z
      if (dx * dx + dz * dz > NESSIE_REACH * NESSIE_REACH) continue
      if (Math.abs(pos.y - head.y) > 3.2) continue
      if (now - (this.bitAt.get(id) ?? 0) < 1200) continue
      this.bitAt.set(id, now)
      net.sendHit(id, NESSIE_DAMAGE)
      sfx.hitmark()
    }

    // Wildlife and the garrison die outright. Cats and Meckies are spared:
    // cats must never be moved, and the Meckies are family.
    const near = (pos: THREE.Vector3, r: number) =>
      Math.hypot(pos.x - head.x, pos.z - head.z) < r && Math.abs(pos.y - head.y) < 5
    for (const t of shark.targets()) if (near(t.pos, 4.5)) shark.shot(FIFTY_LETHAL)
    for (const t of mobs.targets()) if (near(t.pos, NESSIE_REACH)) mobs.shot(t.id, FIFTY_LETHAL)
    for (const t of skeletons.targets())
      if (near(t.pos, NESSIE_REACH)) skeletons.shot(t.id, FIFTY_LETHAL)
    const duck = critters.duckPosition
    if (duck && near(duck, NESSIE_REACH)) this.deps.killDuck()

    if (!trebuchet.isSmashed && near(trebuchet.base, 9)) this.deps.smashTrebuchet()

    // The furrow: real synced craters, throttled to one every few units so a
    // long rampage doesn't chew the room's crater cap at 60Hz, yet close
    // enough together to overlap into a continuous trench. Digging bites
    // deeper and more often; MAX_DIG (world.ts) caps how deep repeat passes
    // stack. Only while she's actually on the deck — a flying Nessie must
    // not strafe-mine the ground below her.
    const ground = heightAt(head.x, head.z)
    if (ground > 0.05 && head.y < ground + 1.5) {
      this.carve += moved
      if (this.carve > (digging ? 3.5 : 5.5)) {
        this.carve = 0
        destruction.bite(head.x, head.z, digging ? { r: 3.4, d: 3.8 } : { r: 2.9, d: 2.2 })
      }
    }
  }

  // Being in the way of somebody's Nessie: the damage arrives as the rider's
  // `hit`, but the shove is ours to self-apply, like all knockback.
  shove(player: Player, riders: Rider[], now: number): void {
    if (player.dead || player.flying || player.piloting || player.grabbed) return
    if (player.ride === 'nessie' || now - this.flungAt < 1000) return
    for (const { group } of riders) {
      if (player.group.position.distanceTo(group.position) > NESSIE_REACH) continue
      this.flungAt = now
      const away = player.group.position.clone().sub(group.position)
      away.y = 0
      if (away.lengthSq() < 0.01) away.set(0, 0, 1)
      away.normalize()
      player.applyImpulse(away.x * 17, 10, away.z * 17)
      break
    }
  }

  // Destiny is unsynced (each screen runs its own), so being run over can
  // only ever be per-client roadkill — see stripper.kill.
  trample(stripper: Stripper, riders: Rider[]): void {
    if (!stripper.alive) return
    for (const { group } of riders) {
      if (group.position.distanceTo(stripper.group.position) < 3) {
        stripper.kill(this.effects)
        sfx.scream(this.volumeAt(stripper.group.position, 70))
        this.deps.hud.feed('Destiny was consumed by the deep')
        break
      }
    }
  }

  // Every ridden Nessie's trailing body — ours and everyone else's.
  update(dt: number, riders: Rider[]): void {
    const seen = new Set<string>()
    for (const { id, group } of riders) {
      seen.add(id)
      const trail = this.trails.get(id) ?? this.create(id, group)
      this.step(dt, trail, group)
    }
    for (const [id, trail] of this.trails) {
      if (seen.has(id)) continue
      this.scene.remove(trail.group)
      for (const hump of trail.humps) hump.geometry.dispose()
      this.trails.delete(id)
    }
  }

  private create(id: string, group: THREE.Group): Trail {
    const trailGroup = new THREE.Group()
    const humps: THREE.Mesh[] = []
    for (let i = 0; i < NESSIE_HUMPS; i++) {
      const hump = buildNessieHump(i)
      humps.push(hump)
      trailGroup.add(hump)
    }
    this.scene.add(trailGroup)
    const trail: Trail = {
      group: trailGroup,
      humps,
      pts: [],
      prev: group.position.clone(),
      speed: 0,
      phase: 0,
      sprayIn: 0,
      splashIn: 0,
    }
    this.seed(trail, group)
    this.trails.set(id, trail)
    return trail
  }

  // Lay the path straight back behind the head, so a fresh mount (or a
  // teleport) has a body from the first frame instead of humps piled up
  // under the rider or strung across the map.
  private seed(trail: Trail, group: THREE.Group): void {
    const head = group.position
    const back = new THREE.Vector3(-Math.sin(group.rotation.y), 0, -Math.cos(group.rotation.y))
    trail.pts.length = 0
    for (let d = TRAIL_LEN; d > 0; d -= SAMPLE) {
      trail.pts.push(head.clone().addScaledVector(back, d))
    }
  }

  private step(dt: number, trail: Trail, group: THREE.Group): void {
    const head = group.position
    // A big jump is a teleport (a portal gate crossed mid-ride), not travel:
    // reseed behind the head, and don't let it spike the smoothed speed.
    if (head.distanceTo(trail.prev) > 40) {
      this.seed(trail, group)
      trail.prev.copy(head)
      trail.speed = 0
    }
    const raw = head.distanceTo(trail.prev) / Math.max(dt, 1e-6)
    trail.prev.copy(head)
    trail.speed += (raw - trail.speed) * Math.min(1, 8 * dt)

    const last = trail.pts[trail.pts.length - 1]
    if (head.distanceTo(last) > SAMPLE) trail.pts.push(head.clone())
    // Prune from the tail end once there's comfortably more path than body.
    let total = head.distanceTo(trail.pts[trail.pts.length - 1])
    for (let i = trail.pts.length - 1; i > 0; i--) {
      total += trail.pts[i].distanceTo(trail.pts[i - 1])
    }
    while (total > TRAIL_LEN + SAMPLE * 2 && trail.pts.length > 2) {
      total -= trail.pts[1].distanceTo(trail.pts[0])
      trail.pts.shift()
    }

    // The body wave, and the toots that keep its beat — three per wave
    // cycle, because the reference melody rips at ~2 blats a second and one
    // toot per cycle read as sluggish next to it.
    const prevPhase = trail.phase
    trail.phase += dt * (1.2 + trail.speed * 0.22)
    const beat = (Math.PI * 2) / 3
    if (Math.floor(trail.phase / beat) > Math.floor(prevPhase / beat) && trail.speed > 3.5) {
      sfx.fart(this.volumeAt(head, 90))
      const tail = trail.humps[NESSIE_HUMPS - 1].position
      this.effects.spawnDebris(tail.clone().add(new THREE.Vector3(0, 0.9, 0)), GAS, 3, 3)
    }

    this.placeHumps(trail, head)

    // Boring overland throws dirt off the snout; at sea she just wakes.
    // Airborne she throws nothing — the farts carry the show up there.
    const rawGround = heightAt(head.x, head.z)
    const headBase = Math.max(rawGround, WATER_LEVEL)
    if (trail.speed > 5 && head.y < headBase + 2) {
      trail.sprayIn -= dt
      trail.splashIn -= dt
      const overLand = rawGround > WATER_LEVEL + 0.05
      if (overLand && trail.sprayIn <= 0) {
        // Burrowed (head under grade) the surface boils: dirt fountains from
        // ground level, faster and taller than the surface-skimming spray.
        const buried = head.y < headBase - 0.3
        trail.sprayIn = buried ? 0.07 : 0.14
        this.effects.spawnDebris(
          new THREE.Vector3(head.x, headBase + 0.4, head.z),
          DIRT,
          buried ? 4 : 2,
          buried ? 7 : 5,
        )
      } else if (!overLand && trail.splashIn <= 0) {
        trail.splashIn = 0.35
        this.effects.spawnSplash(head.x, head.z)
      }
    }
  }

  // Walk the recorded path back from the head once, dropping each hump at its
  // distance as the walk passes it (the distances are ascending). Any humps
  // the path is still too short for pile up on the oldest point.
  private placeHumps(trail: Trail, head: THREE.Vector3): void {
    let humpI = 0
    let travelled = 0
    let cursor: THREE.Vector3 = head
    for (let i = trail.pts.length - 1; i >= 0 && humpI < NESSIE_HUMPS; i--) {
      const pt = trail.pts[i]
      const seg = cursor.distanceTo(pt)
      while (
        humpI < NESSIE_HUMPS &&
        seg > 1e-6 &&
        travelled + seg >= HUMP_LEAD + humpI * NESSIE_HUMP_SPACING
      ) {
        const target = HUMP_LEAD + humpI * NESSIE_HUMP_SPACING
        humpPoint.copy(cursor).lerp(pt, (target - travelled) / seg)
        this.placeHump(trail, humpI, humpPoint)
        humpI++
      }
      travelled += seg
      cursor = pt
    }
    for (; humpI < NESSIE_HUMPS; humpI++) this.placeHump(trail, humpI, cursor)
  }

  private placeHump(trail: Trail, i: number, p: THREE.Vector3): void {
    const base = Math.max(heightAt(p.x, p.z), WATER_LEVEL)
    // The path point carries the altitude the head actually passed through,
    // so when she flies the body serpentines through the air behind her;
    // on the deck p.y sits at the base and this collapses to ground-hug.
    trail.humps[i].position.set(
      p.x,
      Math.max(p.y, base) - 0.55 + Math.sin(trail.phase - i * 0.85) * 0.5,
      p.z,
    )
  }
}

const humpPoint = new THREE.Vector3()
