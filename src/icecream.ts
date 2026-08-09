import * as THREE from 'three'
import { WICHITA_X, WICHITA_Z, WICHITA_GROUND } from './wichita'
import { sfx } from './audio'
import type { Mass } from './mass'

// Old Town Scoops: an ice cream parlor on the north side of East Douglas
// Avenue, two blocks east of the arcade. The lot at local (1190, -6) was
// scanned clear of every baked footprint and street, the same way the
// arcade's was.
//
// The loop is the whole feature: loose change glitters on the sidewalk out
// front, you walk it into your pocket, carry it inside, and trade three
// coins at the counter for a cone. Everything is local, like an arcade run —
// coins, pocket and cone exist on your screen only, so there's no message
// type and nothing to desync. The cone pays out in voxels while you eat it —
// it closes wounds first and then makes you bigger, exactly like anything
// else you swallow, because ice cream fixes everything.

const SX = WICHITA_X + 1190
const SZ = WICHITA_Z + -6
const G = WICHITA_GROUND
// Shell, outer size. The door faces -z: toward Douglas Ave.
const W = 13
const D = 10
const H = 5.5
const PRICE = 3
const COIN_RANGE = 1.2
const COIN_RESPAWN = 45 // seconds; the street stays generous
const COUNTER_RANGE = 2.6
const EAT_TIME = 12
const FEED_RATE = 0.9 // voxels per second of licking — a full cone is most of a base figure

const CREAM = 0xe8ddc4
const TRIM = 0x8e4a32 // Old Town brick, for the base course
const PINK = 0xe87aa4
const MINT = 0x9edfc2
const GOLD = 0xd8a832

// Where the change lies: fixed spots on the sidewalk apron between the door
// and Douglas Ave's centerline, in shop-local coords. Hand-placed, not
// random — the same scatter for everyone, every session.
const COIN_SPOTS: [number, number][] = [
  [-4.5, -7.5],
  [-1.2, -9.8],
  [2.8, -6.8],
  [5.5, -10.5],
  [-6.8, -11.8],
  [0.4, -13.6],
  [4.1, -15.2],
  [-3.4, -16.4],
  [7.2, -13.0],
]

function lambert(color: number, emissive = 0): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, emissive, flatShading: true })
}

function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
}

// Same chunky canvas signage as the arcade.
function signPlane(label: string, w: number, h: number, fg: string, bg: string): THREE.Mesh {
  const cv = document.createElement('canvas')
  cv.width = 64
  cv.height = 16
  const g = cv.getContext('2d')!
  g.fillStyle = bg
  g.fillRect(0, 0, 64, 16)
  g.fillStyle = fg
  g.font = 'bold 9px monospace'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(label, 32, 9, 60)
  const tex = new THREE.CanvasTexture(cv)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.colorSpace = THREE.SRGBColorSpace
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }))
}

interface Coin {
  mesh: THREE.Mesh
  x: number
  z: number
  gone: number // seconds until respawn; 0 = up for grabs
  phase: number
}

export class IceCream {
  private coins: Coin[] = []
  private pocket = 0
  private cone: THREE.Group | null = null
  private eating = 0 // seconds left on the current cone
  private licked = 0 // fractional voxels banked toward the next bite
  private scoop: THREE.Mesh | null = null
  private hint: HTMLDivElement
  private hintShown = ''
  private counterX = SX
  private counterZ = SZ + D / 2 - 2.6

  constructor(
    scene: THREE.Scene,
    private playerGroup: THREE.Group,
    private mass: Mass,
  ) {
    this.buildShop(scene)
    this.buildCoins(scene)
    this.hint = document.createElement('div')
    this.hint.id = 'icecream-hint'
    document.body.append(this.hint)
  }

  private buildShop(scene: THREE.Scene): void {
    const shell = new THREE.Group()
    shell.name = 'oldtown-scoops'
    shell.position.set(SX, G, SZ)
    const cream = lambert(CREAM)
    const brick = lambert(TRIM)

    // Three solid walls and a front split around an open door — walk-in like
    // every Wichita building, no collision to fight.
    const back = box(W, H, 0.6, cream)
    back.position.set(0, H / 2, D / 2 - 0.3)
    const left = box(0.6, H, D, cream)
    left.position.set(-W / 2 + 0.3, H / 2, 0)
    const right = box(0.6, H, D, cream)
    right.position.set(W / 2 - 0.3, H / 2, 0)
    shell.add(back, left, right)
    const doorW = 4
    for (const side of [-1, 1]) {
      const seg = box((W - doorW) / 2, H, 0.6, cream)
      seg.position.set(side * (doorW / 2 + (W - doorW) / 4), H / 2, -D / 2 + 0.3)
      shell.add(seg)
    }
    const header = box(doorW, 1.6, 0.6, cream)
    header.position.set(0, H - 0.8, -D / 2 + 0.3)
    const base = box(W, 0.9, 0.1, brick)
    base.position.set(0, 0.45, -D / 2 - 0.06)
    const roof = box(W, 0.5, D, brick)
    roof.position.set(0, H + 0.25, 0)
    shell.add(header, base, roof)
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W - 1, D - 1), lambert(0xc9b28a))
    floor.rotation.x = -Math.PI / 2
    floor.position.y = 0.05
    shell.add(floor)

    // Striped awning over the door, pink and cream, and the sign above it.
    for (let i = 0; i < 6; i++) {
      const stripe = box(W / 6 - 0.05, 0.18, 2.2, lambert(i % 2 ? PINK : 0xf2ead6))
      stripe.position.set(-W / 2 + W / 12 + (i * W) / 6, H - 1.3, -D / 2 - 1.1)
      stripe.rotation.x = 0.35
      shell.add(stripe)
    }
    const sign = signPlane('OLD TOWN SCOOPS', 8, 1.9, '#ffd9e8', '#7a2a4a')
    sign.position.set(0, H + 1.2, -D / 2 - 0.05)
    sign.rotation.y = Math.PI
    const signBack = box(8.4, 2.3, 0.4, brick)
    signBack.position.set(0, H + 1.2, -D / 2 + 0.25)
    shell.add(sign, signBack)

    // A giant cone on the roof, because roadside America.
    const bigCone = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.4, 7), lambert(0xc98d4e))
    bigCone.rotation.x = Math.PI
    bigCone.position.set(-W / 2 + 2, H + 1.7, 0)
    const bigScoop = new THREE.Mesh(new THREE.SphereGeometry(1.05, 7, 5), lambert(PINK))
    bigScoop.position.set(-W / 2 + 2, H + 3.2, 0)
    shell.add(bigCone, bigScoop)

    // The counter you pay at, the soft-serve machine, and a menu board.
    const counter = box(7, 1.1, 1.4, lambert(MINT))
    counter.position.set(0, 0.55, D / 2 - 2.6)
    const top = box(7.2, 0.12, 1.6, lambert(0xf2ead6))
    top.position.set(0, 1.16, D / 2 - 2.6)
    const machine = box(1.2, 1.6, 0.9, lambert(0xb8bec9, 0x202428))
    machine.position.set(2.2, 1.9, D / 2 - 2.6)
    const menu = signPlane('CONE ... 3 COINS', 5.5, 1.3, '#ffe9a0', '#3a2a2a')
    menu.position.set(0, H - 1.6, D / 2 - 0.65)
    menu.rotation.y = Math.PI
    shell.add(counter, top, machine, menu)

    // The scooper: a blocky kid in an apron and paper hat, forever on shift.
    const scooper = new THREE.Group()
    const torso = box(0.8, 1.0, 0.45, lambert(0xf2ead6))
    torso.position.y = 1.35
    const head = box(0.55, 0.55, 0.55, lambert(0xd8a878))
    head.position.y = 2.15
    const hat = box(0.6, 0.28, 0.6, lambert(0xffffff))
    hat.position.y = 2.5
    const legs = box(0.7, 0.85, 0.4, lambert(0x4a5a8e))
    legs.position.y = 0.42
    for (const side of [-1, 1]) {
      const arm = box(0.22, 0.85, 0.22, lambert(0xf2ead6))
      arm.position.set(side * 0.55, 1.35, 0)
      scooper.add(arm)
    }
    scooper.add(torso, head, hat, legs)
    scooper.position.set(-1.4, 0, D / 2 - 1.5)
    scooper.rotation.y = Math.PI
    shell.add(scooper)

    // Warm light so the parlor reads at night — the arcade's trick, vanilla.
    const fixture = box(4, 0.14, 0.5, lambert(0x3a3228, 0xffe9c9))
    fixture.position.set(0, H - 0.4, 0.5)
    const glow = new THREE.PointLight(0xffe2b8, 2.2, 22, 1.3)
    glow.position.set(0, H - 1.4, 0.5)
    shell.add(fixture, glow)
    scene.add(shell)
  }

  private buildCoins(scene: THREE.Scene): void {
    const geo = new THREE.CylinderGeometry(0.26, 0.26, 0.07, 8)
    const mat = lambert(GOLD, 0x584410)
    COIN_SPOTS.forEach(([lx, lz], i) => {
      const mesh = new THREE.Mesh(geo, mat)
      mesh.rotation.x = Math.PI / 2 // on edge, like it rolled there
      mesh.position.set(SX + lx, G + 0.3, SZ + lz)
      scene.add(mesh)
      this.coins.push({ mesh, x: SX + lx, z: SZ + lz, gone: 0, phase: i * 0.7 })
    })
  }

  // The X key: buy a cone if you're at the counter with the money.
  buy(p: THREE.Vector3): boolean {
    if (Math.hypot(p.x - this.counterX, p.z - this.counterZ) > COUNTER_RANGE) return false
    if (this.pocket < PRICE || this.cone) return true // at the counter, no sale
    this.pocket -= PRICE
    sfx.arcadeBlip(660)
    setTimeout(() => sfx.arcadeBlip(990), 90)
    this.eating = EAT_TIME
    this.cone = new THREE.Group()
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.42, 7), lambert(0xc98d4e))
    cone.rotation.x = Math.PI
    const scoop = new THREE.Mesh(new THREE.SphereGeometry(0.18, 7, 5), lambert(PINK))
    scoop.position.y = 0.28
    this.scoop = scoop
    this.cone.add(cone, scoop)
    // Held out in the right hand, cocked up like you mean it.
    this.cone.position.set(0.55, 1.5, -0.45)
    this.playerGroup.add(this.cone)
    return true
  }

  update(dt: number, p: THREE.Vector3, dead: boolean): void {
    // Licking pays out wherever you wander off to.
    if (this.cone) {
      if (dead) {
        this.dropCone()
      } else {
        this.eating -= dt
        // Mass moves in whole voxels, so bank the fraction between bites.
        this.licked += FEED_RATE * dt
        const bite = Math.floor(this.licked)
        if (bite > 0) {
          this.licked -= bite
          this.mass.eat(bite)
        }
        if (this.scoop) {
          const s = Math.max(0.12, this.eating / EAT_TIME)
          this.scoop.scale.setScalar(s)
        }
        if (this.eating <= 0) this.dropCone()
      }
    }

    // The shop sleeps unless you're in the neighbourhood.
    const around = Math.hypot(p.x - SX, p.z - SZ) < 90
    if (!around) {
      this.showHint('')
      return
    }

    for (const c of this.coins) {
      if (c.gone > 0) {
        c.gone -= dt
        if (c.gone <= 0) {
          c.gone = 0
          c.mesh.visible = true
        }
        continue
      }
      // Spin and bob on the wall clock; nobody else can see them anyway.
      c.phase += dt * 2.4
      c.mesh.rotation.z = c.phase
      c.mesh.position.y = G + 0.3 + Math.sin(c.phase * 1.7) * 0.08
      if (!dead && Math.hypot(p.x - c.x, p.z - c.z) < COIN_RANGE) {
        c.gone = COIN_RESPAWN
        c.mesh.visible = false
        this.pocket++
        sfx.arcadeBlip(880 + this.pocket * 60)
      }
    }

    // The prompt, arcade-style: only touch the DOM when the text changes.
    const atCounter = Math.hypot(p.x - this.counterX, p.z - this.counterZ) < COUNTER_RANGE
    let text = ''
    if (this.cone) text = 'mmm ice cream'
    else if (atCounter)
      text =
        this.pocket >= PRICE
          ? `X · buy a cone (${PRICE} coins)`
          : `a cone is ${PRICE} coins — you have ${this.pocket}`
    else if (this.pocket > 0) text = `${this.pocket} coin${this.pocket === 1 ? '' : 's'} jingling`
    this.showHint(text)
  }

  private dropCone(): void {
    if (this.cone) this.playerGroup.remove(this.cone)
    this.cone = null
    this.scoop = null
    this.eating = 0
    this.licked = 0
  }

  private showHint(text: string): void {
    if (text === this.hintShown) return
    this.hintShown = text
    if (!text) {
      this.hint.style.display = 'none'
      return
    }
    this.hint.textContent = text
    this.hint.style.display = 'block'
  }
}
