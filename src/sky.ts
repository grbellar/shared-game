import * as THREE from 'three'

// Sky colour, fog and lights — plus the sun, which has a face and a temper.
//
// Rockets only fly ~78 units before expiring, so nothing can physically reach
// the sun. Instead main.ts checks the firing direction against `dir`: aim
// within a few degrees (only possible in first-person) and you have struck
// the sun. It flashes, scowls, and drags the island into a hostile sunset for
// SUNSET_TIME seconds. Broadcast as an `egg` message so everyone shares it.

const SUN_DIST = 380
const SUN_R = 26
const SUNSET_TIME = 45

// How closely you have to be aiming at the sun to hit it: dot(aim, sunDir).
export const SUN_AIM_DOT = 0.995

interface Palette {
  sky: number
  hemiSky: number
  hemiGround: number
  light: number
  disc: number
}

const DAY: Palette = {
  sky: 0x9fd4ea,
  hemiSky: 0xcfe8ff,
  hemiGround: 0x5a7a4a,
  light: 0xfff2cc,
  disc: 0xffe9a8,
}

const DUSK: Palette = {
  sky: 0xd9622e,
  hemiSky: 0xffae72,
  hemiGround: 0x5a2f22,
  light: 0xff9a4a,
  disc: 0xff4a1e,
}

export class Sky {
  // Unit vector from the island to the sun. Aim along it to make an enemy.
  readonly dir = new THREE.Vector3(40, 60, 20).normalize()

  private hemi: THREE.HemisphereLight
  private sunLight: THREE.DirectionalLight
  private fog: THREE.Fog
  private disc: THREE.Mesh
  private discMat: THREE.MeshBasicMaterial
  private brows: THREE.Group
  private mouth: THREE.Mesh
  private timer = 0
  private angry = 0
  private flash = 0
  private tmp = new THREE.Color()
  private scratch = new THREE.Color()

  constructor(private scene: THREE.Scene) {
    const sky = new THREE.Color(DAY.sky)
    scene.background = sky.clone()
    this.fog = new THREE.Fog(sky.clone(), 40, 150)
    scene.fog = this.fog

    this.hemi = new THREE.HemisphereLight(DAY.hemiSky, DAY.hemiGround, 0.9)
    scene.add(this.hemi)
    this.sunLight = new THREE.DirectionalLight(DAY.light, 1.4)
    this.sunLight.position.copy(this.dir).multiplyScalar(100)
    scene.add(this.sunLight)

    // The sun is its own light source, so it opts out of fog and lambert
    // shading — the one place MeshBasic is the honest choice.
    this.discMat = new THREE.MeshBasicMaterial({ color: DAY.disc, fog: false })
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(SUN_R, 14), this.discMat)
    this.disc.position.copy(this.dir).multiplyScalar(SUN_DIST)
    this.disc.lookAt(0, 0, 0)
    scene.add(this.disc)

    const ink = new THREE.MeshBasicMaterial({ color: 0x7a3b12, fog: false })
    const eyeGeo = new THREE.BoxGeometry(4.5, 7, 1)
    const eyeL = new THREE.Mesh(eyeGeo, ink)
    const eyeR = new THREE.Mesh(eyeGeo, ink)
    eyeL.position.set(-8, 5, 1)
    eyeR.position.set(8, 5, 1)
    this.mouth = new THREE.Mesh(new THREE.BoxGeometry(14, 3, 1), ink)
    this.mouth.position.set(0, -8, 1)
    this.brows = new THREE.Group()
    for (const side of [-1, 1]) {
      const brow = new THREE.Mesh(new THREE.BoxGeometry(9, 2.6, 1), ink)
      brow.position.set(side * 8, 11, 1)
      brow.rotation.z = side * -0.45
      this.brows.add(brow)
    }
    this.brows.visible = false
    this.disc.add(eyeL, eyeR, this.mouth, this.brows)
  }

  get isAngry(): boolean {
    return this.timer > 0
  }

  // Somebody shot the sun.
  strike(): void {
    this.timer = SUNSET_TIME
    this.flash = 1
  }

  update(dt: number): void {
    if (this.timer > 0) this.timer -= dt
    // Snap into the sunset, crawl back out of it.
    const target = this.timer > 0 ? 1 : 0
    this.angry += (target - this.angry) * Math.min(1, dt * (target ? 2.5 : 0.5))
    this.flash = Math.max(0, this.flash - dt * 1.6)

    const k = this.angry
    this.tmp.setHex(DAY.sky).lerp(this.tmpOf(DUSK.sky), k)
    ;(this.scene.background as THREE.Color).copy(this.tmp)
    this.fog.color.copy(this.tmp)
    this.hemi.color.setHex(DAY.hemiSky).lerp(this.tmpOf(DUSK.hemiSky), k)
    this.hemi.groundColor.setHex(DAY.hemiGround).lerp(this.tmpOf(DUSK.hemiGround), k)
    this.sunLight.color.setHex(DAY.light).lerp(this.tmpOf(DUSK.light), k)
    this.sunLight.intensity = 1.4 - 0.35 * k

    this.discMat.color.setHex(DAY.disc).lerp(this.tmpOf(DUSK.disc), k)
    if (this.flash > 0) this.discMat.color.lerp(this.tmpOf(0xffffff), this.flash)
    this.disc.scale.setScalar(1 + 0.5 * this.flash + 0.12 * k)

    // Cheerful sun has a wide grin; angry sun has a straight line and brows.
    this.mouth.scale.set(1 - 0.45 * k, 1 + 0.6 * k, 1)
    this.mouth.position.y = -8 + 2.5 * k
    this.brows.visible = k > 0.35
  }

  private tmpOf(hex: number): THREE.Color {
    return this.scratch.setHex(hex)
  }
}
