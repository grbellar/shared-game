import * as THREE from 'three'
import { baseHeightAt, heightAt } from './world'
import { blockFloorAt } from './blocks'
import { GRAVITY, WATER_LEVEL, type Player } from './player'
import type { Effects } from './effects'
import { sfx } from './audio'

// A siege engine parked on the shelf north-west of the hill. Walk into the
// sling, steer it with A/D, and hit space to be thrown fifty metres into the
// air and a hundred across the island.
//
// It sends NOTHING of its own. The rider's pose already rides in
// PlayerState.emote (see emotes.ts), so 'slingride' tells every client who is
// sitting in the basket — and the frame aims itself off that player's streamed
// facing — while the flip to 'slung' IS the fire event: remotes start the
// swing on the same transition that starts the flight, so the arm and the body
// leaving it can never disagree. The only message in the whole feature is the
// `land` the touchdown already shares with rocket travel.
//
// Consequence worth knowing: a client that joins mid-flight sees 'slung' as
// somebody's first state and plays one swing of an arm that has already fired.
// Cheaper than a protocol message for a machine that is idle 99% of the time.

// Where it stands. Flat (0.7 units of fall over a 14-unit span), 12 clear of
// the nearest tree, and a walk from the gate on the central hill.
const BASE_X = -15
const BASE_Z = 45

// --- the frame, in local space; +Z is the way it throws ---
const AXLE_Y = 7.6
const ARM_LONG = 7.6 // axle to the sling end
const ARM_SHORT = 2.4 // axle to the counterweight
const SLING = 3.4
const POUCH_Y = 0.75 // basket height when it's resting on the ground
const POUCH_R = ARM_LONG + SLING // pouch radius once the sling snaps in line

// --- the swing ---
// Cocked: the long end is hauled down and forward, so the basket lies on the
// ground in front of the frame and the counterweight is up and back.
const ARM_COCKED = 2.44
const ARM_SPENT = -0.6 // where it slams to a stop, past vertical and leaning back
const SWEEP = ARM_COCKED - ARM_SPENT
const SWING_S = 0.5
const EASE_P = 1.75 // the counterweight accelerates; the arm must not move linearly
// Near vertical, and that's deliberate. The pouch leaves on a tangent —
// velocity is (sin a, -cos a) in the (up, forward) plane — so the release
// angle picks the launch angle outright, and a flatter one is a trap: the
// island's dry land only reaches ~65 units out, so a 65-degree throw at this
// speed puts EVERY shot in the sea whatever you aim at (measured, not
// guessed). 82 degrees keeps the height, halves the range, and hands the
// choice back to whoever is steering.
const LAUNCH_ELEVATION = 1.4312 // 82 degrees
// Releasing past vertical (a < pi/2) would throw you backwards over the frame.
const RELEASE_A = Math.PI - LAUNCH_ELEVATION
const RELEASE_U = Math.pow((ARM_COCKED - RELEASE_A) / SWEEP, 1 / EASE_P)
// How fast the basket is actually travelling at that instant: the derivative
// of the very easing the arm is drawn with, times the pouch's radius. Deriving
// it rather than picking a number means the throw can never be faster or
// slower than it looks.
const LAUNCH_SPEED = ((SWEEP * EASE_P * Math.pow(RELEASE_U, EASE_P - 1)) / SWING_S) * POUCH_R

// The whole cycle after the trigger: a beat of held breath, the swing, the
// frame rocking itself still, then the winch hauling it back down.
const HOLD_S = 0.12
const SETTLE_S = 1.7
const WINCH_S = 3.4
const T_SWING0 = HOLD_S
const T_SWING1 = HOLD_S + SWING_S
const T_RELEASE = T_SWING0 + RELEASE_U * SWING_S
const T_SETTLE1 = T_SWING1 + SETTLE_S
const T_READY = T_SETTLE1 + WINCH_S

const BOARD_R = 2.6 // how close to the basket counts as climbing in
const RATCHET_S = 0.17 // one pawl click per notch while it winches
// Long enough that stepping out of the basket doesn't drop you straight back
// into it, since you climb out standing right next to the thing.
const BOARD_COOLDOWN = 1.2

const timber = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true })

// A box of length `len` running along +Y from its own origin — every beam in
// the frame is one of these, rotated into place.
function beam(w: number, len: number, d: number, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, len, d)
  geo.translate(0, len / 2, 0)
  return new THREE.Mesh(geo, mat)
}

export class Trebuchet {
  // Latched into the basket. main.ts poses you and stops you being able to
  // walk out of your own shot.
  onBoard: () => void = () => {}
  // The sling has let go and you are a projectile.
  onThrow: () => void = () => {}
  // Climbed back out. Without this the braced pose sticks: nothing cancels an
  // emote while you stand still, and standing still is exactly what you do
  // after stepping out of a basket.
  onExit: () => void = () => {}
  // Touchdown. `water` means it was the sea, and the caller should splash
  // instead of cratering.
  onLand: (pos: THREE.Vector3, water: boolean) => void = () => {}
  // Distance falloff for its sounds, wired to main.ts's own.
  volumeAt: (pos: THREE.Vector3) => number = () => 1
  // Whoever else is in the basket right now, off the emote in their state —
  // that's how the frame aims itself for people who aren't driving it.
  remoteRider: () => { ry: number } | undefined = () => undefined

  readonly base = new THREE.Vector3()
  private group = new THREE.Group()
  private turret = new THREE.Group()
  private armPivot = new THREE.Group()
  private cwPivot = new THREE.Group()
  private pouch = new THREE.Group()
  private ropes: THREE.Mesh[] = []
  private winchRope: THREE.Mesh
  private drum: THREE.Mesh
  private pin: THREE.Mesh
  private flag: THREE.Mesh

  // -1 while it sits cocked and ready; otherwise seconds since the trigger.
  private t = -1
  private yaw = 0
  private idle = 0
  private ratchetT = 0
  private threw = false
  private slammed = false

  // Riding it: latched in the basket, and then in the air. `launching` is the
  // sliver between the trigger and the release, where you're still in the
  // basket but the basket is already going.
  private riding = false
  private launching = false
  private boardLock = 0
  private flight: THREE.Vector3 | null = null
  private vel = new THREE.Vector3()
  private trailT = 0
  private baseFogFar = 150
  private hint: HTMLDivElement

  constructor(
    private scene: THREE.Scene,
    private effects: Effects,
  ) {
    this.base.set(BASE_X, baseHeightAt(BASE_X, BASE_Z), BASE_Z)
    this.group.position.copy(this.base)
    this.group.add(this.turret)

    const oak = timber(0x6d4a2c)
    const dark = timber(0x4a3220)
    const iron = timber(0x3a3a42)
    const stone = timber(0x6a6a72)
    const rope = timber(0x9c8455)
    const leather = timber(0x8a5a34)

    // Bedded into a rubble plinth, because the shelf it stands on isn't quite
    // flat and a floating sill beam looks like a bug.
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(9.5, 1.1, 15), timber(0x7c7c84))
    plinth.position.y = -0.55
    this.turret.add(plinth)
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2
      const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.5 + (i % 3) * 0.22, 0), stone)
      r.position.set(Math.cos(a) * 5.4, -0.25, Math.sin(a) * 8)
      r.rotation.set(i, i * 2, i * 3)
      this.turret.add(r)
    }

    // Sills and cross-ties.
    for (const side of [-1, 1]) {
      const sill = new THREE.Mesh(new THREE.BoxGeometry(1, 0.8, 13), oak)
      sill.position.set(side * 2.9, 0.4, 0)
      this.turret.add(sill)
    }
    for (const z of [-4.2, 0, 4.2]) {
      const tie = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.55, 0.8), dark)
      tie.position.set(0, 0.35, z)
      this.turret.add(tie)
    }

    // Two A-frames carrying the axle. Each leg is a beam leaned IN from the
    // sill to the apex, so the negative sign is load-bearing: leaned the other
    // way they splay past the axle and the whole thing reads as a woodpile.
    const legFoot = 3.4
    const legLen = Math.hypot(AXLE_Y - 0.6, legFoot)
    const lean = Math.atan2(legFoot, AXLE_Y - 0.6)
    for (const side of [-1, 1]) {
      for (const dir of [-1, 1]) {
        const leg = beam(0.8, legLen, 0.8, oak)
        leg.position.set(side * 2.9, 0.6, dir * legFoot)
        leg.rotation.x = -dir * lean
        this.turret.add(leg)
      }
      // Spans the two legs at half height, where they've already closed to
      // half their footing.
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, legFoot + 0.4), dark)
      brace.position.set(side * 2.9, 0.6 + (AXLE_Y - 0.6) / 2, 0)
      this.turret.add(brace)
    }
    const axle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 7.4, 8).rotateZ(Math.PI / 2),
      iron,
    )
    axle.position.y = AXLE_Y
    this.turret.add(axle)
    // A bearing block over the axle, not a roof — anything wider up here reads
    // as a lid and buries the counterweight behind it.
    const cap = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.7, 1.3), dark)
    cap.position.y = AXLE_Y + 0.7
    this.turret.add(cap)

    // A pennant on the apex so you can spot the thing from the beach.
    this.flag = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.5, 2.2), timber(0xc23b3b))
    this.flag.position.set(0, AXLE_Y + 1.9, -1.1)
    this.turret.add(this.flag)
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.6, 5), dark)
    pole.position.set(0, AXLE_Y + 1.5, 0)
    this.turret.add(pole)

    // The winch: a drum at the back that hauls the arm down, and the pawl bar
    // that clacks over its teeth.
    this.drum = new THREE.Mesh(
      new THREE.CylinderGeometry(0.85, 0.85, 4.4, 8).rotateZ(Math.PI / 2),
      dark,
    )
    this.drum.position.set(0, 1.5, -5.2)
    this.turret.add(this.drum)
    for (const side of [-1, 1]) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.1, 0.25), oak)
      spoke.position.set(side * 2.5, 0, 0)
      this.drum.add(spoke)
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, 3, 0.7), oak)
      post.position.set(side * 2.9, 1.5, -5.2)
      this.turret.add(post)
    }
    this.winchRope = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 1, 4).translate(0, 0.5, 0),
      rope,
    )
    this.turret.add(this.winchRope)

    // The trigger pin, which pops out and tumbles away when it fires.
    this.pin = new THREE.Mesh(new THREE.BoxGeometry(0.24, 1.2, 0.24), iron)
    this.pin.position.set(0, 1.4, 5.6)
    this.turret.add(this.pin)

    // The arm: a long beam one way, a stub the other, banded at the pivot.
    this.armPivot.position.y = AXLE_Y
    this.turret.add(this.armPivot)
    const long = beam(0.55, ARM_LONG, 0.55, timber(0x7d5836))
    this.armPivot.add(long)
    const tipCup = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.7, 0.75), iron)
    tipCup.position.y = ARM_LONG
    this.armPivot.add(tipCup)
    const short = beam(0.8, ARM_SHORT, 0.8, timber(0x7d5836))
    short.rotation.x = Math.PI // down the other way
    this.armPivot.add(short)
    for (const y of [-1.2, 0.9, 3.4]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.28, 0.9), iron)
      band.position.y = y
      this.armPivot.add(band)
    }

    // The counterweight hangs on its own pivot, so it lags on the way down and
    // swings itself out afterwards instead of being welded to the arm.
    this.cwPivot.position.y = -ARM_SHORT
    this.armPivot.add(this.cwPivot)
    for (const side of [-1, 1]) {
      const strap = beam(0.2, 1.2, 0.2, iron)
      strap.position.set(side * 1, 0, 0)
      strap.rotation.x = Math.PI
      this.cwPivot.add(strap)
    }
    const box = new THREE.Mesh(new THREE.BoxGeometry(3, 2.6, 2.8), stone)
    box.position.y = -2.5
    this.cwPivot.add(box)
    for (const y of [-1.7, -3.3]) {
      const hoop = new THREE.Mesh(new THREE.BoxGeometry(3.15, 0.26, 2.95), iron)
      hoop.position.y = y
      this.cwPivot.add(hoop)
    }

    // The basket, and the two ropes that fling it. Both ropes are unit
    // cylinders re-stretched between the arm tip and the pouch every frame.
    const cradle = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.28, 1.9), leather)
    this.pouch.add(cradle)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(dx ? 0.22 : 1.9, 0.85, dz ? 0.22 : 1.9),
        leather,
      )
      wall.position.set(dx * 0.85, 0.42, dz * 0.85)
      this.pouch.add(wall)
    }
    this.turret.add(this.pouch)
    for (const side of [-1, 1]) {
      const r = new THREE.Mesh(
        new THREE.CylinderGeometry(0.075, 0.075, 1, 4).translate(0, 0.5, 0),
        rope,
      )
      r.position.x = side * 0.5
      this.turret.add(r)
      this.ropes.push(r)
    }

    // A pile of ammunition nobody has needed since players turned up.
    for (let i = 0; i < 5; i++) {
      const ball = new THREE.Mesh(new THREE.DodecahedronGeometry(0.55, 0), stone)
      ball.position.set(-4.2 + (i % 3) * 0.9, 0.4 + (i > 2 ? 0.8 : 0), -3 + Math.floor(i / 3) * 1)
      ball.rotation.set(i, i * 1.7, i * 0.6)
      this.turret.add(ball)
    }

    scene.add(this.group)

    this.hint = document.createElement('div')
    this.hint.id = 'treb-hint'
    this.hint.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.fire()
    })
    document.body.append(this.hint)
  }

  // Latched in the basket or already in the air — either way the player has no
  // say over where they are, and an emote must not be cancelled out from under
  // them.
  get busy(): boolean {
    return this.riding || this.flight !== null
  }

  get flying(): boolean {
    return this.flight !== null
  }

  get loaded(): boolean {
    return this.riding
  }

  private get ready(): boolean {
    return this.t < 0
  }

  // Climb out again, or get yanked out by a shark. Puts you down beside the
  // frame rather than inside it, and holds the latch off long enough that
  // standing there doesn't put you straight back in.
  eject(player: Player): void {
    if (!this.riding) return
    this.riding = false
    this.launching = false
    this.boardLock = BOARD_COOLDOWN
    player.flying = false
    const p = this.pouchWorld()
    const x = p.x - Math.sin(this.yaw) * 3.4
    const z = p.z - Math.cos(this.yaw) * 3.4
    player.group.position.set(x, Math.max(heightAt(x, z), WATER_LEVEL), z)
    sfx.step()
    this.onExit()
  }

  // Pull the trigger. Only the rider can, and only once the machine has
  // finished hauling itself back down. You stay in the basket for the first
  // fraction of the swing — the arm snatches you up, and only then lets go.
  fire(): boolean {
    if (!this.riding || !this.ready) return false
    this.launching = true
    this.t = 0
    this.threw = false
    this.slammed = false
    this.ratchetT = 0
    sfx.trebLatch()
    return true
  }

  // Somebody else's shot, spotted by their pose flipping to 'slung'. Their
  // facing is already the frame's aim (we've been tracking it every frame
  // while they sat there), so there is nothing to unpack — and we start the
  // clock at the release rather than at the trigger, because the state that
  // told us about it IS the release. The wind-up we missed was 130ms long.
  remoteFire(): void {
    if (!this.ready) return
    this.t = T_RELEASE - 0.01
    this.threw = false
    this.slammed = false
    this.ratchetT = 0
    // Two people can climb in at once — each client only knows about the
    // basket it can see. If they pull the trigger while we're still sitting in
    // it, we go too, rather than riding the arm round and round forever.
    if (this.riding) this.launching = true
  }

  // Arm angle for a moment in the cycle. Everything else in the machine is
  // derived from this one number.
  private armAngle(t: number): number {
    if (t < 0) return ARM_COCKED
    if (t < T_SWING0) {
      // Loaded to the pin and shivering against it.
      return ARM_COCKED - 0.02 * Math.sin(t * 90)
    }
    if (t < T_SWING1) {
      const u = (t - T_SWING0) / SWING_S
      return ARM_COCKED - SWEEP * Math.pow(u, EASE_P)
    }
    if (t < T_SETTLE1) {
      // Rocking itself still against the stop.
      const s = t - T_SWING1
      return ARM_SPENT + 0.3 * Math.exp(-3.2 * s) * Math.sin(s * 15)
    }
    const w = Math.min(1, (t - T_SETTLE1) / WINCH_S)
    return ARM_SPENT + SWEEP * w * w * (3 - 2 * w)
  }

  // Where the sling rope points, measured the same way as the arm: hanging
  // from the tip, or laid out along the ground once the tip is low enough for
  // it to reach. Cocked, that puts the basket exactly where you walk into it —
  // the resting angle isn't a constant, it falls out of the arm being down.
  private slingAngle(t: number, armA: number): number {
    const tipY = AXLE_Y + ARM_LONG * Math.cos(armA)
    const hang = Math.acos(Math.max(-1, Math.min(1, (POUCH_Y - tipY) / SLING)))
    if (t < T_SWING0 || t < 0) return hang
    if (t < T_SWING1) {
      const u = (t - T_SWING0) / SWING_S
      if (u <= RELEASE_U) {
        // Snatched off the ground, dragged out behind the tip, then snapping
        // into line with the arm at the exact instant it lets go.
        const s = Math.min(1, u / RELEASE_U)
        const e = s * s * (3 - 2 * s)
        return hang + (armA - hang) * e + 0.7 * Math.sin(Math.PI * e)
      }
      // Empty and cracking like a whip.
      const s = (u - RELEASE_U) / (1 - RELEASE_U)
      return armA + 1.1 * Math.exp(-2.5 * s) * Math.sin(s * 22)
    }
    if (t < T_SETTLE1) {
      const s = t - T_SWING1
      return hang + 1.3 * Math.exp(-1.5 * s) * Math.sin(s * 6.5)
    }
    return hang
  }

  // Basket position in the frame's own (y, z) plane.
  private pouchLocal(t: number, armA: number): THREE.Vector2 {
    const phi = this.slingAngle(t, armA)
    return new THREE.Vector2(
      AXLE_Y + ARM_LONG * Math.cos(armA) + SLING * Math.cos(phi),
      ARM_LONG * Math.sin(armA) + SLING * Math.sin(phi),
    )
  }

  private pouchWorld(): THREE.Vector3 {
    const local = this.pouchLocal(this.t, this.armAngle(this.t))
    return new THREE.Vector3(
      this.base.x + Math.sin(this.yaw) * local.y,
      this.base.y + local.x,
      this.base.z + Math.cos(this.yaw) * local.y,
    )
  }

  // Stretch a unit cylinder between two points in the frame's local space.
  private stretch(mesh: THREE.Mesh, from: THREE.Vector2, to: THREE.Vector2): void {
    const dy = to.x - from.x
    const dz = to.y - from.y
    const len = Math.max(0.05, Math.hypot(dy, dz))
    mesh.position.set(mesh.position.x, from.x, from.y)
    mesh.scale.y = len
    mesh.rotation.x = Math.atan2(dz, dy)
  }

  update(dt: number, player: Player, turn: number): void {
    this.idle += dt
    this.boardLock = Math.max(0, this.boardLock - dt)
    // The machine's own clock runs first, so the basket the rider is pinned to
    // is this frame's basket and not last frame's.
    if (this.t >= 0) {
      this.t += dt
      this.tick(dt)
      if (this.t >= T_READY) {
        this.t = -1
        sfx.trebLatch(this.volumeAt(this.base) * 0.7) // the pawl catching
      }
    }

    if (this.flight) {
      this.updateFlight(dt, player)
    } else if (this.riding) {
      if (player.dead || player.grabbed) {
        this.eject(player)
      } else if (this.launching && this.t >= T_RELEASE) {
        this.throwRider(player)
      } else {
        // A/D steers the whole machine, and it steers by turning YOU — your
        // facing is already on the wire, so everyone else's copy of the frame
        // swings round with no message of its own. Not while it's swinging:
        // by then the shot is aimed.
        if (!this.launching) {
          player.group.rotation.y += turn * 1.6 * dt
          this.yaw = player.group.rotation.y
        }
        const p = this.pouchWorld()
        player.group.position.set(p.x, p.y - 0.3, p.z)
      }
    } else {
      // Aim off whoever else is sitting in it.
      const rider = this.remoteRider()
      if (rider) this.yaw = rider.ry
      if (this.ready && !this.boardLock && this.canBoard(player)) this.board(player)
    }

    this.draw(dt)
    this.updateHint(player)
  }

  // Beats inside the cycle that fire once: the throw, the slam, the ratchet.
  private tick(dt: number): void {
    const vol = this.volumeAt(this.base)
    if (!this.threw && this.t >= T_RELEASE) {
      this.threw = true
      sfx.trebThrow(vol)
      sfx.whistle(vol) // whoever just left, going up

      // The trigger pin gone in the grass.
      const p = this.base.clone()
      p.y += 1.6
      this.effects.spawnDebris(p, 0x3a3a42, 3, 7)
    }
    if (!this.slammed && this.t >= T_SWING1) {
      this.slammed = true
      sfx.trebSlam(vol)
      // Dust jumping off the sills as the counterweight lands.
      for (const side of [-1, 1]) {
        const p = this.base.clone()
        p.x += Math.cos(this.yaw) * side * 2.9
        p.z -= Math.sin(this.yaw) * side * 2.9
        this.effects.spawnDebris(p, 0xbfae8c, 6, 6)
      }
    }
    if (this.t >= T_SETTLE1 && this.t < T_READY) {
      this.ratchetT -= dt
      if (this.ratchetT <= 0) {
        this.ratchetT = RATCHET_S
        sfx.trebRatchet(vol)
      }
    }
  }

  private canBoard(player: Player): boolean {
    if (player.dead || player.flying || player.grabbed) return false
    if (this.remoteRider()) return false
    const p = this.pouchWorld()
    const dx = player.group.position.x - p.x
    const dz = player.group.position.z - p.z
    if (dx * dx + dz * dz > BOARD_R * BOARD_R) return false
    return Math.abs(player.group.position.y - p.y) < 3.5
  }

  private board(player: Player): void {
    this.riding = true
    player.flying = true
    this.yaw = player.group.rotation.y
    sfx.trebLoad()
    this.onBoard()
  }

  // The sling lets go. Position and velocity both come out of the same swing
  // the arm is drawn with, so you leave from exactly where the basket is and
  // exactly as fast as it's moving.
  private throwRider(player: Player): void {
    this.riding = false
    this.launching = false
    const local = this.pouchLocal(T_RELEASE, this.armAngle(T_RELEASE))
    const pos = new THREE.Vector3(
      this.base.x + Math.sin(this.yaw) * local.y,
      this.base.y + local.x - 0.3,
      this.base.z + Math.cos(this.yaw) * local.y,
    )
    const up = Math.sin(LAUNCH_ELEVATION) * LAUNCH_SPEED
    const fwd = Math.cos(LAUNCH_ELEVATION) * LAUNCH_SPEED
    this.vel.set(Math.sin(this.yaw) * fwd, up, Math.cos(this.yaw) * fwd)
    this.flight = pos
    player.flying = true
    player.group.position.copy(pos)
    player.group.rotation.y = this.yaw
    const fog = this.scene.fog as THREE.Fog | null
    this.baseFogFar = fog ? fog.far : 150
    this.trailT = 0
    this.onThrow()
  }

  private updateFlight(dt: number, player: Player): void {
    const pos = this.flight!
    if (player.dead) {
      this.land(player, pos, false, true)
      return
    }
    this.vel.y -= GRAVITY * dt
    pos.addScaledVector(this.vel, dt)
    player.group.position.copy(pos)
    // Face the way you're going, and keep it there — the frame's aim for
    // everyone else is read off this same number.
    player.group.rotation.y = this.yaw

    // The fog opens up as you climb, same trick rocket travel uses, so the top
    // of the arc is worth the trip.
    const fog = this.scene.fog as THREE.Fog | null
    if (fog) fog.far = this.baseFogFar + Math.max(0, pos.y - this.base.y - 10) * 4.5

    this.trailT -= dt
    if (this.trailT <= 0) {
      this.trailT = 0.045
      this.effects.spawnTrail(pos)
    }

    const ground = Math.max(
      heightAt(pos.x, pos.z),
      WATER_LEVEL,
      blockFloorAt(pos.x, pos.z, pos.y),
    )
    if (this.vel.y < 0 && pos.y <= ground) {
      pos.y = ground
      this.land(player, pos, heightAt(pos.x, pos.z) < WATER_LEVEL, false)
    }
  }

  private land(player: Player, pos: THREE.Vector3, water: boolean, aborted: boolean): void {
    this.flight = null
    player.flying = false
    const fog = this.scene.fog as THREE.Fog | null
    if (fog) fog.far = this.baseFogFar
    if (aborted) return
    player.group.position.copy(pos)
    this.onLand(pos.clone(), water)
  }

  // Push everything the arm angle implies into the scene graph.
  private draw(dt: number): void {
    const t = this.t
    const armA = this.armAngle(t)
    this.turret.rotation.y = this.yaw
    this.armPivot.rotation.x = armA

    // Counterweight: trails the arm as it plunges, then swings itself out and
    // rocks to a stop.
    let cw = Math.sin(this.idle * 0.9) * 0.02
    if (t >= T_SWING0 && t < T_SWING1) {
      cw = -0.75 * Math.sin(Math.PI * ((t - T_SWING0) / SWING_S))
    } else if (t >= T_SWING1 && t < T_SETTLE1) {
      const s = t - T_SWING1
      cw = 0.95 * Math.exp(-2 * s) * Math.sin(s * 8)
    }
    this.cwPivot.rotation.x = cw - armA // hangs plumb, whatever the arm is doing

    // The frame kicking when the counterweight finds the bottom.
    let bob = 0
    let shudder = 0
    if (t >= T_SWING1 && t < T_SWING1 + 1.2) {
      const s = t - T_SWING1
      bob = -0.28 * Math.exp(-6 * s) * Math.cos(s * 30)
      shudder = 0.05 * Math.exp(-5 * s) * Math.sin(s * 26)
    }
    this.turret.position.y = bob
    this.turret.rotation.x = shudder

    // Sling and basket.
    const tip = new THREE.Vector2(AXLE_Y + ARM_LONG * Math.cos(armA), ARM_LONG * Math.sin(armA))
    const pouch = this.pouchLocal(t, armA)
    this.pouch.position.set(0, pouch.x, pouch.y)
    // Hangs off the rope: level when the sling lies flat, tipping with it once
    // the swing starts.
    this.pouch.rotation.x = this.slingAngle(t, armA) - Math.PI / 2
    for (const rope of this.ropes) this.stretch(rope, tip, pouch)

    // The winch rope only exists while it's hauling; the drum reels it in.
    const winching = t >= T_SETTLE1 && t < T_READY
    this.winchRope.visible = winching
    if (winching) {
      this.stretch(this.winchRope, new THREE.Vector2(1.5, -5.2), tip)
      this.drum.rotation.x -= 3.4 * dt
    }
    this.pin.visible = t < 0 || t >= T_SETTLE1 + WINCH_S * 0.75
    this.flag.rotation.y = Math.sin(this.idle * 2.2) * 0.25
    this.flag.rotation.z = Math.sin(this.idle * 3.1) * 0.08
  }

  private updateHint(player: Player): void {
    let text = ''
    if (this.riding) {
      // Nothing to say in the sliver where the arm already has you.
      if (!this.launching) text = '🪨 A/D aim · SPACE launch · C climb out'
    } else if (!this.flight && !player.dead && !player.flying) {
      const p = this.pouchWorld()
      const near = player.group.position.distanceTo(p) < BOARD_R * 2.6
      if (near) text = this.ready ? '🪨 step into the sling' : '🪨 the trebuchet is reloading'
    }
    if (text) {
      this.hint.textContent = text
      this.hint.style.display = 'block'
    } else {
      this.hint.style.display = 'none'
    }
  }

}
