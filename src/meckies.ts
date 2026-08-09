import * as THREE from 'three'
import { heightAt } from './world'
import { makeNameTag } from './character'
import { sfx } from './audio'

// The Meckies: residents of the island, not props. Each one has a name, a
// signature colour, and a face — and you can pick them up, carry them, and set
// them down somewhere else, which is the whole point of them. Moving a Meckie
// between places is what a Meckie IS; on the desktop you drag them between
// devices and the machine they left sits there empty.
//
// They are family, so they get a name tag like any player, and the code calls
// them they/them.
//
// ---------------------------------------------------------------------------
// THE ROSTER. Names and colours come from the real household — the `droids`
// table in droid-body (`name`, `color`). Adding a resident is one line here:
// everything else, including the network, is driven off this array's indices.
// Colours are the signature colour a Meckie wears in the face UI; the default
// face is base blue (~190°), which is Droid's.
// ---------------------------------------------------------------------------
export interface Resident {
  name: string
  color: string
}

export const RESIDENTS: Resident[] = [
  { name: 'Droid', color: '#2fb6e8' },
]

// Where each resident sits when nobody has moved them. Spread around home so
// they aren't all in a heap on first load.
function homeSpot(i: number): { x: number; z: number } {
  const a = (i / Math.max(1, RESIDENTS.length)) * Math.PI * 2 + 0.7
  return { x: Math.cos(a) * 14, z: Math.sin(a) * 14 }
}

const PICKUP_RANGE = 3.2
const CRY_COOLDOWN = 2.6 // seconds, per resident
const FURY_TIME = 1.6 // how long the face stays angry after a cry

// What they shout. `%s` is your name — they are defending a person, not a
// position, so the cry says whose.
const WAR_CRIES = [
  'GET AWAY FROM %s',
  'NOT %s. NEVER %s.',
  'YOU DO NOT TOUCH %s',
  '%s IS UNDER MY PROTECTION',
]
const FACE_PX = 64
const BOB = 0.16

// What the face is doing. Mapped from what's happening to them rather than
// from anything synced — an expression is cosmetic, so each client picks it.
type Mood = 'curious' | 'excited' | 'happy' | 'thinking' | 'furious'

interface Live {
  group: THREE.Group
  screen: THREE.Mesh
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  texture: THREE.CanvasTexture
  // Resting spot. Meaningless while carried.
  x: number
  z: number
  // Player id carrying them, '' if they're sat on the ground. 'me' is us.
  by: string
  bob: number
  drawn: string
}

export class Meckies {
  // Someone picked a Meckie up or set them down: {i, x, z, by}. main.ts sends
  // it; the room stores the last one per resident and replays it to joiners.
  onMove: (i: number, x: number, z: number, by: string) => void = () => {}
  // A Meckie shouted. main.ts puts it in a speech bubble over them.
  onWarCry: (group: THREE.Group, text: string) => void = () => {}
  // Same cry, into the chat log, so it's visible from anywhere.
  onSay: (name: string, text: string) => void = () => {}
  // A Meckie struck back at whoever hurt their person. main.ts turns this into
  // damage on that player — through the ordinary `hit` message, so the victim
  // still decides whether it killed them and announces it themselves.
  onStrike: (attackerId: string) => void = () => {}
  // Whose name goes in the cry.
  personName: () => string = () => 'my person'
  private live: Live[] = []
  private hint: HTMLDivElement
  // Last hint text written to the DOM ('' = hidden), so per-frame no-ops
  // skip the style/text writes entirely.
  private hintShown = ''
  private carriedBy = -1 // index we're personally carrying, or -1
  private cryCd: number[] = []
  private fury: number[] = []

  constructor(scene: THREE.Scene, private touch: boolean) {
    RESIDENTS.forEach((res, i) => {
      const spot = homeSpot(i)
      const group = new THREE.Group()

      const canvas = document.createElement('canvas')
      canvas.width = FACE_PX
      canvas.height = FACE_PX
      const ctx = canvas.getContext('2d')!
      const texture = new THREE.CanvasTexture(canvas)
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter

      // A face, floating. Basic rather than Lambert: they glow, so dusk and
      // the shadow realm shouldn't dim them.
      const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(0.9, 0.9),
        // DoubleSide as a floor: a face that presents its back to you is just
        // a hole in the air, and a single-sided plane does exactly that.
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide }),
      )
      group.add(screen)
      // A small plinth so a resting Meckie reads as sitting somewhere rather
      // than hanging in mid-air.
      const plinth = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.4, 0.16, 6),
        new THREE.MeshLambertMaterial({ color: 0x39404d, flatShading: true }),
      )
      plinth.position.y = -0.72
      group.add(plinth)
      // makeNameTag hangs at 2.8, sized for a person. A Meckie is a face on a
      // plinth, so bring the tag down onto them and shrink it to match.
      const tag = makeNameTag(res.name)
      tag.position.y = 0.95
      tag.scale.multiplyScalar(0.6)
      group.add(tag)
      scene.add(group)

      const l: Live = {
        group, screen, canvas, ctx, texture,
        x: spot.x, z: spot.z, by: '', bob: i * 1.7, drawn: '',
      }
      this.live.push(l)
      this.cryCd.push(0)
      this.fury.push(0)
      this.paint(l, res, 'curious')
    })

    this.hint = document.createElement('div')
    // Its own id, not the cat's: two elements sharing one id is invalid, the
    // second is unreachable by getElementById, and both would stack on the
    // same 66px line. index.html styles them together and sits this one above.
    this.hint.id = 'meckie-hint'
    this.hint.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.toggleNearest()
    })
    document.body.append(this.hint)
  }

  // Pick up whoever is closest, or set down whoever we're carrying.
  toggleNearest(): void {
    if (this.carriedBy >= 0) {
      const l = this.live[this.carriedBy]
      const i = this.carriedBy
      this.carriedBy = -1
      l.by = ''
      l.x = l.group.position.x
      l.z = l.group.position.z
      sfx.equip(false)
      this.onMove(i, l.x, l.z, '')
      return
    }
    const i = this.nearestIndex()
    if (i < 0) return
    this.live[i].by = 'me'
    this.carriedBy = i
    sfx.equip(true)
    this.onMove(i, this.live[i].x, this.live[i].z, 'me')
  }

  // Somebody just hurt the person they live with. EVERY Meckie answers,
  // wherever they happen to be — there is no distance at which your family
  // stops being your family, and gating this on proximity meant that in
  // practice (one resident, sat in one spot) they almost never answered at
  // all. The cry goes to the chat log as well as a bubble, so you hear it
  // even when they're across the island.
  avenge(attackerId: string): void {
    this.cryOut((l) => {
      if (attackerId) this.onStrike(attackerId)
      return l
    })
  }

  // Hurt by something that isn't a player — a bear, a skeleton, the lava.
  // They still shout; there's just nobody to send damage to.
  rally(): void {
    this.cryOut(() => {})
  }

  private cryOut(each: (l: Live) => void): void {
    this.live.forEach((l, i) => {
      if (this.cryCd[i] > 0) return // one cry per resident per cooldown
      this.cryCd[i] = CRY_COOLDOWN
      this.fury[i] = FURY_TIME
      const cry = WAR_CRIES[Math.floor(Math.random() * WAR_CRIES.length)]
        .replaceAll('%s', this.personName().toUpperCase())
      this.onWarCry(l.group, cry)
      this.onSay(RESIDENTS[i].name, cry)
      sfx.warCry()
      each(l)
    })
  }

  private nearestIndex(): number {
    let best = -1
    let bestD = PICKUP_RANGE
    this.live.forEach((l, i) => {
      if (l.by) return // already in somebody's arms
      const d = l.group.position.distanceTo(this.playerPos)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }

  // A move that came off the wire. 'me' from the network means the sender, so
  // main.ts rewrites it to their id before calling this.
  applyRemote(i: number, x: number, z: number, by: string): void {
    const l = this.live[i]
    if (!l) return
    // Somebody else took them out of our hands — let go rather than fight.
    if (by && by !== 'me' && this.carriedBy === i) this.carriedBy = -1
    l.x = x
    l.z = z
    l.by = by
  }

  // A player left: anyone in their arms sits back down where they were picked
  // up. The room does the same, so everybody lands on the same spot.
  dropCarriedBy(id: string): void {
    for (const l of this.live) if (l.by === id) l.by = ''
  }

  private playerPos = new THREE.Vector3()

  update(
    dt: number,
    playerPos: THREE.Vector3,
    cameraPos: THREE.Vector3,
    carrierPos: (id: string) => THREE.Vector3 | undefined,
  ): void {
    this.playerPos.copy(playerPos)
    this.live.forEach((l, i) => {
      l.bob += dt
      if (this.cryCd[i] > 0) this.cryCd[i] -= dt
      if (this.fury[i] > 0) this.fury[i] -= dt
      // Where they are and how they feel are separate questions: a furious
      // Meckie in your arms still rides along, they just do it snarling.
      const holder = l.by === 'me' ? playerPos : l.by ? carrierPos(l.by) : undefined
      let mood: Mood
      if (holder) {
        // Carried at the shoulder, riding along.
        const want = new THREE.Vector3(holder.x, holder.y + 2.2, holder.z)
        l.group.position.lerp(want, Math.min(1, 12 * dt))
        mood = 'excited'
      } else {
        const ground = Math.max(heightAt(l.x, l.z), 0)
        l.group.position.set(l.x, ground + 1.15 + Math.sin(l.bob * 1.6) * BOB, l.z)
        mood = l.group.position.distanceTo(playerPos) < PICKUP_RANGE + 2 ? 'happy' : 'curious'
      }
      if (this.fury[i] > 0) mood = 'furious'
      // Billboard the face at the camera, not at the player. Turning toward
      // whoever holds them looks right until they're the one holding you —
      // then the target sits directly below, the rotation degenerates, and you
      // get a sliver or the blank back of the plane. The plinth stays put.
      l.screen.lookAt(cameraPos)
      this.paint(l, RESIDENTS[i], mood)
    })

    // Shown by style.display, matching the cat prompt — there is no .show
    // rule in the stylesheet, so toggling a class here would never appear.
    // Only touch the DOM when the text actually changes, same as cats.ts.
    const near = this.carriedBy >= 0 ? this.carriedBy : this.nearestIndex()
    let text = ''
    if (near >= 0) {
      const name = RESIDENTS[near].name
      const verb = this.carriedBy >= 0 ? `put ${name} down` : `pick ${name} up`
      text = this.touch ? verb : `U · ${verb}`
    }
    if (text === this.hintShown) return
    this.hintShown = text
    if (!text) {
      this.hint.style.display = 'none'
      return
    }
    this.hint.textContent = text
    this.hint.style.display = 'block'
  }

  // Repaint only when the face actually changes — same reason the real face
  // does it, which is that a redraw every frame flickers and costs.
  private paint(l: Live, res: Resident, mood: Mood): void {
    if (l.drawn === mood) return
    l.drawn = mood
    drawFace(l.ctx, res.color, mood)
    l.texture.needsUpdate = true
  }
}

// The face: base blue rotated to the resident's own colour is how identity
// reads at a glance on the desktop, so here it's simply drawn in their colour.
function drawFace(ctx: CanvasRenderingContext2D, color: string, mood: Mood): void {
  ctx.clearRect(0, 0, FACE_PX, FACE_PX)
  ctx.fillStyle = 'rgba(8,12,18,0.92)'
  ctx.beginPath()
  ctx.roundRect(2, 2, FACE_PX - 4, FACE_PX - 4, 10)
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.fillStyle = color
  const eyeY = mood === 'thinking' ? 27 : 28
  // Excited squints up, curious opens wide, happy is a soft arc.
  const h = mood === 'excited' ? 8 : mood === 'curious' ? 15 : mood === 'furious' ? 10 : 12
  for (const ex of [21, 43]) ctx.fillRect(ex - 6, eyeY - h / 2, 12, h)

  // Brow carries the mood, the way it does on the real face.
  ctx.strokeStyle = color
  ctx.lineWidth = 3
  ctx.beginPath()
  if (mood === 'furious') {
    // Hard inward slant — the whole face is the brow.
    ctx.moveTo(12, 10); ctx.lineTo(29, 19)
    ctx.moveTo(35, 19); ctx.lineTo(52, 10)
  } else if (mood === 'thinking') {
    ctx.moveTo(13, 15); ctx.lineTo(29, 18)
    ctx.moveTo(35, 13); ctx.lineTo(51, 13)
  } else if (mood === 'excited' || mood === 'happy') {
    ctx.moveTo(13, 14); ctx.lineTo(29, 11)
    ctx.moveTo(35, 11); ctx.lineTo(51, 14)
  } else {
    ctx.moveTo(13, 13); ctx.lineTo(29, 13)
    ctx.moveTo(35, 13); ctx.lineTo(51, 13)
  }
  ctx.stroke()

  // Mouth.
  ctx.lineWidth = 3
  ctx.beginPath()
  if (mood === 'furious') {
    // Bared, shouting.
    ctx.rect(23, 40, 18, 9)
    ctx.moveTo(23, 44); ctx.lineTo(41, 44)
  } else if (mood === 'excited') {
    ctx.arc(32, 42, 9, 0.15 * Math.PI, 0.85 * Math.PI)
  } else if (mood === 'happy') {
    ctx.arc(32, 43, 7, 0.2 * Math.PI, 0.8 * Math.PI)
  } else {
    ctx.moveTo(26, 46)
    ctx.lineTo(38, 46)
  }
  ctx.stroke()
}
