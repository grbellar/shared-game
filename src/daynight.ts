import * as THREE from 'three'
import type { Settings } from './settings'

// Day/night cycle: sun, moon, stars, and all the sky/fog/light color math.
// Time is SHARED across the room: the server keeps an anchored clock, and
// every scrub/pause is broadcast (net 'clock' message). Locally the clock is
// an anchor (hours at a performance.now() timestamp), not a per-frame
// accumulator — background-tab rAF throttling can't drift it. update()
// mirrors the derived value into settings.timeOfDay for the settings UI.
//
// Sky geometry rides along with the camera (a sky at infinity, N64 style),
// with fog disabled on its materials so the fog wall never swallows the sun.

const SKY_RADIUS = 300
const DAY_LENGTH_S = 600 // real seconds per full in-game day; also in server/room.ts

const DAY_SKY = new THREE.Color(0x9fd4ea)
const NIGHT_SKY = new THREE.Color(0x0b1026)
const DUSK_SKY = new THREE.Color(0xff8a4a)
const DAY_HEMI_SKY = new THREE.Color(0xcfe8ff)
const NIGHT_HEMI_SKY = new THREE.Color(0x2a3b5e)
const DAY_HEMI_GROUND = new THREE.Color(0x5a7a4a)
const NIGHT_HEMI_GROUND = new THREE.Color(0x141c28)
const SUN_LIGHT_NOON = new THREE.Color(0xfff2cc)
const SUN_LIGHT_LOW = new THREE.Color(0xff9040)
const MOON_LIGHT = new THREE.Color(0x8fa8dc)
const SUN_DISC_NOON = new THREE.Color(0xfff3b0)
const SUN_DISC_LOW = new THREE.Color(0xff7a2a)

// The shadow realm keeps the room's clock — it just doesn't care what it
// says. No sun, no moon, permanent bruise-coloured dusk lit from below by
// the lava. Blended in by a 0..1 factor so the crossing isn't a hard cut.
const SHADOW_SKY = new THREE.Color(0x2c1040)
const SHADOW_HEMI_SKY = new THREE.Color(0x7b4aa8)
const SHADOW_HEMI_GROUND = new THREE.Color(0xa8481c) // lava bouncing off everything
const SHADOW_LIGHT = new THREE.Color(0xff8a44)
// A low raking key light instead of a sun — there is no sun out here, just a
// glow on the horizon that never moves.
const SHADOW_SUN_DIR = new THREE.Vector3(-0.72, 0.34, -0.4)
const SHADOW_FOG_NEAR = 26
const SHADOW_FOG_FAR = 195
const ISLAND_FOG_NEAR = 40
const ISLAND_FOG_FAR = 150

// Shoot the sun and it takes it personally: the sky goes hostile for
// ANGRY_TIME seconds and the sun scowls. Rockets expire long before they
// could reach it, so a hit is judged on aim alone (main.ts compares the
// firing direction against sunDirection()) — which means only first person
// can line it up, and only while the sun is actually up.
// How closely you have to be aiming at the sun to hit it: dot(aim, sunDir).
// About 5.7 degrees — you have to actually put the crosshair on it.
export const SUN_AIM_DOT = 0.995
const ANGRY_TIME = 45
const ANGRY_ATTACK = 0.6 // seconds to slam into the sulk
const ANGRY_RELEASE = 6 // seconds to ease back out of it
const ANGRY_SKY = new THREE.Color(0xd9622e)
const ANGRY_HEMI_SKY = new THREE.Color(0xffae72)
const ANGRY_HEMI_GROUND = new THREE.Color(0x5a2f22)
const ANGRY_LIGHT = new THREE.Color(0xff7a2a)
const ANGRY_DISC = new THREE.Color(0xff3a12)
const WHITE = new THREE.Color(0xffffff)

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

// Hermite smoothstep from a to b.
function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class DayNight {
  private group = new THREE.Group()
  private starDome = new THREE.Group()
  private sun: THREE.Mesh
  private moon: THREE.Mesh
  private sunMat: THREE.MeshBasicMaterial
  private starMats: THREE.PointsMaterial[] = []
  private hemi: THREE.HemisphereLight
  private dirLight: THREE.DirectionalLight
  private sky = new THREE.Color()
  private tmp = new THREE.Vector3()
  private anchorHours: number | null = null
  private anchorMs = 0
  private running = true
  // Both are absolute timestamps rather than per-frame accumulators, for the
  // same reason the clock is an anchor: a throttled background tab must not
  // be able to drift them.
  private angryUntil = 0
  private flashUntil = 0
  private face = new THREE.Group()
  private brows = new THREE.Group()
  private mouth: THREE.Mesh

  constructor(private scene: THREE.Scene) {
    // world.ts creates and names these; we take over driving them.
    this.hemi = scene.getObjectByName('hemi-light') as THREE.HemisphereLight
    this.dirLight = scene.getObjectByName('sun-light') as THREE.DirectionalLight

    this.sunMat = new THREE.MeshBasicMaterial({ color: SUN_DISC_NOON, fog: false })
    this.sun = new THREE.Mesh(new THREE.SphereGeometry(16, 10, 8), this.sunMat)
    this.moon = new THREE.Mesh(
      new THREE.SphereGeometry(11, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xdfe6f2, fog: false }),
    )

    // Two star layers: lots of 1px pinpricks, a few chunky 2px bright ones.
    // Seeded, so every player gets the same night sky.
    const rand = mulberry32(7)
    const makeStars = (count: number, size: number): THREE.Points => {
      const pts: number[] = []
      for (let i = 0; i < count; i++) {
        // Uniform over the dome (uniform in sin-elevation), so the horizon
        // band the camera actually looks at gets its fair share of stars.
        const az = rand() * Math.PI * 2
        const sinEl = 0.04 + rand() * 0.96
        const cosEl = Math.sqrt(1 - sinEl * sinEl)
        pts.push(
          Math.cos(az) * cosEl * SKY_RADIUS,
          sinEl * SKY_RADIUS,
          Math.sin(az) * cosEl * SKY_RADIUS,
        )
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      const mat = new THREE.PointsMaterial({
        color: 0xffffff,
        size,
        sizeAttenuation: false,
        fog: false,
        transparent: true,
        opacity: 0,
      })
      this.starMats.push(mat)
      return new THREE.Points(geo, mat)
    }
    this.starDome.add(makeStars(200, 1), makeStars(50, 2))

    // The sun has a face. It is normally pleased with itself; see strike().
    // The face group is re-aimed at the camera every frame, because the sun
    // crosses the whole sky and a flat face would edge-on vanish.
    const ink = new THREE.MeshBasicMaterial({ color: 0x8a3a08, fog: false })
    const eyeGeo = new THREE.BoxGeometry(2.6, 4, 0.6)
    const eyeL = new THREE.Mesh(eyeGeo, ink)
    const eyeR = new THREE.Mesh(eyeGeo, ink)
    eyeL.position.set(-5, 3.5, 15)
    eyeR.position.set(5, 3.5, 15)
    this.mouth = new THREE.Mesh(new THREE.BoxGeometry(9, 2, 0.6), ink)
    this.mouth.position.set(0, -5, 15)
    for (const side of [-1, 1]) {
      const brow = new THREE.Mesh(new THREE.BoxGeometry(6, 1.7, 0.6), ink)
      brow.position.set(side * 5, 8, 15)
      brow.rotation.z = side * -0.45
      this.brows.add(brow)
    }
    this.brows.visible = false
    this.face.add(eyeL, eyeR, this.mouth, this.brows)
    this.sun.add(this.face)

    this.group.add(this.sun, this.moon, this.starDome)
    scene.add(this.group)
  }

  // Direction from the island to the sun, for the aim check in main.ts. The
  // sky group rides the camera, so the sun's local position IS the direction.
  sunDirection(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.sun.position).normalize()
  }

  // You can only shoot a sun that's in the sky.
  get sunUp(): boolean {
    return this.sun.visible
  }

  get isAngry(): boolean {
    return performance.now() < this.angryUntil
  }

  strike(): void {
    this.angryUntil = performance.now() + ANGRY_TIME * 1000
    this.flashUntil = performance.now() + 600
  }

  // 0..1 sulk level, derived purely from the timestamp so it survives tab
  // throttling: fast attack in, slow release out.
  private angryLevel(): number {
    const remain = (this.angryUntil - performance.now()) / 1000
    if (remain <= 0) return 0
    return clamp01(Math.min((ANGRY_TIME - remain) / ANGRY_ATTACK, remain / ANGRY_RELEASE, 1))
  }

  // Re-anchor the clock: local scrubs/toggles and network 'clock' messages
  // both land here. Everyone anchoring the same hours within network latency
  // of each other is what keeps the room in sync.
  setClock(hours: number, running: boolean): void {
    this.anchorHours = ((hours % 24) + 24) % 24
    this.anchorMs = performance.now()
    this.running = running
  }

  // The live clock, straight from the anchor. Public because pausing needs
  // the true current time even when a throttled tab's UI mirror is stale.
  now(): number {
    if (this.anchorHours === null) return 10
    if (!this.running) return this.anchorHours
    return (this.anchorHours + ((performance.now() - this.anchorMs) / 1000) * (24 / DAY_LENGTH_S)) % 24
  }

  update(settings: Settings, camPos: THREE.Vector3, shadow = 0): void {
    // First frame: seed from persisted settings until the welcome clock lands.
    if (this.anchorHours === null) this.setClock(settings.timeOfDay, settings.clockRun)
    const t = this.now()
    settings.timeOfDay = t

    // 6:00 sunrise on the east horizon, 12:00 zenith, 18:00 sunset.
    const theta = ((t - 6) / 24) * Math.PI * 2
    const e = Math.sin(theta) // sun elevation, -1..1
    this.sun.position
      .set(Math.cos(theta) * 0.9, e, Math.cos(theta) * 0.4)
      .multiplyScalar(SKY_RADIUS)
    this.moon.position.copy(this.sun.position).multiplyScalar(-1)
    this.sun.visible = e > -0.2 && shadow < 0.5
    this.moon.visible = -e > -0.2 && shadow < 0.5
    this.starDome.rotation.y = theta // stars drift as the night wears on

    const day = smooth(-0.05, 0.3, e)
    const dusk = clamp01(1 - Math.abs(e) / 0.25)

    this.sky.copy(NIGHT_SKY).lerp(DAY_SKY, day).lerp(DUSK_SKY, dusk * 0.65)
    this.sky.lerp(SHADOW_SKY, shadow)
    ;(this.scene.background as THREE.Color).copy(this.sky)
    const fog = this.scene.fog as THREE.Fog
    fog.color.copy(this.sky)
    fog.near = mix(ISLAND_FOG_NEAR, SHADOW_FOG_NEAR, shadow)
    fog.far = mix(ISLAND_FOG_FAR, SHADOW_FOG_FAR, shadow)

    this.hemi.intensity = mix(0.3 + 0.65 * day, 1.15, shadow)
    this.hemi.color.copy(NIGHT_HEMI_SKY).lerp(DAY_HEMI_SKY, day).lerp(SHADOW_HEMI_SKY, shadow)
    this.hemi.groundColor
      .copy(NIGHT_HEMI_GROUND)
      .lerp(DAY_HEMI_GROUND, day)
      .lerp(SHADOW_HEMI_GROUND, shadow)

    // One directional light plays both parts: warm sun by day, cold faint
    // moon by night. Positions are direction-only (target stays at origin).
    if (e > -0.05) {
      this.dirLight.position.copy(this.sun.position)
      this.dirLight.color.copy(SUN_LIGHT_LOW).lerp(SUN_LIGHT_NOON, day)
      this.dirLight.intensity = 0.3 + 1.1 * day
    } else {
      this.dirLight.position.copy(this.moon.position)
      this.dirLight.color.copy(MOON_LIGHT)
      this.dirLight.intensity = 0.35
    }
    // Out in the realm the light is the lava, not the sky: low, orange, and
    // never going anywhere.
    if (shadow > 0) {
      this.dirLight.position.lerp(
        this.tmp.copy(SHADOW_SUN_DIR).multiplyScalar(SKY_RADIUS),
        shadow,
      )
      this.dirLight.color.lerp(SHADOW_LIGHT, shadow)
      this.dirLight.intensity = mix(this.dirLight.intensity, 1.25, shadow)
    }
    this.sunMat.color.copy(SUN_DISC_LOW).lerp(SUN_DISC_NOON, day)

    // Whatever the clock says, the realm's sky is always full of stars.
    const starA = Math.max(1 - smooth(-0.35, -0.05, e), shadow)
    this.starMats[0].opacity = starA * 0.85
    this.starMats[1].opacity = starA

    // Somebody shot the sun. Blended in last, over whatever the clock and
    // the realm had already decided — a sulking sun overrules the hour.
    // Not out in the shadow realm, where there is no sun to shoot.
    const angry = this.angryLevel() * (1 - shadow)
    if (angry > 0) {
      this.sky.lerp(ANGRY_SKY, angry)
      ;(this.scene.background as THREE.Color).copy(this.sky)
      fog.color.copy(this.sky)
      this.hemi.color.lerp(ANGRY_HEMI_SKY, angry)
      this.hemi.groundColor.lerp(ANGRY_HEMI_GROUND, angry)
      this.dirLight.color.lerp(ANGRY_LIGHT, angry)
      this.sunMat.color.lerp(ANGRY_DISC, angry)
    }
    const flash = clamp01((this.flashUntil - performance.now()) / 600)
    if (flash > 0) this.sunMat.color.lerp(WHITE, flash)
    this.sun.scale.setScalar(1 + 0.45 * flash + 0.1 * angry)
    // Cheerful sun has a wide grin; angry sun has a flat line and eyebrows.
    this.mouth.scale.set(1 - 0.45 * angry, 1 + 0.7 * angry, 1)
    this.mouth.position.y = -5 + 1.8 * angry
    this.brows.visible = angry > 0.35

    // The sky is glued to the camera so it reads as infinitely far away.
    this.group.position.copy(camPos)
    // Then swing the face round to whichever side of the sun we're on — it
    // crosses the whole sky, and a flat face would go edge-on and vanish.
    this.face.lookAt(camPos)
  }
}
