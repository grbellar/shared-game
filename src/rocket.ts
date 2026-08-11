import * as THREE from 'three'
import { heightAt, ISLANDS, landingSpotOn, nearestIsland } from './world'
import { REALM_X, REALM_Z, inRealm } from './realm'
import { WICHITA_X, WICHITA_Z, inWichita } from './wichita'
import { inOz, ozArrival } from './oz'
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
    // Regions first: neither the realm nor Wichita is near any island, but
    // nearestIsland still has to answer something, and it would claim you're
    // on home while you're standing in the middle of Douglas Ave.
    here: (x: number, z: number) =>
      !inRealm(x, z) && !inWichita(x, z) && !inOz(x, z) && nearestIsland(x, z) === i,
    spot: () => landingSpotOn(i),
  })),
  { name: 'the castle', icon: '🏰', here: inRealm, spot: realmPad },
  { name: 'wichita', icon: '🌾', here: inWichita, spot: wichitaPad },
  // The scenic route is a Kansas twister (tornado.ts); this is the direct
  // flight. Sets down by the Munchkin village, where the road starts.
  { name: 'oz', icon: '🌪️', here: inOz, spot: ozArrival },
]

// Down on the apron: clear of the castle curtain (33 units from centre) and
// well inside the plateau's flat (88), so a trip never drops you onto a
// battlement or into the lava.
function realmPad(): { x: number; z: number } {
  const a = Math.random() * Math.PI * 2
  const r = 46 + Math.random() * 30
  return { x: REALM_X + Math.cos(a) * r, z: REALM_Z + Math.sin(a) * r }
}

// Douglas Ave in Old Town, on the stretch between the arcade (local 1055,
// 10, marquee facing the street) and the theater across from it — you land
// in the middle of the entertainment district instead of a kilometer of
// sidewalk west of it. Scatter along the street, not across it: the arcade's
// front wall sits at local z=0 and the theater's at z=-39, so the strip
// between stays clear of both. The buildings aren't solid, but arriving
// inside one is a bad first impression.
function wichitaPad(): { x: number; z: number } {
  return {
    x: WICHITA_X + 1042 + (Math.random() - 0.5) * 50,
    z: WICHITA_Z - 18 + (Math.random() - 0.5) * 10,
  }
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
  private altitude = 0
  private trailT = 0

  constructor(private effects: Effects) {}

  get active(): boolean {
    return this.t >= 0
  }

  // How far to push the fog wall back this frame, on top of whatever the world
  // and the clock already want. Handed to daynight.update rather than written
  // onto the fog directly — daynight runs at the end of the frame and rewrites
  // fog.far unconditionally, so anything set here would never survive to be
  // drawn. From the top of the arc this is worth ~1800 units of visibility,
  // which is the one moment in the game you can see the whole world at once.
  get fogLift(): number {
    if (this.t < 0) return 0
    return Math.max(0, this.altitude - 20) * 4.5
  }

  // Returns false if you're in no state to be launched — already flying, dead,
  // in a shark's mouth (it would just tow you back), or strapped into the
  // trebuchet, which owns your position for exactly the same reason we would.
  launch(player: Player, dest: RocketDest): boolean {
    if (this.t >= 0 || player.dead || player.grabbed || player.flying) return false
    this.from.copy(player.group.position)
    this.to.set(dest.x, dest.z)
    this.followId = dest.followId ?? null
    // The further you're going, the higher you throw it. A hop across the
    // island wants ~96; the castle is 1800 units away, and at a fixed 96 that
    // trip is a flat skim through the fog rather than an arc over it.
    const reach = Math.hypot(this.to.x - this.from.x, this.to.y - this.from.z)
    this.apexY = Math.max(this.from.y, this.groundAtTarget()) + APEX + reach * 0.18
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
    this.altitude = y

    // Point the way we're going, so the dive reads as aimed at something.
    const dx = this.to.x - this.from.x
    const dz = this.to.y - this.from.z
    if (dx * dx + dz * dz > 1) player.group.rotation.y = Math.atan2(dx, dz)

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

  // Always runs, landing or abort: hand back control. The fog needs no
  // undoing — fogLift reads zero the moment this.t goes negative, and daynight
  // writes the ordinary distance on its very next pass.
  private finish(player: Player): void {
    this.t = -1
    this.altitude = 0
    this.followId = null
    player.flying = false
  }
}
