import * as THREE from 'three'
import { WICHITA_X, WICHITA_Z, WICHITA_GROUND } from './wichita'
import { buildLineup, type ArcadeGame, type ArcadeInput } from './arcadegames'
import { sfx } from './audio'

// The Old Town Arcade: a brick joint just off Douglas Ave in Wichita's
// warehouse district, stuffed with playable cabinets (arcadegames.ts). The
// lot at local (1055, 10) was scanned clear of every baked footprint and
// street, so the building doesn't sit inside somebody's real address.
//
// Playing is entirely local — your run exists on your screen and nowhere
// else, which is why the games are allowed Math.random. What the room DOES
// hear about is a new high score, and that brag rides the ordinary chat
// relay from main.ts: no new message type, same trick as the cheats.
//
// The in-world screen is a 64px canvas texture (the sanctioned kind), and
// because 64px seen from two meters away at 320x240 is pixel soup, the same
// canvas is also dropped into a DOM overlay while you play — the scope
// overlay's trick, upscaled with nearest-neighbour so it stays chunky.

const AX = WICHITA_X + 1055
const AZ = WICHITA_Z + 10
const G = WICHITA_GROUND
// Building shell, outer size. The door faces -z: toward Douglas Ave.
const W = 30
const D = 20
const H = 7
const PLAY_RANGE = 2.6
const DRIFT_STOP = 3.6 // shoved this far off the buttons, the run pauses out
const ATTRACT_RANGE = 45
const ATTRACT_FPS = 0.22

const BRICK = 0x8e4a32
const TRIM = 0x2c2126
const CARPET = 0x241a30
const NEON = 0xff3aa0

interface Cab {
  game: ArcadeGame
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  tex: THREE.CanvasTexture
  // World-space spot you stand on to play, and the cabinet's own position.
  standX: number
  standZ: number
  x: number
  z: number
  attractT: number
  repaintT: number
  wasOver: boolean
}

function lambert(color: number, emissive = 0): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, emissive, flatShading: true })
}

function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
}

// Chunky sign text on a canvas, nametag-style. 64x16 keeps it inside the
// pixel budget; nearest-neighbour keeps it honest.
function signTex(label: string, fg: string, bg: string): THREE.CanvasTexture {
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
  return tex
}

function signPlane(label: string, w: number, h: number, fg: string, bg: string): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: signTex(label, fg, bg) }),
  )
}

export class Arcade {
  // A new personal best on some cabinet — main.ts turns it into a chat brag.
  onHighScore: (title: string, score: number) => void = () => {}
  private cabs: Cab[] = []
  private playingIdx = -1
  private hint: HTMLDivElement
  private hintShown = ''
  private overlay: HTMLDivElement
  private screenSlot: HTMLDivElement
  private overlayTitle: HTMLDivElement
  private overlayScore: HTMLDivElement

  get isPlaying(): boolean {
    return this.playingIdx >= 0
  }

  constructor(scene: THREE.Scene) {
    this.buildShell(scene)
    this.buildCabinets(scene)

    this.hint = document.createElement('div')
    this.hint.id = 'arcade-hint'
    this.hint.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.togglePointer()
    })
    document.body.append(this.hint)

    // The big screen you actually play on. The cabinet's own canvas is moved
    // in here while a run is live — one canvas, two audiences: CSS upscales
    // it for you, the CanvasTexture keeps painting it onto the cabinet.
    this.overlay = document.createElement('div')
    this.overlay.style.cssText =
      'position:fixed;left:50%;top:46%;transform:translate(-50%,-50%);display:none;' +
      'flex-direction:column;align-items:center;gap:6px;z-index:40;' +
      'background:#15121c;border:5px solid #2c2436;border-radius:8px;padding:12px 16px;' +
      'box-shadow:0 0 40px rgba(255,58,160,0.25)'
    this.overlayTitle = document.createElement('div')
    this.overlayTitle.style.cssText = 'color:#ff9ad0;font:bold 16px monospace'
    this.screenSlot = document.createElement('div')
    this.overlayScore = document.createElement('div')
    this.overlayScore.style.cssText = 'color:#cfd0e0;font:12px monospace;white-space:pre'
    this.overlay.append(this.overlayTitle, this.screenSlot, this.overlayScore)
    document.body.append(this.overlay)
  }

  private buildShell(scene: THREE.Scene): void {
    const shell = new THREE.Group()
    shell.name = 'oldtown-arcade'
    shell.position.set(AX, G, AZ)
    const brick = lambert(BRICK)
    const trim = lambert(TRIM)

    // Three solid walls, and a front wall split around a wide open door —
    // walk-in like every Wichita building, no collision to fight.
    const back = box(W, H, 0.6, brick)
    back.position.set(0, H / 2, D / 2 - 0.3)
    const left = box(0.6, H, D, brick)
    left.position.set(-W / 2 + 0.3, H / 2, 0)
    const right = box(0.6, H, D, brick)
    right.position.set(W / 2 - 0.3, H / 2, 0)
    shell.add(back, left, right)
    const doorW = 7
    for (const side of [-1, 1]) {
      const seg = box((W - doorW) / 2, H, 0.6, brick)
      seg.position.set(side * (doorW / 2 + (W - doorW) / 4), H / 2, -D / 2 + 0.3)
      shell.add(seg)
    }
    const header = box(doorW, 2.2, 0.6, trim)
    header.position.set(0, H - 1.1, -D / 2 + 0.3)
    shell.add(header)
    const roof = box(W, 0.5, D, trim)
    roof.position.set(0, H + 0.25, 0)
    shell.add(roof)
    const carpet = new THREE.Mesh(new THREE.PlaneGeometry(W - 1, D - 1), lambert(CARPET))
    carpet.rotation.x = -Math.PI / 2
    carpet.position.y = 0.05
    shell.add(carpet)

    // The marquee over the door, lit day and night, plus a stripe of neon
    // around the front. Old Town's actual arcade is a block over; ours pays
    // its respects in hot pink.
    const marquee = signPlane('OLD TOWN ARCADE', 9, 2.2, '#ff9ad0', '#1c1022')
    marquee.position.set(0, H + 1.4, -D / 2 - 0.05)
    marquee.rotation.y = Math.PI
    shell.add(marquee)
    const marqueeBack = box(9.4, 2.6, 0.4, trim)
    marqueeBack.position.set(0, H + 1.4, -D / 2 + 0.25)
    shell.add(marqueeBack)
    const neon = lambert(0x3a0a22, NEON)
    for (const y of [H - 0.2, 0.9]) {
      const tube = box(W - 0.5, 0.14, 0.14, neon)
      tube.position.set(0, y, -D / 2 - 0.12)
      shell.add(tube)
    }

    // Actual light. The sun ignores the roof (nothing casts shadows at
    // 320x240), so by night the room went black except the screens. Two warm
    // point lights under visible ceiling tubes keep the cabinets and the
    // people at them readable around the clock — the portal's trick, tuned
    // arcade pink.
    const fixture = lambert(0x3a2a3a, 0xffc9e8)
    for (const lx of [-7, 7]) {
      const tube = box(6, 0.14, 0.5, fixture)
      tube.position.set(lx, H - 0.4, 1.5)
      shell.add(tube)
      const glowLight = new THREE.PointLight(0xffb8d8, 2.4, 26, 1.3)
      glowLight.position.set(lx, H - 1.4, 1.5)
      shell.add(glowLight)
    }

    // A little dressing so it reads as a room: change machine and a prize
    // counter nobody is staffing.
    const change = box(1, 1.8, 0.8, lambert(0x3a4a9e, 0x101c50))
    change.position.set(-W / 2 + 1.6, 0.9, -D / 2 + 4)
    const counter = box(4.5, 1.1, 1.2, lambert(0x5a3a6e))
    counter.position.set(W / 2 - 4, 0.55, -D / 2 + 3.4)
    const prizes = signPlane('PRIZES', 3.4, 0.9, '#ffe25a', '#3a2a10')
    prizes.position.set(W / 2 - 4, 1.9, -D / 2 + 3.4)
    prizes.rotation.y = Math.PI
    shell.add(change, counter, prizes)
    scene.add(shell)
  }

  private buildCabinets(scene: THREE.Scene): void {
    // Four against the back wall, two down each side, all facing the middle.
    const spots: { lx: number; lz: number; ry: number }[] = [
      { lx: -9, lz: 8, ry: Math.PI },
      { lx: -3, lz: 8, ry: Math.PI },
      { lx: 3, lz: 8, ry: Math.PI },
      { lx: 9, lz: 8, ry: Math.PI },
      { lx: -13.2, lz: -2, ry: Math.PI / 2 },
      { lx: -13.2, lz: 3.5, ry: Math.PI / 2 },
      { lx: 13.2, lz: -2, ry: -Math.PI / 2 },
      { lx: 13.2, lz: 3.5, ry: -Math.PI / 2 },
    ]
    const games = buildLineup()
    games.forEach((game, i) => {
      const spot = spots[i]
      const cab = this.buildCabinet(game, spot.ry)
      cab.group.position.set(AX + spot.lx, G, AZ + spot.lz)
      cab.group.rotation.y = spot.ry
      scene.add(cab.group)
      // You stand a step out front of the glass.
      const fx = Math.sin(spot.ry)
      const fz = Math.cos(spot.ry)
      this.cabs.push({
        game,
        canvas: cab.canvas,
        ctx: cab.ctx,
        tex: cab.tex,
        x: AX + spot.lx,
        z: AZ + spot.lz,
        standX: AX + spot.lx + fx * 1.4,
        standZ: AZ + spot.lz + fz * 1.4,
        attractT: i * 1.3, // desynced attract loops, like a real arcade
        repaintT: 0,
        wasOver: false,
      })
    })
  }

  // The classic upright: body, side art in the game's accent, tilted screen,
  // control deck, lit marquee. Built facing +z; the caller turns it around.
  private buildCabinet(game: ArcadeGame, _ry: number): {
    group: THREE.Group
    canvas: HTMLCanvasElement
    ctx: CanvasRenderingContext2D
    tex: THREE.CanvasTexture
  } {
    const group = new THREE.Group()
    const paint = lambert(0x1c1a24)
    const accent = lambert(game.accent)
    const body = box(1.2, 1.9, 0.95, paint)
    body.position.set(0, 0.95, 0)
    for (const side of [-1, 1]) {
      const art = box(0.06, 1.9, 0.95, accent)
      art.position.set(side * 0.61, 0.95, 0)
      group.add(art)
    }
    const deck = box(1.2, 0.16, 0.5, paint)
    deck.position.set(0, 1.12, 0.6)
    const stickBall = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4), accent)
    stickBall.position.set(-0.22, 1.3, 0.62)
    const button = box(0.14, 0.05, 0.14, lambert(0xd03a3a, 0x500a0a))
    button.position.set(0.22, 1.2, 0.62)
    group.add(body, deck, stickBall, button)

    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    canvas.style.imageRendering = 'pixelated'
    const ctx = canvas.getContext('2d')!
    const tex = new THREE.CanvasTexture(canvas)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.colorSpace = THREE.SRGBColorSpace
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.86, 0.86),
      // Basic, not Lambert: a CRT is its own light source.
      new THREE.MeshBasicMaterial({ map: tex }),
    )
    screen.position.set(0, 1.52, 0.49)
    screen.rotation.x = -0.16
    group.add(screen)

    const marquee = signPlane(game.title, 1.1, 0.3, '#ffffff', '#' + game.accent.toString(16).padStart(6, '0'))
    marquee.position.set(0, 2.02, 0.48)
    group.add(marquee)
    const cap = box(1.2, 0.34, 0.5, paint)
    cap.position.set(0, 2.02, 0.2)
    group.add(cap)
    game.reset()
    return { group, canvas, ctx, tex }
  }

  // The X key (or a tap on the hint): sit down at the nearest cabinet, or
  // push back from the one you're on.
  toggle(playerPos: THREE.Vector3): boolean {
    if (this.playingIdx >= 0) {
      this.stop()
      return true
    }
    const i = this.nearest(playerPos)
    if (i < 0) return false
    this.toggleAt(i)
    return true
  }

  private togglePointer(): void {
    // The hint is only visible when toggling is valid, so trust it.
    if (this.playingIdx >= 0) this.stop()
    else if (this.hintNear >= 0) this.toggleAt(this.hintNear)
  }

  private toggleAt(i: number): void {
    const cab = this.cabs[i]
    this.playingIdx = i
    cab.game.reset()
    cab.wasOver = false
    sfx.arcadeBlip(760)
    this.overlayTitle.textContent = cab.game.title
    this.screenSlot.append(cab.canvas)
    cab.canvas.style.width = 'min(52vh, 80vw)'
    cab.canvas.style.height = 'auto'
    this.overlay.style.display = 'flex'
  }

  stop(): void {
    if (this.playingIdx < 0) return
    const cab = this.cabs[this.playingIdx]
    this.playingIdx = -1
    cab.canvas.remove() // the texture keeps its reference; only the DOM lets go
    this.overlay.style.display = 'none'
    sfx.equip(false)
  }

  private nearest(p: THREE.Vector3): number {
    let best = -1
    let bestD = PLAY_RANGE
    this.cabs.forEach((cab, i) => {
      const d = Math.hypot(p.x - cab.standX, p.z - cab.standZ)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }

  private hintNear = -1

  update(dt: number, playerPos: THREE.Vector3, input: ArcadeInput, dead: boolean): void {
    // The whole arcade sleeps unless you're in the neighbourhood.
    const around = Math.hypot(playerPos.x - AX, playerPos.z - AZ) < 90
    if (!around && this.playingIdx < 0) {
      this.showHint('')
      return
    }

    // Live run first: full frame rate, score readout, high-score watch.
    if (this.playingIdx >= 0) {
      const cab = this.cabs[this.playingIdx]
      const drift = Math.hypot(playerPos.x - cab.standX, playerPos.z - cab.standZ)
      if (dead || drift > DRIFT_STOP) {
        this.stop()
      } else {
        cab.game.update(dt, input, cab.ctx)
        cab.tex.needsUpdate = true
        const best = readBest(cab.game.title)
        this.overlayScore.textContent = `score ${cab.game.score}   best ${Math.max(best, cab.game.score)}`
        if (cab.game.over && !cab.wasOver) {
          cab.wasOver = true
          if (cab.game.score > best) {
            writeBest(cab.game.title, cab.game.score)
            this.onHighScore(cab.game.title, cab.game.score)
          }
        }
        if (!cab.game.over) cab.wasOver = false
      }
    }

    // Attract mode on everything else, at a lazy cadence, only when close.
    this.cabs.forEach((cab, i) => {
      if (i === this.playingIdx) return
      if (Math.hypot(playerPos.x - cab.x, playerPos.z - cab.z) > ATTRACT_RANGE) return
      cab.attractT += dt
      cab.repaintT += dt
      if (cab.repaintT < ATTRACT_FPS) return
      cab.repaintT = 0
      cab.game.attract(cab.attractT, cab.ctx)
      cab.tex.needsUpdate = true
    })

    // The prompt, meckie-style: only touch the DOM when the text changes.
    this.hintNear = this.playingIdx >= 0 ? this.playingIdx : this.nearest(playerPos)
    let text = ''
    if (this.playingIdx >= 0) text = 'X · walk away'
    else if (this.hintNear >= 0) text = `X · play ${this.cabs[this.hintNear].game.title}`
    this.showHint(text)
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

const STORE = 'shared-game.arcade.'

function readBest(title: string): number {
  try {
    return Number(localStorage.getItem(STORE + title)) || 0
  } catch {
    return 0
  }
}

function writeBest(title: string, score: number): void {
  try {
    localStorage.setItem(STORE + title, String(score))
  } catch {
    // Private mode; the brag still goes out, the record just doesn't stick.
  }
}
