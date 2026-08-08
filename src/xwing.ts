import * as THREE from 'three'
import { heightAt, WATER_LEVEL } from './world'
import { wallAt } from './blocks'
import { sfx } from './audio'

// An X-wing you climb into and fly around the map.
//
// It is a *ride* (`ride: 'xwing'` in PlayerState), which is what makes the
// multiplayer side almost free: the model, the seated pilot and the loadout
// all come along on the existing `ride` field, and your position already
// streams ~15x/sec, so remotes watch the whole flight without a single new
// message. Two things a walking game never needed do get synced — pitch and
// roll (`rx`/`rz` in PlayerState) — because a fighter that banks flat through
// a turn on everyone else's screen looks broken.
//
// Everything else is derived, in the spirit of the rest of the world:
// whether a ship's S-foils are open, whether its engines are lit, and how hard
// they're glowing all fall out of where the ship is and how fast it's moving,
// which every client already knows. See `airborneAt`.
//
// Flight is arcade, not a simulator. Thrust is automatic once you're up, you
// bank to turn, and the only way to fall out of the sky is to fly into
// something.

// --- flight envelope ---
const CRUISE = 40 // hands-off airspeed
const BOOST = 88 // ...and with the throttle firewalled
const SLOW = 15 // ...and on the brakes; also slow enough to set down
const ACCEL = 32 // how fast the throttle actually gets you there
const PITCH_RATE = 1.35 // rad/s of stick authority
const ROLL_RATE = 2.8
const PITCH_LIMIT = 1.1 // no loops — 63° up or down is plenty and stays legible
const ROLL_LIMIT = 1.25
const LEVEL_RATE = 1.6 // roll bleeds back to level when you let go
const TURN_K = 1.15 // how hard a bank pulls the nose around
const SAG = 9 // lift you lose for flying slower than cruise
const TAKEOFF_S = 1.1 // repulsorlift hop before the engines take over
const TAKEOFF_H = 9 // ...and how high it puts you
const BELLY = 1.1 // ground clearance of the hull, in player-space units
const CRASH_SPEED = 30 // touch down faster than this and it's a crash
const CEILING = 260 // stop climbing before the sky sphere does anything odd
const FOG_GAIN = 4.5 // fog opens up with altitude, exactly like rocket.ts

// Above this much clearance a ship counts as flying — for its own client and,
// just as importantly, for everyone else's, who work it out from the position
// stream rather than being told. Terrain height is deterministic, so nobody
// disagrees about whether your S-foils are open.
export function airborneAt(x: number, y: number, z: number): boolean {
  return y > Math.max(heightAt(x, z), WATER_LEVEL) + 2.2
}

export interface XWingInput {
  pitch: number // -1 nose down .. +1 nose up
  roll: number // -1 left .. +1 right
  boost: boolean
  brake: boolean
}

export type CrashKind = 'ground' | 'water'

export class XWingFlight {
  // Set down in one piece; main.ts parks you back on the skids.
  onTouchdown: () => void = () => {}
  // Flew into something. 'water' is a soft ditching (a splash and a swim),
  // 'ground' is the fireball.
  onCrash: (pos: THREE.Vector3, kind: CrashKind) => void = () => {}
  private flying = false
  private speed = 0
  private pitch = 0
  private roll = 0
  private takeoffT = -1
  private takeoffY = 0
  private baseFogFar = 150
  private engineT = 0

  constructor(private scene: THREE.Scene) {}

  get airborne(): boolean {
    return this.flying
  }

  // 0..1, for the exhaust glow and the engine note.
  get throttle(): number {
    return Math.max(0, Math.min(1, (this.speed - SLOW) / (BOOST - SLOW)))
  }

  // Light the engines. The hop off the ground is scripted (you can't steer
  // for the first second) so a takeoff always looks like a takeoff.
  takeoff(group: THREE.Group): void {
    if (this.flying) return
    this.flying = true
    this.speed = SLOW
    this.pitch = 0
    this.roll = 0
    this.takeoffT = 0
    this.takeoffY = group.position.y
    const fog = this.scene.fog as THREE.Fog | null
    // Captured before we start driving it and put back on the way down —
    // the same borrow rocket.ts makes, which is why main.ts never lets the
    // two own the fog at once.
    this.baseFogFar = fog ? fog.far : 150
    sfx.xwingStart()
  }

  update(dt: number, input: XWingInput, group: THREE.Group): void {
    if (!this.flying) return
    const pos = group.position

    // The scripted hop: straight up, nose level, engines spooling.
    if (this.takeoffT >= 0) {
      this.takeoffT += dt
      const u = Math.min(1, this.takeoffT / TAKEOFF_S)
      pos.y = this.takeoffY + TAKEOFF_H * (1 - (1 - u) * (1 - u))
      this.speed = SLOW + (CRUISE - SLOW) * u
      group.rotation.x = 0
      group.rotation.z = 0
      this.engine(dt, pos)
      if (u >= 1) this.takeoffT = -1
      return
    }

    // Stick. Roll is held where you put it and bleeds back to level when you
    // let go; pitch is the same, minus the self-levelling, so you can hold a
    // climb without holding the key.
    this.roll = clamp(this.roll + input.roll * ROLL_RATE * dt, -ROLL_LIMIT, ROLL_LIMIT)
    if (Math.abs(input.roll) < 0.05) this.roll -= this.roll * Math.min(1, LEVEL_RATE * dt)
    this.pitch = clamp(this.pitch + input.pitch * PITCH_RATE * dt, -PITCH_LIMIT, PITCH_LIMIT)

    // Throttle: hands off settles at cruise, boost and brake pull it either way.
    const want = input.boost ? BOOST : input.brake ? SLOW : CRUISE
    this.speed += clamp(want - this.speed, -ACCEL * dt, ACCEL * dt)

    // Bank to turn — the only way to change heading, which is what makes it
    // fly like a fighter instead of a floating camera.
    group.rotation.y -= Math.sin(this.roll) * TURN_K * dt * (0.5 + 0.5 * (this.speed / CRUISE))
    group.rotation.x = this.pitch
    group.rotation.z = this.roll

    // Velocity is simply "along the nose", plus a sag that punishes flying
    // slow. No stall model, no angle of attack — this is a toy.
    const cp = Math.cos(this.pitch)
    const ry = group.rotation.y
    const step = this.speed * dt
    const nx = Math.sin(ry) * cp * step
    const nz = Math.cos(ry) * cp * step
    const ny = Math.sin(this.pitch) * step - SAG * (1 - Math.min(1, this.speed / CRUISE)) * dt

    // Blocks are solid at any speed: the castle should end a bad approach.
    const nextX = pos.x + nx
    const nextZ = pos.z + nz
    const nextY = pos.y + ny
    if (wallAt(nextX, nextZ, nextY - BELLY)) {
      this.crash(group, 'ground')
      return
    }
    pos.set(nextX, Math.min(nextY, CEILING), nextZ)

    // Ground and sea. Both end the flight; only one of them hurts.
    const ground = heightAt(pos.x, pos.z)
    const floor = Math.max(ground, WATER_LEVEL)
    if (pos.y - BELLY <= floor) {
      pos.y = floor + BELLY
      const ditching = ground < WATER_LEVEL
      if (ditching) this.crash(group, 'water')
      else if (this.speed > CRASH_SPEED || Math.abs(this.roll) > 0.9) this.crash(group, 'ground')
      else this.settle(group)
      return
    }

    this.engine(dt, pos)
  }

  // Forced out of the cockpit: killed, grabbed, rocketed, or just dismounted
  // mid-air. Hands the player back with the ship's attitude wiped.
  stop(group: THREE.Group): void {
    if (!this.flying) return
    this.flying = false
    this.takeoffT = -1
    this.speed = 0
    this.pitch = this.roll = 0
    group.rotation.x = 0
    group.rotation.z = 0
    const fog = this.scene.fog as THREE.Fog | null
    if (fog) fog.far = this.baseFogFar
  }

  // Both endings leave the ship hovering one belly-height off the deck and
  // hand it straight back to the player's own gravity, which drops it onto
  // its skids over a frame or two instead of snapping it down.
  private settle(group: THREE.Group): void {
    const hard = this.speed > SLOW + 6
    this.stop(group)
    sfx.xwingDown(hard ? 1 : 0.45)
    this.onTouchdown()
  }

  private crash(group: THREE.Group, kind: CrashKind): void {
    const pos = group.position.clone()
    this.stop(group)
    this.onCrash(pos, kind)
  }

  // Engine note and the fog window, both a function of how hard we're pushing
  // and how high we've got.
  private engine(dt: number, pos: THREE.Vector3): void {
    this.engineT -= dt
    if (this.engineT <= 0) {
      this.engineT = 0.16
      sfx.xwingEngine(this.throttle)
    }
    const fog = this.scene.fog as THREE.Fog | null
    // From up here you can see both islands at once — the same trick rocket
    // travel plays, and the reason a flight across the ocean isn't a grey wall.
    if (fog) fog.far = this.baseFogFar + Math.max(0, pos.y - 20) * FOG_GAIN
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// --- the ship ---

const HULL = 0xd8d4c6 // sun-bleached Incom white
const PANEL = 0x5b6069
const STRIPE = 0xb83a32 // Red Squadron
const GLASS = 0x1d2b3f
const GUNMETAL = 0x33363c

// Built facing +Z like everything else in character.ts, and sized so the
// pilot's torso ends up inside the fuselage and their head inside the canopy
// (the character group's origin is at their feet). Returned with the S-foil
// pivots and exhaust discs in userData so animateCharacter can open the wings
// and pump the glow.
export function buildXWing(): THREE.Group {
  const ship = new THREE.Group()
  ship.name = 'ride'
  const hull = new THREE.MeshLambertMaterial({ color: HULL, flatShading: true })
  const panel = new THREE.MeshLambertMaterial({ color: PANEL, flatShading: true })
  const stripe = new THREE.MeshLambertMaterial({ color: STRIPE, flatShading: true })
  const metal = new THREE.MeshLambertMaterial({ color: GUNMETAL, flatShading: true })
  const glass = new THREE.MeshLambertMaterial({ color: GLASS, flatShading: true })
  const along = (geo: THREE.CylinderGeometry) => geo.rotateX(Math.PI / 2) // +Y -> +Z

  // Wide and deep enough to actually swallow the pilot: their shoulders sit
  // at ±0.66 and their seated legs drop to y≈0.56, and anything narrower
  // leaves elbows and knees sticking out through the hull.
  const fuselage = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.25, 4.4), hull)
  fuselage.position.set(0, 1.1, -0.4)
  // The long tapered snout, six-sided so it facets instead of reading round.
  const nose = new THREE.Mesh(along(new THREE.CylinderGeometry(0.14, 0.62, 2.6, 6)), hull)
  nose.position.set(0, 1.1, 3.1)
  const noseStripe = new THREE.Mesh(along(new THREE.CylinderGeometry(0.46, 0.54, 0.3, 6)), stripe)
  noseStripe.position.set(0, 1.1, 2.6)
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 3.4), panel)
  spine.position.set(0, 1.72, -0.9)
  ship.add(fuselage, nose, noseStripe, spine)

  // Canopy over the pilot's head (which sits at y≈1.95), then R2 behind it.
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.72, 1.5), glass)
  canopy.position.set(0, 2.0, 0.55)
  const canopyFront = new THREE.Mesh(along(new THREE.CylinderGeometry(0.1, 0.42, 0.8, 4)), glass)
  canopyFront.position.set(0, 1.94, 1.6)
  canopyFront.rotation.z = Math.PI / 4
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.08), metal)
  frame.position.set(0, 2.36, 0.55)
  ship.add(canopy, canopyFront, frame)
  ship.add(buildAstromech())

  // Four skids, so a parked fighter stands on something.
  for (const sx of [-1, 1]) {
    for (const sz of [1.4, -1.6]) {
      const skid = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.62, 0.12), metal)
      skid.position.set(sx * 0.36, 0.35, sz)
      ship.add(skid)
    }
  }

  // The S-foils. Each is a pivot at the tail that the wing hangs off, so
  // rotating the pivot about Z fans the pair open into the X. Engines and
  // cannons are children of the wing and swing with it.
  const foils: THREE.Group[] = []
  const glow: THREE.Mesh[] = []
  for (const side of [-1, 1]) {
    for (const half of [1, -1]) {
      const pivot = new THREE.Group()
      pivot.position.set(side * 0.42, 1.15, -1.5)
      // Sign convention: for the right-hand pair (+X) a positive Z rotation
      // lifts the wing; for the left-hand pair it drops it. `half` picks the
      // upper or lower wing, `side` corrects for which way the wing points.
      pivot.userData.fan = side * half
      const wing = buildFoil(side, hull, panel, stripe, metal, glow, along)
      pivot.add(wing)
      ship.add(pivot)
      foils.push(pivot)
    }
  }

  ship.userData.foils = foils
  ship.userData.glow = glow
  return ship
}

// One wing, with its engine nacelle and its wingtip cannon. Built pointing
// along `side` (+1 right, -1 left) from the pivot at the origin.
function buildFoil(
  side: number,
  hull: THREE.Material,
  panel: THREE.Material,
  stripe: THREE.Material,
  metal: THREE.Material,
  glow: THREE.Mesh[],
  along: (geo: THREE.CylinderGeometry) => THREE.CylinderGeometry,
): THREE.Group {
  const wing = new THREE.Group()
  const blade = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.14, 1.5), hull)
  blade.position.set(side * 2.0, 0, 0.15)
  const flash = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.7), stripe)
  flash.position.set(side * 3.1, 0.01, 0.3)
  wing.add(blade, flash)

  // Engine: intake up front, a body, and an exhaust disc that glows.
  const nacelle = new THREE.Mesh(along(new THREE.CylinderGeometry(0.36, 0.36, 1.9, 8)), panel)
  nacelle.position.set(side * 1.05, 0.05, -0.1)
  const intake = new THREE.Mesh(along(new THREE.CylinderGeometry(0.3, 0.38, 0.4, 8)), metal)
  intake.position.set(side * 1.05, 0.05, 0.95)
  // Emissive so the engines read as lit at 320x240 without a bloom pass, and
  // flared wider than the nacelle it hangs off — tucked inside its own engine
  // (which is where it started) the glow is invisible from every angle.
  const exhaust = new THREE.Mesh(
    along(new THREE.CylinderGeometry(0.3, 0.42, 0.5, 8)),
    new THREE.MeshLambertMaterial({ color: 0xff6a24, emissive: 0xff4a10, flatShading: true }),
  )
  exhaust.position.set(side * 1.05, 0.05, -1.32)
  glow.push(exhaust)
  wing.add(nacelle, intake, exhaust)

  // Wingtip cannon, reaching well past the nose the way they should.
  const barrel = new THREE.Mesh(along(new THREE.CylinderGeometry(0.09, 0.09, 3.6, 6)), metal)
  barrel.position.set(side * 3.55, 0, 1.9)
  const tip = new THREE.Mesh(along(new THREE.CylinderGeometry(0.07, 0.11, 0.35, 6)), stripe)
  tip.position.set(side * 3.55, 0, 3.75)
  wing.add(barrel, tip)
  return wing
}

// The astromech in the socket behind the cockpit: a stubby white can with a
// domed head and one big blue eye. Three boxes and a half-sphere.
function buildAstromech(): THREE.Group {
  const r2 = new THREE.Group()
  const shell = new THREE.MeshLambertMaterial({ color: 0xe8e8e4, flatShading: true })
  const blue = new THREE.MeshLambertMaterial({ color: 0x3f6fd0, flatShading: true })
  const dark = new THREE.MeshLambertMaterial({ color: 0x1e2026, flatShading: true })

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.5, 8), shell)
  body.position.set(0, 2.0, -0.6)
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
    shell,
  )
  dome.position.set(0, 2.24, -0.6)
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.12, 0.12), blue)
  band.position.set(0, 2.3, -0.31)
  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.06), dark)
  eye.position.set(0, 2.42, -0.3)
  r2.add(body, dome, band, eye)
  return r2
}

// Open (or close) the S-foils and pump the exhausts. Driven from
// animateCharacter with an eased 0..1, so remote ships do it too — off the
// altitude everyone can already work out, not off a message.
export function poseXWing(ship: THREE.Group, open: number, glowLevel: number): void {
  const foils = ship.userData.foils as THREE.Group[] | undefined
  if (foils) {
    // Cruise sits the pair almost flat against each other; attack position
    // fans them into the X the ship is named after.
    const angle = 0.06 + 0.42 * open
    for (const pivot of foils) pivot.rotation.z = angle * (pivot.userData.fan as number)
  }
  const glow = ship.userData.glow as THREE.Mesh[] | undefined
  if (glow) {
    // The flame stretches out the back with the throttle. Scaling on Z alone
    // grows it both ways from the disc's centre, which is close enough to a
    // tail of fire once the nacelle hides the front half.
    const s = 0.6 + 1.6 * glowLevel
    for (const disc of glow) {
      disc.scale.set(1, 1, s)
      const mat = disc.material as THREE.MeshLambertMaterial
      mat.emissiveIntensity = 0.5 + 1.5 * glowLevel
    }
  }
}
