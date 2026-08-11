import * as THREE from 'three'
import { addRegion } from './world'
import { makeNameTag } from './character'

// The Land of Oz: a green island far north of everything, reached the
// traditional way — a Kansas twister picks you up (tornado.ts) — or by
// rocket, for the impatient. Same trick as the realm and Wichita: not a
// scene, just 2600 units of fog between it and the world, so blocks,
// craters, chat and remotes all work here for free.
//
// Everything is out of Baum's book (which belongs to everyone): the yellow
// brick road, the Emerald City, Munchkins, the silver shoes, and the whole
// company — Dorothy and Toto, the Scarecrow, the Tin Woodman, the Cowardly
// Lion, the Wicked Witch on her broom with her winged monkeys, Glinda in a
// bubble, and the Wizard in his balloon. The residents are scenery with
// name tags, animated closed-form like the cats — nothing about them ever
// crosses the wire.

export const OZ_X = 0
export const OZ_Z = -2600
const HALF = 170 // region half-extent; matches the terrain plane
const MEADOW_R = 140 // grass out to here, then the shore falls into the sea
const CITY_R = 24 // the Emerald City's flat plateau
const CITY_H = 12

export function inOz(x: number, z: number): boolean {
  return Math.abs(x - OZ_X) < 420 && Math.abs(z - OZ_Z) < 420
}

// Where the road runs, in local coords: a lazy swaying line in from the east
// shore (the Munchkin end) to the city ring. Used by the terrain colours and
// by Dorothy's commute, so the two can never disagree.
function roadZ(lx: number): number {
  return 28 * Math.sin(lx * 0.035)
}

// The meadow: a gentle dome with soft ridges, a flat-topped plateau for the
// city, and a shore that slides into the sea past MEADOW_R. Null everywhere
// else so world.ts falls through.
export function ozHeightAt(x: number, z: number): number | null {
  const dx = x - OZ_X
  const dz = z - OZ_Z
  if (Math.abs(dx) > HALF || Math.abs(dz) > HALF) return null
  const d = Math.hypot(dx, dz)
  const dome = 5.5 * Math.max(0, 1 - d / MEADOW_R)
  const ridge = Math.sin(dx * 0.045 + 1.3) * Math.cos(dz * 0.052) * 1.5
  let h = 2 + dome + ridge * Math.min(1, d / 30)
  // The city plateau, blended in over ten units so the road can climb it.
  if (d < CITY_R + 10) {
    const t = Math.max(0, Math.min(1, (CITY_R + 10 - d) / 10))
    h = h + (CITY_H - h) * t * t * (3 - 2 * t)
  }
  if (d > MEADOW_R) h -= Math.pow((d - MEADOW_R) / 22, 2) * 30
  return h
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

const MEADOW = new THREE.Color(0x53ae47)
const DEEP_MEADOW = new THREE.Color(0x3f9440)
const SAND = new THREE.Color(0xd8c47a)
const BRICK_YELLOW = new THREE.Color(0xd9b52f)
const POPPY = new THREE.Color(0xc42b1e)
const PLAZA = new THREE.Color(0x3fae6e)

// The poppy field, southwest of the road: pretty, red, and famously not a
// place to lie down. (Purely cosmetic here — nobody sleeps.)
const POPPY_X = -62
const POPPY_Z = 55
const POPPY_FIELD_R = 30

function buildOzTerrain(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(340, 340, 102, 102)
  geo.rotateX(-Math.PI / 2)
  const pos = geo.attributes.position
  const colors: number[] = []
  const rand = mulberry32(1900) // the book's year
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i)
    const lz = pos.getZ(i)
    const h = ozHeightAt(lx + OZ_X, lz + OZ_Z) ?? -20
    pos.setY(i, h)
    const d = Math.hypot(lx, lz)
    if (h < 1) c.copy(SAND)
    else if (d < CITY_R) c.copy(PLAZA)
    else c.copy(MEADOW).lerp(DEEP_MEADOW, Math.min(1, d / MEADOW_R))
    // The yellow brick road: the east approach, and a ring around the city
    // wall. Painted into the ground, not laid on top — no z-fighting, and
    // craters chew through it like anything else.
    const onApproach = lx > CITY_R && lx < MEADOW_R && Math.abs(lz - roadZ(lx)) < 3.2
    const onRing = Math.abs(d - CITY_R - 3.5) < 3.2
    if (h >= 1 && (onApproach || onRing)) c.copy(BRICK_YELLOW)
    // Poppies: a red-speckled field, denser in the middle.
    const pd = Math.hypot(lx - POPPY_X, lz - POPPY_Z)
    if (h >= 1 && pd < POPPY_FIELD_R && rand() < 0.55 * (1 - pd / POPPY_FIELD_R)) c.copy(POPPY)
    c.offsetHSL(0, 0, (rand() - 0.5) * 0.06)
    colors.push(c.r, c.g, c.b)
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  geo.userData.origin = new THREE.Vector2(OZ_X, OZ_Z)
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  )
  mesh.position.set(OZ_X, 0, OZ_Z)
  mesh.name = 'oz-terrain'
  return mesh
}

function lambert(color: number, emissive = 0): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, emissive, flatShading: true })
}

function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
}

function groundAt(lx: number, lz: number): number {
  return ozHeightAt(OZ_X + lx, OZ_Z + lz) ?? 0
}

// ---- the Emerald City -------------------------------------------------------
// A crown of green glass spires on the plateau, glowing faintly so the city
// reads from the shore at dusk. Gate arch facing the road's approach.

function buildCity(scene: THREE.Scene, rand: () => number): void {
  const glass = lambert(0x2fa05a, 0x0c3a1c)
  const jade = lambert(0x257e46, 0x082a12)
  const spire = (lx: number, lz: number, r: number, h: number) => {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.7, r, h, 6), glass)
    body.position.set(OZ_X + lx, CITY_H + h / 2, OZ_Z + lz)
    const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.8, r * 2.2, 6), jade)
    cap.position.set(OZ_X + lx, CITY_H + h + r * 1.1, OZ_Z + lz)
    scene.add(body, cap)
  }
  spire(0, 0, 4.5, 26)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.35
    const r = 10 + rand() * 7
    spire(Math.cos(a) * r, Math.sin(a) * r, 2.2 + rand() * 1.6, 10 + rand() * 12)
  }
  // The gate: two pillars and a lintel where the ring road meets the
  // approach, i.e. due east.
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, 9, 6), jade)
    pillar.position.set(OZ_X + CITY_R + 1, CITY_H / 2 + 4.5, OZ_Z + side * 4)
    scene.add(pillar)
  }
  const lintel = box(2.2, 1.4, 10.5, glass)
  lintel.position.set(OZ_X + CITY_R + 1, CITY_H + 8.2, OZ_Z)
  scene.add(lintel)
}

// ---- Munchkin country -------------------------------------------------------
// Round little houses where the road meets the shore, and the silver shoes
// on a plinth where the house isn't going to land on anyone twice.

function buildVillage(scene: THREE.Scene, rand: () => number): void {
  const paints = [0x4a7ac9, 0x5a9ad9, 0x3a66b0] // Munchkin country dresses in blue
  for (let i = 0; i < 5; i++) {
    const lx = 118 + rand() * 22
    const lz = roadZ(118) + 12 + rand() * 18 * (i % 2 === 0 ? 1 : -1.6)
    const g = groundAt(lx, lz)
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(2.4, 2.6, 2.6, 8),
      lambert(paints[i % paints.length]),
    )
    wall.position.set(OZ_X + lx, g + 1.3, OZ_Z + lz)
    const roof = new THREE.Mesh(new THREE.ConeGeometry(3, 2.4, 8), lambert(0xe8dfc4))
    roof.position.set(OZ_X + lx, g + 3.8, OZ_Z + lz)
    const door = box(1, 1.5, 0.2, lambert(0x6e4a2b))
    door.position.set(OZ_X + lx, g + 0.75, OZ_Z + lz + 2.5)
    scene.add(wall, roof, door)
  }
  // The silver shoes (the book's, not the movie's), waiting on a plinth by
  // the road's first brick.
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.3, 0.8, 6), lambert(0x8c8578))
  const g = groundAt(134, roadZ(134))
  plinth.position.set(OZ_X + 134, g + 0.4, OZ_Z + roadZ(134) - 5)
  scene.add(plinth)
  for (const side of [-1, 1]) {
    const shoe = box(0.5, 0.4, 1.1, lambert(0xc9ccd4, 0x30343c))
    shoe.position.set(OZ_X + 134 + side * 0.4, g + 1, OZ_Z + roadZ(134) - 5)
    scene.add(shoe)
  }
}

// ---- the company ------------------------------------------------------------
// Each resident is a little box figure with a name tag, parked or patrolling
// somewhere out of the book. Movement is a closed-form function of the shared
// clock where it matters (the witch's orbit, Dorothy's commute), so every
// client watches the same Oz.

interface Walker {
  group: THREE.Group
  tick(hours: number, t: number): void
}

const TAU = Math.PI * 2

function figure(
  name: string,
  bodyColor: number,
  headColor: number,
  scale = 1,
): { group: THREE.Group; body: THREE.Mesh; head: THREE.Mesh } {
  const group = new THREE.Group()
  const body = box(0.9 * scale, 1.1 * scale, 0.5 * scale, lambert(bodyColor))
  body.position.y = 1.05 * scale
  const head = box(0.7 * scale, 0.7 * scale, 0.7 * scale, lambert(headColor))
  head.position.y = 1.95 * scale
  const legL = box(0.28 * scale, 0.55 * scale, 0.3 * scale, lambert(bodyColor))
  legL.position.set(-0.2 * scale, 0.28 * scale, 0)
  const legR = legL.clone()
  legR.position.x = 0.2 * scale
  group.add(body, head, legL, legR)
  const tag = makeNameTag(name)
  tag.position.y = 2.8 * scale
  tag.scale.multiplyScalar(0.75)
  group.add(tag)
  return { group, body, head }
}

function buildCompany(scene: THREE.Scene): Walker[] {
  const walkers: Walker[] = []
  const place = (g: THREE.Group, lx: number, lz: number, ry = 0) => {
    g.position.set(OZ_X + lx, groundAt(lx, lz), OZ_Z + lz)
    g.rotation.y = ry
    scene.add(g)
  }

  // Dorothy walks the road from the village to the gate and back, Toto a
  // step behind. Position is a function of the shared clock: everyone's
  // Dorothy is the same Dorothy.
  const dorothy = figure('Dorothy', 0x4a6fd0, 0xf0c8a0)
  const basket = box(0.4, 0.3, 0.3, lambert(0x8a5a2b))
  basket.position.set(0.55, 1.0, 0.15)
  dorothy.group.add(basket)
  scene.add(dorothy.group)
  const toto = new THREE.Group()
  const totoBody = box(0.5, 0.35, 0.8, lambert(0x2b2118))
  totoBody.position.y = 0.35
  const totoHead = box(0.35, 0.35, 0.35, lambert(0x2b2118))
  totoHead.position.set(0, 0.55, 0.5)
  const totoTag = makeNameTag('Toto')
  totoTag.position.y = 1.4
  totoTag.scale.multiplyScalar(0.55)
  toto.add(totoBody, totoHead, totoTag)
  scene.add(toto)
  walkers.push({
    group: dorothy.group,
    tick(hours) {
      const s = 83 + 53 * Math.sin(TAU * (2 * hours) / 24)
      const ds = 53 * Math.cos(TAU * (2 * hours) / 24) // sign says which way she's walking
      const lx = s
      const lz = roadZ(s)
      dorothy.group.position.set(OZ_X + lx, groundAt(lx, lz), OZ_Z + lz)
      // Face along the road in the direction she's actually walking.
      const dir = Math.sign(ds) || 1
      dorothy.group.rotation.y = Math.atan2(dir, roadZ(s + dir) - lz)
      const bx = lx - dir * 1.6
      const bz = roadZ(bx) + 0.8
      toto.position.set(OZ_X + bx, groundAt(bx, bz), OZ_Z + bz)
      toto.rotation.y = dorothy.group.rotation.y
    },
  })

  // The Scarecrow, up on his pole where the book found him, doing his best.
  const scare = figure('Scarecrow', 0x9a7a3a, 0xd9c48a)
  scare.group.children.forEach((ch) => (ch.position.y += 1.4))
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 2.8, 5), lambert(0x6e4a2b))
  pole.position.y = 1.4
  scare.group.add(pole)
  place(scare.group, 60, roadZ(60) - 6, 0.6)
  walkers.push({
    group: scare.group,
    tick(_h, t) {
      scare.group.rotation.z = Math.sin(t * 0.9) * 0.06 // flops in the wind
    },
  })

  // The Tin Woodman, mid-swing beside the road, in want of an oil can.
  const tin = figure('Tin Woodman', 0x9aa4ae, 0x9aa4ae)
  const funnelHat = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.7, 6), lambert(0x7e8892))
  funnelHat.position.y = 2.5
  const axe = box(0.12, 1.3, 0.12, lambert(0x6e4a2b))
  axe.position.set(0.7, 1.4, 0.2)
  axe.rotation.z = -0.7
  const axeHead = box(0.1, 0.3, 0.5, lambert(0xc9ccd4))
  axeHead.position.set(1.05, 1.85, 0.2)
  tin.group.add(funnelHat, axe, axeHead)
  place(tin.group, 44, roadZ(44) + 7, -0.8)
  walkers.push({
    group: tin.group,
    tick(_h, t) {
      // The creak: frozen, except for a rusty half-degree of effort.
      tin.group.rotation.x = Math.max(0, Math.sin(t * 0.4)) * 0.02
    },
  })

  // The Cowardly Lion, snoozing by the ring road, braver horizontal.
  const lion = new THREE.Group()
  const lionBody = box(2, 0.9, 1.1, lambert(0xb8862f))
  lionBody.position.y = 0.45
  const lionHead = box(0.9, 0.9, 0.9, lambert(0xb8862f))
  lionHead.position.set(1.2, 0.8, 0)
  const mane = box(1.1, 1.1, 1.1, lambert(0x8a5a1e))
  mane.position.set(1.05, 0.8, 0)
  const tail = box(1.1, 0.15, 0.15, lambert(0xb8862f))
  tail.position.set(-1.4, 0.6, 0.2)
  const lionTag = makeNameTag('Cowardly Lion')
  lionTag.position.y = 2.2
  lionTag.scale.multiplyScalar(0.75)
  lion.add(lionBody, mane, lionHead, tail, lionTag)
  place(lion, 33, 10, 0.4)
  walkers.push({
    group: lion,
    tick(_h, t) {
      tail.rotation.y = Math.sin(t * 1.7) * 0.5
    },
  })

  // The Wicked Witch of the West, orbiting the island on her broom with two
  // winged monkeys in echelon. The clock flies her, so she's over the same
  // meadow on every screen.
  const witch = new THREE.Group()
  const robe = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.5, 6), lambert(0x1c1c24))
  robe.position.y = 0.75
  const witchHead = box(0.55, 0.55, 0.55, lambert(0x5a9a3a)) // green, as told
  witchHead.position.y = 1.7
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.95, 6), lambert(0x1c1c24))
  hat.position.y = 2.3
  const broom = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.6, 5), lambert(0x8a5a2b))
  broom.rotation.x = Math.PI / 2
  broom.position.set(0, 0.4, -0.3)
  const bristles = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.7, 6), lambert(0xb8962f))
  bristles.rotation.x = -Math.PI / 2
  bristles.position.set(0, 0.4, -1.8)
  const witchTag = makeNameTag('Wicked Witch')
  witchTag.position.y = 3.1
  witchTag.scale.multiplyScalar(0.75)
  witch.add(robe, witchHead, hat, broom, bristles, witchTag)
  scene.add(witch)
  const monkeys: THREE.Group[] = []
  const wings: THREE.Mesh[] = []
  for (let m = 0; m < 2; m++) {
    const monkey = new THREE.Group()
    const mb = box(0.45, 0.45, 0.6, lambert(0x6e4a32))
    mb.position.y = 0.3
    monkey.add(mb)
    for (const side of [-1, 1]) {
      const wing = box(0.7, 0.08, 0.35, lambert(0x4a3222))
      wing.position.set(side * 0.55, 0.5, 0)
      monkey.add(wing)
      wings.push(wing)
    }
    monkeys.push(monkey)
    scene.add(monkey)
  }
  walkers.push({
    group: witch,
    tick(hours, t) {
      const a = TAU * (6 * hours) / 24
      const r = 95 + 14 * Math.sin(2 * a)
      const y = 32 + 7 * Math.sin(3 * a)
      witch.position.set(OZ_X + Math.cos(a) * r, y, OZ_Z + Math.sin(a) * r)
      witch.rotation.y = -a // nose along the orbit
      witch.rotation.z = 0.18
      monkeys.forEach((monkey, m) => {
        const lag = a - (m + 1) * 0.09
        const mr = r + (m === 0 ? 5 : -5)
        monkey.position.set(OZ_X + Math.cos(lag) * mr, y - 1.5 - m, OZ_Z + Math.sin(lag) * mr)
        monkey.rotation.y = -lag
      })
      for (const wing of wings) wing.rotation.z = Math.sin(t * 9) * 0.6
    },
  })

  // Glinda drifts a slow circle above the meadow in her bubble.
  const glinda = new THREE.Group()
  const gown = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.5, 8), lambert(0xe08ab8))
  gown.position.y = 0.75
  const gHead = box(0.55, 0.55, 0.55, lambert(0xf0c8a0))
  gHead.position.y = 1.7
  const crown = box(0.6, 0.2, 0.6, lambert(0xd9b52f, 0x584410))
  crown.position.y = 2.05
  const bubble = new THREE.Mesh(
    new THREE.SphereGeometry(1.9, 10, 7),
    new THREE.MeshLambertMaterial({
      color: 0xf0b8d8,
      transparent: true,
      opacity: 0.22,
      flatShading: true,
    }),
  )
  bubble.position.y = 1.1
  const gTag = makeNameTag('Glinda')
  gTag.position.y = 3.2
  gTag.scale.multiplyScalar(0.75)
  glinda.add(gown, gHead, crown, bubble, gTag)
  scene.add(glinda)
  walkers.push({
    group: glinda,
    tick(hours, t) {
      const a = TAU * (3 * hours) / 24 + 2
      glinda.position.set(OZ_X + Math.cos(a) * 46, 13 + Math.sin(t * 0.7) * 1.2, OZ_Z + Math.sin(a) * 46)
      glinda.rotation.y = -a + Math.PI / 2
    },
  })

  // The Wizard, tethered over the plaza in his balloon, going nowhere — as
  // is traditional.
  const rig = new THREE.Group()
  const envelope = new THREE.Mesh(new THREE.SphereGeometry(3.2, 10, 8), lambert(0xd9c48a))
  envelope.position.y = 6.4
  const bandEq = new THREE.Mesh(new THREE.CylinderGeometry(3.24, 3.24, 0.5, 10), lambert(0x2fa05a))
  bandEq.position.y = 6.4
  const gondola = box(1.6, 1.2, 1.6, lambert(0x8a5a2b))
  gondola.position.y = 2
  const wiz = box(0.6, 0.8, 0.6, lambert(0x3a3f4a))
  wiz.position.y = 3
  const wizHead = box(0.5, 0.5, 0.5, lambert(0xf0c8a0))
  wizHead.position.y = 3.65
  const wTag = makeNameTag('The Wizard')
  wTag.position.y = 10.3
  rig.add(envelope, bandEq, gondola, wiz, wizHead, wTag)
  const rigBase = groundAt(-10, -32)
  scene.add(rig)
  walkers.push({
    group: rig,
    tick(_h, t) {
      rig.position.set(OZ_X - 10, rigBase + 1 + Math.sin(t * 0.5) * 0.8, OZ_Z - 32)
      rig.rotation.y = Math.sin(t * 0.23) * 0.2
    },
  })

  // Three Munchkins doing a slow ring-around outside the village.
  for (let m = 0; m < 3; m++) {
    const munchkin = figure(['Boq', 'Loq', 'Juq'][m], 0x4a7ac9, 0xf0c8a0, 0.6)
    const tallHat = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.8, 6), lambert(0x4a7ac9))
    tallHat.position.y = 1.65
    munchkin.group.add(tallHat)
    scene.add(munchkin.group)
    walkers.push({
      group: munchkin.group,
      tick(_h, t) {
        const a = t * 0.5 + (m * TAU) / 3
        const lx = 124 + Math.cos(a) * 4
        const lz = roadZ(118) - 8 + Math.sin(a) * 4
        munchkin.group.position.set(OZ_X + lx, groundAt(lx, lz), OZ_Z + lz)
        munchkin.group.rotation.y = -a
      },
    })
  }

  return walkers
}

// Where twister deliveries set down: the road's east end, by the Munchkin
// village and the silver shoes, which is where the book starts everybody
// off too. The twister is the ONLY way in.
export function ozArrival(): { x: number; z: number } {
  const s = 116 + Math.random() * 16
  return { x: OZ_X + s, z: OZ_Z + roadZ(s) + (Math.random() - 0.5) * 6 }
}

// The two ways OUT, for main.ts's X-key checks: the silver shoes on their
// plinth (knock the heels three times), and the Wizard's balloon.
export function ozShoesSpot(): { x: number; z: number } {
  return { x: OZ_X + 134, z: OZ_Z + roadZ(134) - 5 }
}
export function ozBalloonSpot(): { x: number; z: number } {
  return { x: OZ_X - 10, z: OZ_Z - 32 }
}

export class Oz {
  private walkers: Walker[]
  private t = 0

  constructor(scene: THREE.Scene) {
    const terrain = buildOzTerrain()
    scene.add(terrain)
    addRegion(ozHeightAt, terrain.geometry)

    // Its own sea patch, same as Wichita's — the island's water plane is a
    // continent away.
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(900, 900),
      new THREE.MeshLambertMaterial({ color: 0x3f76c9, transparent: true, opacity: 0.85 }),
    )
    water.rotateX(-Math.PI / 2)
    water.position.set(OZ_X, 0, OZ_Z)
    water.name = 'oz-water'
    scene.add(water)

    const rand = mulberry32(1939) // fine, ONE nod to the movie
    buildCity(scene, rand)
    buildVillage(scene, rand)
    this.walkers = buildCompany(scene)
  }

  // hours is the shared clock; the local accumulator only drives cosmetic
  // bobs and wing flaps, where a second of per-client drift is invisible.
  update(dt: number, hours: number, playerPos: THREE.Vector3): void {
    if (!inOz(playerPos.x, playerPos.z)) return
    this.t += dt
    for (const w of this.walkers) w.tick(hours, this.t)
  }
}
