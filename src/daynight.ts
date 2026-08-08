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

    this.group.add(this.sun, this.moon, this.starDome)
    scene.add(this.group)
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

    // The sky is glued to the camera so it reads as infinitely far away.
    this.group.position.copy(camPos)
  }
}
