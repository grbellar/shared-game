import * as THREE from 'three'
import { heightAt, ISLANDS, landingSpotOn, nearestIsland } from './world'
import { REALM_X, REALM_Z, inRealm } from './realm'
import { WATER_LEVEL, type Player } from './player'
import { ROCKET_ASCENT_S, ROCKET_DESCENT_S, ROCKET_FLIGHT_S } from './emotes'
import type { Effects } from './effects'
import { sfx } from './audio'

// Rocket travel: strap a rocket to the chair, go up until the island is a
// smudge, come down on top of whatever you aimed at. Used for both trips the
// map offers — "take me to the other island" and "take me to that friend".
//
// The flight itself sends NOTHING. Your position already streams ~15x/sec and
// the pose rides in PlayerState.emote, so remotes watch you climb, hang, and
// dive for free. Only the touchdown gets a message ('land'), because the bang
// has to happen on the same frame everywhere and 66ms of state lag would put
// the dust in the wrong place. Same split as `fire`: everybody plays the show,
// everybody shoves only themselves, and the traveller alone mints the crater.

const APEX = 96 // metres above the higher end of the trip
const HOMING = 1.8 // how hard the aim point chases a friend who wanders off

// The landing blast. Weaker than a rocket (75) — being someone's landing pad
// should hurt and should launch you, but it shouldn't usually be a beheading.
export const LAND_BLAST_RADIUS = 8
export const LAND_BLAST_DAMAGE = 35

// Everywhere rocket travel can take you. The islands come straight out of
// world.ts; the shadow realm isn't an island at all (it's a region that owns
// its own heightfield) so it brings its own arrival pad. The map builds its
// buttons off this list, so anything added here is immediately travellable.
export interface Destination {
  name: string
  icon: string
  // Are we standing on this one right now? The map hides the place you are.
  here: (x: number, z: number) => boolean
  spot: () => { x: number; z: number }
}

export const DESTINATIONS: Destination[] = [
  ...ISLANDS.map((isl, i) => ({
    name: isl.name,
    icon: '🚀',
    // inRealm first: the realm is nearer to no island, but nearestIsland
    // still has to answer something, and it would claim you're on the rock.
    here: (x: number, z: number) => !inRealm(x, z) && nearestIsland(x, z) === i,
    spot: () => landingSpotOn(i),
  })),
  { name: 'the castle', icon: '🏰', here: inRealm, spot: realmPad },
]

// Down on the apron: clear of the castle curtain (33 units from centre) and
// well inside the plateau's flat (88), so a trip never drops you onto a
// battlement or into the lava.
function realmPad(): { x: number; z: number } {
  const a = Math.random() * Math.PI * 2
  const r = 46 + Math.random() * 30
  return { x: REALM_X + Math.cos(a) * r, z: REALM_Z + Math.sin(a) * r }
}

export interface RocketDest {
  x: number
  z: number
  // Chasing a player: their live position keeps tugging the aim point over
  // the four seconds you're in the air, so a friend who strolls away while
  // you're at apogee still gets landed on.
  followId?: string
}

export class RocketRide {
  // Fired the instant we leave the ground — main.ts poses us and mounts the
  // chair. Landing hands back the impact point; main.ts owns everything that
  // happens to the world there.
  onLaunch: () => void = () => {}
  onLand: (pos: THREE.Vector3) => void = () => {}
  // Where a player we're following is right now, or undefined if they left.
  livePos: (id: string) => THREE.Vector3 | undefined = () => undefined
  private t = -1
  private from = new THREE.Vector3()
  private to = new THREE.Vector2() // (x, z) of the aim point
  private followId: string | null = null
  private apexY = 0
  private baseFogFar = 150
  private trailT = 0

  constructor(
    private scene: THREE.Scene,
    private effects: Effects,
  ) {}

  get active(): boolean {
    return this.t >= 0
  }

  // Returns false if you're in no state to be launched — already flying, dead,
  // or in a shark's mouth (it would just tow you back).
  launch(player: Player, dest: RocketDest): boolean {
    if (this.t >= 0 || player.dead || player.grabbed) return false
    this.from.copy(player.group.position)
    this.to.set(dest.x, dest.z)
    this.followId = dest.followId ?? null
    // The further you're going, the higher you throw it. A hop across the
    // island wants ~96; the castle is 1800 units away, and at a fixed 96 that
    // trip is a flat skim through the fog rather than an arc over it.
    const reach = Math.hypot(this.to.x - this.from.x, this.to.y - this.from.z)
    this.apexY = Math.max(this.from.y, this.groundAtTarget()) + APEX + reach * 0.18
    const fog = this.scene.fog as THREE.Fog | null
    // Captured before we start driving it, and put back on landing — this is
    // the only thing in the game that touches fog distance, and daynight.ts
    // only ever writes fog colour, so the two never fight.
    this.baseFogFar = fog ? fog.far : 150
    this.t = 0
    this.trailT = 0
    player.flying = true
    sfx.rocketLaunch()
    this.onLaunch()
    return true
  }

  update(dt: number, player: Player): void {
    if (this.t < 0) return
    // Killed mid-flight (a stray rocket, the shark's last bite landing late):
    // drop the whole trip. player.die() is already respawning us on the ground.
    if (player.dead) {
      this.finish(player)
      return
    }
    this.t += dt

    if (this.followId) {
      const live = this.livePos(this.followId)
      if (live) {
        const k = Math.min(1, HOMING * dt)
        this.to.x += (live.x - this.to.x) * k
        this.to.y += (live.z - this.to.y) * k
      }
    }

    const t = Math.min(this.t, ROCKET_FLIGHT_S)
    // Ease the ground track in and out so you hang at the top of the arc
    // rather than sliding sideways at a constant clip the whole way.
    const p = t / ROCKET_FLIGHT_S
    const ease = p * p * (3 - 2 * p)
    const x = this.from.x + (this.to.x - this.from.x) * ease
    const z = this.from.z + (this.to.y - this.from.z) * ease

    let y: number
    if (t < ROCKET_ASCENT_S) {
      // Boost: fast off the pad, easing off as the motor burns out.
      const u = t / ROCKET_ASCENT_S
      y = this.from.y + (this.apexY - this.from.y) * (1 - (1 - u) * (1 - u))
    } else {
      // Ballistic the rest of the way down.
      const v = (t - ROCKET_ASCENT_S) / ROCKET_DESCENT_S
      y = this.apexY - (this.apexY - this.groundAtTarget()) * v * v
    }
    player.group.position.set(x, y, z)

    // Point the way we're going, so the dive reads as aimed at something.
    const dx = this.to.x - this.from.x
    const dz = this.to.y - this.from.z
    if (dx * dx + dz * dz > 1) player.group.rotation.y = Math.atan2(dx, dz)

    // The fog wall opens up with altitude and closes again on the way down:
    // from the top of the arc you can actually see both islands at once, which
    // is the only place in the game you ever can.
    const fog = this.scene.fog as THREE.Fog | null
    if (fog) fog.far = this.baseFogFar + Math.max(0, y - 20) * 4.5

    this.trailT -= dt
    if (this.trailT <= 0) {
      this.trailT = 0.04
      this.effects.spawnTrail(player.group.position)
    }

    if (this.t >= ROCKET_FLIGHT_S) {
      // Set down on whatever's actually there — the aim point may have chased
      // a friend uphill since launch, and water counts as a floor.
      const pos = player.group.position.clone()
      pos.y = this.groundAtTarget()
      player.group.position.copy(pos)
      this.finish(player)
      this.onLand(pos)
    }
  }

  private groundAtTarget(): number {
    return Math.max(heightAt(this.to.x, this.to.y), WATER_LEVEL)
  }

  // Always runs, landing or abort: hand back control and put the fog back.
  private finish(player: Player): void {
    this.t = -1
    this.followId = null
    player.flying = false
    const fog = this.scene.fog as THREE.Fog | null
    if (fog) fog.far = this.baseFogFar
  }
}
