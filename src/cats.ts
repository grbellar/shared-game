import * as THREE from 'three'
import { heightAt } from './world'
import { makeNameTag } from './character'
import { sfx } from './audio'

// Two cats who wander the island, meow about it, and love being petted.
//
// Where a cat is at time t is a closed-form function of the clock — no
// simulation, no stored position, nothing on the wire. Same deal as the
// terrain: every client computes the same cats in the same spot (clocks are
// NTP-close enough that nobody can tell), so all the network has to carry is
// "someone petted cat 1". Petting is deliberately cosmetic for that reason —
// it must never move a cat, or clients would disagree about where they are.

// Keeps the time argument small so sin() stays precise (and identical) years
// from now. Roughly June 2025.
const EPOCH = 1_750_000_000

const PET_RANGE = 3.4
const HEART_LIFE = 1.3
const HAPPY_TIME = 1.6
const EAR_SHOT = 55

// A wandering path: two sine terms per axis at unrelated frequencies, so it
// meanders instead of looping visibly. `wp` phases the time warp below.
interface Path {
  cx: number
  cz: number
  r1: number
  r2: number
  f1: number
  f2: number
  p: [number, number, number, number]
  wp: number
}

interface CatDef {
  name: string
  fur: number
  dark: number
  cream: number
  stripes: boolean
  voice: number // meow pitch multiplier
  meowEvery: number
  meowOffset: number
  path: Path
}

const DEFS: CatDef[] = [
  {
    name: 'Waffles',
    fur: 0xe08a3c,
    dark: 0xa85f21,
    cream: 0xf6e3c0,
    stripes: true,
    voice: 1,
    meowEvery: 9,
    meowOffset: 0,
    path: { cx: 12, cz: -6, r1: 22, r2: 9, f1: 0.035, f2: 0.075, p: [0.4, 2.1, 1.3, 5.0], wp: 0 },
  },
  {
    name: 'Pickles',
    fur: 0x8f8f9a,
    dark: 0x5d5d68,
    cream: 0xf0f0f4,
    stripes: false,
    voice: 1.3,
    meowEvery: 11,
    meowOffset: 4.5,
    path: { cx: -14, cz: 10, r1: 20, r2: 8, f1: 0.029, f2: 0.083, p: [3.1, 0.7, 4.4, 1.9], wp: 2.2 },
  },
]

// Cats saunter, stop to sniff something, then trot on. Warping time does all
// of that for free: dT/dt = 1 + cos(...) swings between 0 (a pause) and 2 (a
// zoomie) without touching the path itself, so the facing direction stays
// well-defined even while a cat is standing still.
function warpTime(t: number, wp: number): number {
  return t + 2 * Math.sin(0.5 * t + wp)
}

function pathAt(path: Path, t: number, out: THREE.Vector2): THREE.Vector2 {
  const T = warpTime(t, path.wp)
  return out.set(
    path.cx + path.r1 * Math.sin(T * path.f1 + path.p[0]) + path.r2 * Math.sin(T * path.f2 + path.p[1]),
    path.cz +
      path.r1 * Math.cos(T * path.f1 * 0.83 + path.p[2]) +
      path.r2 * Math.cos(T * path.f2 * 1.19 + path.p[3]),
  )
}

interface CatRig {
  body: THREE.Object3D
  head: THREE.Object3D
  tail: THREE.Object3D
  tailTip: THREE.Object3D
  legs: THREE.Object3D[] // front-left, front-right, back-left, back-right
}

interface Cat {
  def: CatDef
  group: THREE.Group
  rig: CatRig
  walkPhase: number
  happy: number
  meowSlot: number
}

interface Heart {
  sprite: THREE.Sprite
  cat: Cat
  t: number
  drift: number
}

export class Cats {
  // Fires only when the local player pets one, so main.ts can tell the room.
  onPet: (index: number) => void = () => {}
  private cats: Cat[] = []
  private hearts: Heart[] = []
  private hint: HTMLDivElement
  private hintFor = -1
  private listener = new THREE.Vector3()
  private tmp = new THREE.Vector2()
  private tmp2 = new THREE.Vector2()

  constructor(
    private scene: THREE.Scene,
    private touch = false,
  ) {
    for (const def of DEFS) {
      const { group, rig } = buildCat(def)
      scene.add(group)
      this.cats.push({ def, group, rig, walkPhase: 0, happy: 0, meowSlot: -1 })
    }
    this.hint = document.createElement('div')
    this.hint.id = 'pet-hint'
    this.hint.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.petNearest()
    })
    document.body.append(this.hint)
  }

  // Pet whoever is in arm's reach of the local player. Fires onPet so the
  // rest of the room gets to see the heart too.
  petNearest(): void {
    const index = this.nearestIndex()
    if (index < 0) return
    this.pet(index)
    this.onPet(index)
  }

  // Heart, purr, happy wiggle. Called for our own pets and for relayed ones.
  pet(index: number): void {
    const cat = this.cats[index]
    if (!cat) return
    cat.happy = HAPPY_TIME
    const vol = this.volAt(cat.group.position)
    if (vol > 0.03) {
      sfx.purr(vol)
      sfx.meow(vol * 0.5, cat.def.voice * 1.15)
    }
    const sprite = new THREE.Sprite(heartMaterial())
    sprite.scale.set(0.62, 0.44, 1)
    this.scene.add(sprite)
    this.hearts.push({ sprite, cat, t: 0, drift: (Math.random() - 0.5) * 0.7 })
  }

  update(dt: number, listener: THREE.Vector3): void {
    this.listener.copy(listener)
    const t = Date.now() / 1000 - EPOCH

    for (const cat of this.cats) {
      const here = pathAt(cat.def.path, t, this.tmp)
      const soon = pathAt(cat.def.path, t + 0.08, this.tmp2)
      const dx = soon.x - here.x
      const dz = soon.y - here.y
      const speed = Math.hypot(dx, dz) / 0.08
      cat.group.position.set(here.x, heightAt(here.x, here.y), here.y)
      if (dx * dx + dz * dz > 1e-10) cat.group.rotation.y = Math.atan2(dx, dz)

      const moving = Math.min(1, speed / 1.6)
      cat.walkPhase += dt * (3 + speed * 3.5)
      cat.happy = Math.max(0, cat.happy - dt)
      animateCat(cat, t, moving)

      // Meow on a shared schedule, so everyone in earshot hears it together.
      const slot = Math.floor((t + cat.def.meowOffset) / cat.def.meowEvery)
      if (cat.meowSlot < 0) {
        cat.meowSlot = slot
      } else if (slot !== cat.meowSlot) {
        cat.meowSlot = slot
        const vol = this.volAt(cat.group.position)
        if (vol > 0.03) sfx.meow(vol, cat.def.voice)
      }
    }

    for (let i = this.hearts.length - 1; i >= 0; i--) {
      const h = this.hearts[i]
      h.t += dt
      if (h.t >= HEART_LIFE) {
        this.scene.remove(h.sprite)
        this.hearts.splice(i, 1)
        continue
      }
      const u = h.t / HEART_LIFE
      // Over the head, not the middle of the cat — so it follows the facing.
      const ry = h.cat.group.rotation.y
      h.sprite.position.copy(h.cat.group.position)
      h.sprite.position.x += Math.sin(ry) * 0.42
      h.sprite.position.z += Math.cos(ry) * 0.42
      // Rises from the ear tips and stops short of the name tag.
      h.sprite.position.y += 1.02 + u * 0.6
      h.sprite.position.x += h.drift * u + Math.sin(h.t * 6) * 0.06
      const mat = h.sprite.material as THREE.SpriteMaterial
      mat.opacity = Math.min(1, 3 * (1 - u))
      // A little pop on the way in.
      h.sprite.scale.set(0.62 * (1 + 0.4 * Math.max(0, 1 - u * 6)), 0.44 * (1 + 0.4 * Math.max(0, 1 - u * 6)), 1)
    }

    this.updateHint()
  }

  private nearestIndex(): number {
    let best = -1
    let bestDist = PET_RANGE
    for (let i = 0; i < this.cats.length; i++) {
      const d = this.cats[i].group.position.distanceTo(this.listener)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    return best
  }

  private updateHint(): void {
    const index = this.nearestIndex()
    if (index === this.hintFor) return
    this.hintFor = index
    if (index < 0) {
      this.hint.style.display = 'none'
      return
    }
    const name = this.cats[index].def.name
    this.hint.textContent = this.touch ? `pet ${name}` : `P · pet ${name}`
    this.hint.style.display = 'block'
  }

  private volAt(pos: THREE.Vector3): number {
    return Math.max(0, 1 - pos.distanceTo(this.listener) / EAR_SHOT)
  }
}

function animateCat(cat: Cat, t: number, moving: number): void {
  const { rig } = cat
  const happy = cat.happy > 0 ? cat.happy / HAPPY_TIME : 0
  const stride = Math.sin(cat.walkPhase) * 0.7 * moving

  // Diagonal pairs, like the real thing.
  rig.legs[0].rotation.x = stride
  rig.legs[3].rotation.x = stride
  rig.legs[1].rotation.x = -stride
  rig.legs[2].rotation.x = -stride

  // Shoulders rise and fall over the stride; a petted cat springs on top.
  const hop = happy > 0 ? Math.abs(Math.sin(cat.happy * 9)) * 0.16 * happy : 0
  rig.body.position.y = 0.55 + Math.abs(Math.sin(cat.walkPhase)) * 0.03 * moving + hop
  rig.head.position.y = 0.74 + hop

  // Idle cats look around; walking cats watch where they're going.
  rig.head.rotation.y = Math.sin(t * 0.7 + cat.def.path.wp) * 0.55 * (1 - moving)
  rig.head.rotation.x = -0.35 * happy

  // Tail: lazy swish, straight up and buzzing while being petted.
  rig.tail.rotation.x = -0.5 + 1.4 * happy + Math.sin(cat.walkPhase * 0.5) * 0.12
  rig.tail.rotation.z = Math.sin(t * 2.4 + cat.def.path.wp) * 0.3 * (1 - happy) + Math.sin(t * 22) * 0.25 * happy
  rig.tailTip.rotation.x = 0.45 - 0.5 * happy
}

// Blocky cat, facing +Z like the player character. Roughly knee-high.
function buildCat(def: CatDef): { group: THREE.Group; rig: CatRig } {
  const group = new THREE.Group()
  const fur = new THREE.MeshLambertMaterial({ color: def.fur, flatShading: true })
  const dark = new THREE.MeshLambertMaterial({ color: def.dark, flatShading: true })
  const cream = new THREE.MeshLambertMaterial({ color: def.cream, flatShading: true })
  const black = new THREE.MeshLambertMaterial({ color: 0x141418 })
  const pink = new THREE.MeshLambertMaterial({ color: 0xe08a9a })

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.38, 0.8), fur)
  body.position.y = 0.55
  const haunch = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.42, 0.26), fur)
  haunch.position.set(0, -0.01, -0.44)
  body.add(haunch)
  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.7), cream)
  belly.position.set(0, -0.2, 0.02)
  body.add(belly)
  if (def.stripes) {
    for (let i = 0; i < 3; i++) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.08, 0.09), dark)
      stripe.position.set(0, 0.16, 0.22 - i * 0.26)
      body.add(stripe)
    }
  }

  const head = new THREE.Group()
  head.position.set(0, 0.74, 0.44)
  const skull = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.32, 0.32), fur)
  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.1), cream)
  muzzle.position.set(0, -0.09, 0.19)
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.05), pink)
  nose.position.set(0, -0.03, 0.21)
  const eyeGeo = new THREE.BoxGeometry(0.07, 0.09, 0.04)
  const eyeL = new THREE.Mesh(eyeGeo, black)
  const eyeR = new THREE.Mesh(eyeGeo, black)
  eyeL.position.set(-0.09, 0.05, 0.17)
  eyeR.position.set(0.09, 0.05, 0.17)
  head.add(skull, muzzle, nose, eyeL, eyeR)
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.16, 4), fur)
    ear.position.set(side * 0.11, 0.22, -0.02)
    ear.rotation.y = Math.PI / 4
    head.add(ear)
  }

  const legGeo = new THREE.BoxGeometry(0.13, 0.36, 0.13)
  legGeo.translate(0, -0.18, 0) // pivot at the shoulder/hip
  const legs: THREE.Object3D[] = []
  for (const [sx, sz] of [
    [-1, 1],
    [1, 1],
    [-1, -1],
    [1, -1],
  ]) {
    const leg = new THREE.Mesh(legGeo, dark)
    leg.position.set(sx * 0.15, 0.36, sz * 0.27)
    const paw = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.08, 0.17), cream)
    paw.position.set(0, -0.32, 0.02)
    leg.add(paw)
    group.add(leg)
    legs.push(leg)
  }

  // Two-joint tail so it curls instead of sticking out like a broom handle.
  const tail = new THREE.Group()
  tail.position.set(0, 0.62, -0.5)
  const tailA = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.32), fur)
  tailA.position.z = -0.16
  const tailTip = new THREE.Group()
  tailTip.position.z = -0.32
  const tailB = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.3), def.stripes ? dark : fur)
  tailB.position.z = -0.15
  tailTip.add(tailB)
  tail.add(tailA, tailTip)

  const tag = makeNameTag(def.name)
  tag.scale.set(2.2, 0.55, 1)
  tag.position.y = 1.85

  group.add(body, head, tail, tag)
  return { group, rig: { body, head, tail, tailTip, legs } }
}

// A chunky pixel heart on a tiny canvas — no image assets, and it stays
// crisp at 320x240.
const HEART_ROWS = [
  '.####..####.',
  '############',
  '############',
  '############',
  '.##########.',
  '..########..',
  '...######...',
  '....####....',
  '.....##.....',
]
let heartTex: THREE.CanvasTexture | null = null
// One material shared by every heart ever popped — minting one per pet was
// a slow leak, since bare scene.remove never frees it.
let heartMat: THREE.SpriteMaterial | null = null

function heartMaterial(): THREE.SpriteMaterial {
  if (heartMat) return heartMat
  heartMat = new THREE.SpriteMaterial({ map: heartTexture(), transparent: true, depthTest: false })
  return heartMat
}

function heartTexture(): THREE.CanvasTexture {
  if (heartTex) return heartTex
  const w = HEART_ROWS[0].length + 2
  const h = HEART_ROWS.length + 2
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  // Pass one fattens every pixel into a dark outline, pass two lays the
  // bright fill back on top — readable against sky, grass, or water.
  ctx.fillStyle = '#5a0f1e'
  for (let y = 0; y < HEART_ROWS.length; y++) {
    for (let x = 0; x < HEART_ROWS[y].length; x++) {
      if (HEART_ROWS[y][x] === '#') ctx.fillRect(x, y, 3, 3)
    }
  }
  ctx.fillStyle = '#ff4d6d'
  for (let y = 0; y < HEART_ROWS.length; y++) {
    for (let x = 0; x < HEART_ROWS[y].length; x++) {
      if (HEART_ROWS[y][x] === '#') ctx.fillRect(x + 1, y + 1, 1, 1)
    }
  }
  heartTex = new THREE.CanvasTexture(canvas)
  heartTex.minFilter = THREE.NearestFilter
  heartTex.magFilter = THREE.NearestFilter
  heartTex.generateMipmaps = false
  return heartTex
}
