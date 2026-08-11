import * as THREE from 'three'
import { WICHITA_X, WICHITA_Z, WICHITA_GROUND } from './wichita'

// The Old Town Theatre: a brick movie house across Douglas from the arcade,
// marquee out front, rows of seats inside, and a screen that is always
// running something. A nod to the Warren, Old Town's real picture palace.
// The lot at local (1030, -50) scanned clear of the baked footprints.
//
// The film is the fun part: four little procedural silent shorts, drawn on a
// 64x48 canvas and driven off the SHARED day/night clock (main.ts passes
// daynight's hours in). Same clock everywhere → every client is watching the
// same frame of the same short, and scrubbing the room's clock scrubs the
// movie. Zero network traffic, exactly like the rest of the world.

const TX = WICHITA_X + 1030
const TZ = WICHITA_Z - 50
const G = WICHITA_GROUND
// Shell, outer size. The door faces +z: toward Douglas Ave.
const W = 26
const D = 22
const H = 9

const BRICK = 0x7e3c2c
const TRIM = 0x241c1a
const SEAT = 0x6e2434
const NEON = 0xffb03a

// One clock-hour of room time runs this many seconds of film, so a short
// with SHORT_S seconds of footage loops a few times an evening and the
// programme changes every couple of hours.
const FILM_RATE = 240
const SHORT_S = 40
const TITLE_S = 5 // title card up front

interface Short {
  title: string
  draw(t: number, g: CanvasRenderingContext2D): void
}

const SW = 64
const SH = 48

function sky(g: CanvasRenderingContext2D, c: string): void {
  g.fillStyle = c
  g.fillRect(0, 0, SW, SH)
}

function card(g: CanvasRenderingContext2D, lines: string[]): void {
  sky(g, '#111')
  g.strokeStyle = '#c9bfa8'
  g.strokeRect(3.5, 3.5, SW - 7, SH - 7)
  g.fillStyle = '#e8dfc4'
  g.font = 'bold 8px monospace'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  lines.forEach((s, i) => g.fillText(s, SW / 2, SH / 2 + (i - (lines.length - 1) / 2) * 10, SW - 10))
}

// The programme. Everything is a closed-form function of film-time t, so a
// late joiner's first frame already agrees with everyone else's.
const SHORTS: Short[] = [
  {
    title: 'THE CHASE',
    draw(t, g) {
      sky(g, '#b8b0a0')
      g.fillStyle = '#8a8478'
      g.fillRect(0, 38, SW, 10) // the street
      for (let i = 0; i < 4; i++) {
        g.fillStyle = '#6e685c'
        g.fillRect(((i * 20 - t * 6) % 80 + 80) % 80 - 8, 16, 10, 22) // storefronts crawling by
      }
      // The little guy, the big guy, forever.
      const bob = Math.abs(Math.sin(t * 9)) * 2
      const x1 = 14 + Math.sin(t * 0.7) * 6
      g.fillStyle = '#222'
      g.fillRect(x1, 30 - bob, 5, 8)
      g.fillRect(x1 + 1, 26 - bob, 3, 4)
      const x2 = x1 + 13 + Math.sin(t * 1.1) * 3
      g.fillRect(x2, 28 - Math.abs(Math.sin(t * 9 + 1)) * 2, 7, 10)
      g.fillRect(x2 + 2, 23 - Math.abs(Math.sin(t * 9 + 1)) * 2, 4, 5)
    },
  },
  {
    title: 'TRIP TO THE MOON',
    draw(t, g) {
      sky(g, '#0a0a18')
      g.fillStyle = '#fff'
      for (let i = 0; i < 14; i++) g.fillRect((i * 17 + 5) % SW, (i * 11 + 3) % SH, 1, 1)
      // The moon with the face, waiting for it.
      g.fillStyle = '#d8d2b8'
      g.beginPath()
      g.arc(50, 12, 8, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#8a846c'
      g.fillRect(46, 10, 2, 2)
      g.fillRect(52, 10, 2, 2)
      g.fillRect(48, 15, 5, 1)
      // The rocket, on its way the whole short; landing is implied, tastefully.
      const u = Math.min(1, t / 30)
      const rx = 6 + u * 38
      const ry = 40 - u * 30
      g.fillStyle = '#c8c8d0'
      g.fillRect(rx, ry, 4, 7)
      g.fillStyle = '#d03a3a'
      g.fillRect(rx, ry - 3, 4, 3)
      if (Math.floor(t * 10) % 2) {
        g.fillStyle = '#ffb03a'
        g.fillRect(rx + 1, ry + 7, 2, 3)
      }
      if (u >= 1) {
        g.fillStyle = '#222'
        g.fillRect(49, 9, 2, 3) // ouch
      }
    },
  },
  {
    title: 'TUMBLEWEED',
    draw(t, g) {
      sky(g, '#c9a86a')
      g.fillStyle = '#a87e46'
      g.fillRect(0, 36, SW, 12)
      g.fillStyle = '#3f6a3f'
      g.fillRect(52, 24, 4, 12) // the cactus abides
      g.fillRect(50, 27, 2, 3)
      g.fillRect(56, 29, 2, 3)
      // Kansas wind doing Kansas things.
      const x = ((t * 11) % 90) - 10
      const y = 34 - Math.abs(Math.sin(t * 5)) * 4
      g.strokeStyle = '#6e5426'
      g.beginPath()
      g.arc(x, y, 4, 0, Math.PI * 2)
      g.moveTo(x - 3, y - 2)
      g.lineTo(x + 3, y + 2)
      g.moveTo(x - 3, y + 2)
      g.lineTo(x + 3, y - 2)
      g.stroke()
      const s = Math.sin(t * 0.9) * 10
      g.fillStyle = '#e8dfc4'
      g.beginPath()
      g.arc(12 + s, 8, 4, 0, Math.PI * 2) // one lazy cloud
      g.arc(17 + s, 9, 3, 0, Math.PI * 2)
      g.fill()
    },
  },
  {
    title: 'THE BEAST OF THE BAY',
    draw(t, g) {
      sky(g, '#1c2c48')
      g.fillStyle = '#d8d2b8'
      g.beginPath()
      g.arc(52, 9, 5, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#2c5276'
      g.fillRect(0, 28, SW, 20)
      // She swims the bay all night: neck, then the humps, in house green.
      const x = ((t * 8) % 100) - 18
      g.fillStyle = '#3f7a4f'
      g.fillRect(x, 18, 4, 10)
      g.fillRect(x - 1, 15, 6, 4)
      for (let i = 1; i <= 3; i++) {
        const hx = x - i * 9
        const hy = 27 - Math.abs(Math.sin(t * 2.2 + i)) * 4
        g.beginPath()
        g.arc(hx, hy + 4, 4, Math.PI, 0)
        g.fill()
      }
    },
  },
]

function lambert(color: number, emissive = 0): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, emissive, flatShading: true })
}

function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
}

export class Theater {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private tex: THREE.CanvasTexture
  private marqueeCtx: CanvasRenderingContext2D
  private marqueeTex: THREE.CanvasTexture
  private marqueeShown = ''

  constructor(scene: THREE.Scene) {
    const shell = new THREE.Group()
    shell.name = 'oldtown-theater'
    shell.position.set(TX, G, TZ)
    const brick = lambert(BRICK)
    const trim = lambert(TRIM)

    // Shell: three walls and a doored front facing Douglas (+z here).
    const back = box(W, H, 0.6, brick)
    back.position.set(0, H / 2, -D / 2 + 0.3)
    const left = box(0.6, H, D, brick)
    left.position.set(-W / 2 + 0.3, H / 2, 0)
    const right = box(0.6, H, D, brick)
    right.position.set(W / 2 - 0.3, H / 2, 0)
    const doorW = 6
    for (const side of [-1, 1]) {
      const seg = box((W - doorW) / 2, H, 0.6, brick)
      seg.position.set(side * (doorW / 2 + (W - doorW) / 4), H / 2, D / 2 - 0.3)
      shell.add(seg)
    }
    const header = box(doorW, 3, 0.6, trim)
    header.position.set(0, H - 1.5, D / 2 - 0.3)
    const roof = box(W, 0.5, D, trim)
    roof.position.set(0, H + 0.25, 0)
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W - 1, D - 1), lambert(0x2c1c22))
    floor.rotation.x = -Math.PI / 2
    floor.position.y = 0.05
    shell.add(back, left, right, header, roof, floor)

    // The marquee: canopy, bulbs faked with an emissive band, and a
    // letterboard that names whatever the clock says is showing.
    const canopy = box(11, 0.5, 3, trim)
    canopy.position.set(0, 5.4, D / 2 + 1.4)
    const band = box(11, 0.2, 3.2, lambert(0x4a3208, NEON))
    band.position.set(0, 5.1, D / 2 + 1.4)
    shell.add(canopy, band)
    const mcv = document.createElement('canvas')
    mcv.width = 64
    mcv.height = 16
    this.marqueeCtx = mcv.getContext('2d')!
    this.marqueeTex = new THREE.CanvasTexture(mcv)
    this.marqueeTex.magFilter = THREE.NearestFilter
    this.marqueeTex.minFilter = THREE.NearestFilter
    this.marqueeTex.colorSpace = THREE.SRGBColorSpace
    const letterboard = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 2.2),
      new THREE.MeshBasicMaterial({ map: this.marqueeTex }),
    )
    letterboard.position.set(0, 6.6, D / 2 + 1.45)
    shell.add(letterboard)
    // The vertical blade with the house name, one letter per line.
    const bcv = document.createElement('canvas')
    bcv.width = 16
    bcv.height = 64
    const bg = bcv.getContext('2d')!
    bg.fillStyle = '#241c1a'
    bg.fillRect(0, 0, 16, 64)
    bg.fillStyle = '#ffb03a'
    bg.font = 'bold 9px monospace'
    bg.textAlign = 'center'
    'OLDTOWN'.split('').forEach((ch, i) => bg.fillText(ch, 8, 9 + i * 8.2))
    const bladeTex = new THREE.CanvasTexture(bcv)
    bladeTex.magFilter = THREE.NearestFilter
    bladeTex.minFilter = THREE.NearestFilter
    bladeTex.colorSpace = THREE.SRGBColorSpace
    const blade = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 5.6),
      new THREE.MeshBasicMaterial({ map: bladeTex, side: THREE.DoubleSide }),
    )
    blade.position.set(-6.8, 7.6, D / 2 + 0.9)
    shell.add(blade)

    // Inside: the screen on the back wall, glowing like it should, and rows
    // of seats with a centre aisle. Seats are scenery, like the buildings —
    // stand anywhere, the fog can't reach you in here anyway.
    this.canvas = document.createElement('canvas')
    this.canvas.width = SW
    this.canvas.height = SH
    this.ctx = this.canvas.getContext('2d')!
    this.tex = new THREE.CanvasTexture(this.canvas)
    this.tex.magFilter = THREE.NearestFilter
    this.tex.minFilter = THREE.NearestFilter
    this.tex.colorSpace = THREE.SRGBColorSpace
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 10.5),
      new THREE.MeshBasicMaterial({ map: this.tex }),
    )
    screen.position.set(0, 5.6, -D / 2 + 0.75)
    const frame = box(15.2, 11.4, 0.2, trim)
    frame.position.set(0, 5.6, -D / 2 + 0.62)
    shell.add(frame, screen)

    const seatMat = lambert(SEAT)
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 8; col++) {
        if (col === 3 || col === 4) continue // the aisle
        const sx = (col - 3.5) * 2.2
        const sz = 1.5 + row * 2.4
        const seat = box(1.5, 0.5, 1.3, seatMat)
        seat.position.set(sx, 0.5, sz)
        const backrest = box(1.5, 1, 0.3, seatMat)
        backrest.position.set(sx, 1, sz + 0.6)
        shell.add(seat, backrest)
      }
    }
    scene.add(shell)
  }

  // Every frame from main.ts with the shared clock and where you are. The
  // reel only spins while somebody local is close enough to see the screen.
  update(hours: number, playerPos: THREE.Vector3): void {
    if (Math.hypot(playerPos.x - TX, playerPos.z - TZ) > 120) return
    const film = hours * FILM_RATE
    const slot = SHORT_S + TITLE_S
    const which = Math.floor(film / slot) % SHORTS.length
    const t = film % slot
    const short = SHORTS[which]
    if (t < TITLE_S) card(this.ctx, ['~', short.title, '~'])
    else short.draw(t - TITLE_S, this.ctx)
    // Sprocket grain: a couple of flickering scratches, cheap and period.
    if (Math.floor(film * 8) % 5 === 0) {
      this.ctx.fillStyle = 'rgba(255,255,255,0.12)'
      this.ctx.fillRect(((film * 37) % SW + SW) % SW, 0, 1, SH)
    }
    this.tex.needsUpdate = true

    if (short.title !== this.marqueeShown) {
      this.marqueeShown = short.title
      const g = this.marqueeCtx
      g.fillStyle = '#1a1410'
      g.fillRect(0, 0, 64, 16)
      g.fillStyle = '#ffe6b8'
      g.font = 'bold 7px monospace'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText('NOW SHOWING', 32, 4, 60)
      g.fillText(short.title, 32, 12, 60)
      this.marqueeTex.needsUpdate = true
    }
  }
}
