import * as THREE from 'three'
import type { Settings } from './settings'

// Day/night cycle: sun, moon, stars, and all the sky/fog/light color math.
// The clock lives in settings.timeOfDay (hours, 0-24) so the settings slider
// can scrub it; when settings.clockRun is on, update() advances it. Purely
// cosmetic and local — never synced, so friends can live at different hours.
//
// Sky geometry rides along with the camera (a sky at infinity, N64 style),
// with fog disabled on its materials so the fog wall never swallows the sun.

const SKY_RADIUS = 300
const DAY_LENGTH_S = 600 // real seconds per full in-game day

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

  update(dt: number, settings: Settings, camPos: THREE.Vector3): void {
    if (settings.clockRun) {
      settings.timeOfDay = (settings.timeOfDay + (dt * 24) / DAY_LENGTH_S) % 24
    }
    const t = ((settings.timeOfDay % 24) + 24) % 24

    // 6:00 sunrise on the east horizon, 12:00 zenith, 18:00 sunset.
    const theta = ((t - 6) / 24) * Math.PI * 2
    const e = Math.sin(theta) // sun elevation, -1..1
    this.sun.position
      .set(Math.cos(theta) * 0.9, e, Math.cos(theta) * 0.4)
      .multiplyScalar(SKY_RADIUS)
    this.moon.position.copy(this.sun.position).multiplyScalar(-1)
    this.sun.visible = e > -0.2
    this.moon.visible = -e > -0.2
    this.starDome.rotation.y = theta // stars drift as the night wears on

    const day = smooth(-0.05, 0.3, e)
    const dusk = clamp01(1 - Math.abs(e) / 0.25)

    this.sky.copy(NIGHT_SKY).lerp(DAY_SKY, day).lerp(DUSK_SKY, dusk * 0.65)
    ;(this.scene.background as THREE.Color).copy(this.sky)
    ;(this.scene.fog as THREE.Fog).color.copy(this.sky)

    this.hemi.intensity = 0.3 + 0.65 * day
    this.hemi.color.copy(NIGHT_HEMI_SKY).lerp(DAY_HEMI_SKY, day)
    this.hemi.groundColor.copy(NIGHT_HEMI_GROUND).lerp(DAY_HEMI_GROUND, day)

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
    this.sunMat.color.copy(SUN_DISC_LOW).lerp(SUN_DISC_NOON, day)

    const starA = 1 - smooth(-0.35, -0.05, e)
    this.starMats[0].opacity = starA * 0.85
    this.starMats[1].opacity = starA

    // The sky is glued to the camera so it reads as infinitely far away.
    this.group.position.copy(camPos)
  }
}
