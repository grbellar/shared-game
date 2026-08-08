import { ISLANDS, baseHeightAt, nearestIsland } from './world'
import { sfx } from './audio'

// The map. Tab to open it: the whole archipelago drawn from the terrain
// function itself, every friend in the room pinned on it, and one click to
// rocket to any of them (or to the island you aren't standing on).
//
// The terrain is sampled once and cached — the island shape is analytic and
// never changes, and craters are far too small to show up at this scale. Only
// the pins move, and those are DOM so the names stay readable at 12px while
// the map behind them keeps its chunky N64 pixels.

const MAP_W = 224 // sample resolution; upscaled 2x with nearest-neighbour
const MAP_H = 136
const VIEW_W = MAP_W * 2
const VIEW_H = MAP_H * 2

// World bounds the map covers: both terrain tiles, edge to edge.
const MIN_X = -170
const MAX_X = 390
const MIN_Z = -170
const MAX_Z = 170

export interface MapPlayer {
  id: string
  x: number
  z: number
  color: string
  name: string
}

export interface MapData {
  me: { x: number; z: number; ry: number; color: string; name: string }
  friends: MapPlayer[]
}

export class GameMap {
  // Where to rocket to. main.ts turns these into a RocketRide.launch.
  onPickPlayer: (id: string) => void = () => {}
  onPickIsland: (index: number) => void = () => {}
  data: () => MapData = () => ({ me: { x: 0, z: 0, ry: 0, color: '#fff', name: '' }, friends: [] })
  private root: HTMLDivElement
  private view: HTMLDivElement
  private me: HTMLDivElement
  private canvas: HTMLCanvasElement
  private islandChips: HTMLDivElement[] = []
  private pins = new Map<string, { el: HTMLDivElement; label: HTMLDivElement }>()
  private opened = false
  private painted = false

  constructor(touch: boolean) {
    document.head.appendChild(styleTag())

    this.root = document.createElement('div')
    this.root.id = 'map-root'
    this.root.hidden = true

    const panel = document.createElement('div')
    panel.id = 'map-panel'
    const title = document.createElement('div')
    title.id = 'map-title'
    title.textContent = 'THE ISLANDS'

    this.view = document.createElement('div')
    this.view.id = 'map-view'
    this.canvas = document.createElement('canvas')
    this.canvas.id = 'map-canvas'
    this.canvas.width = MAP_W
    this.canvas.height = MAP_H
    this.view.append(this.canvas)

    // One chip per island, sitting on it. Clicking one is a one-way ticket.
    ISLANDS.forEach((isl, i) => {
      const chip = document.createElement('div')
      chip.className = 'map-island'
      chip.textContent = isl.name
      const [px, py] = project(isl.x, isl.z)
      chip.style.left = `${px}%`
      chip.style.top = `${py}%`
      chip.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (chip.classList.contains('here')) return
        this.close()
        this.onPickIsland(i)
      })
      this.islandChips.push(chip)
      this.view.append(chip)
    })

    this.me = document.createElement('div')
    this.me.id = 'map-me'
    this.view.append(this.me)

    const hint = document.createElement('div')
    hint.id = 'map-hint'
    hint.textContent = 'click a friend to rocket to them'

    panel.append(title, this.view, hint)
    this.root.append(panel)
    document.body.append(this.root)

    if (touch) {
      const button = document.createElement('div')
      button.id = 'map-open'
      button.textContent = '🗺️'
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        this.toggle()
      })
      document.body.append(button)
    }

    window.addEventListener('keydown', (e) => {
      // Tab is the map. Not while the chat box has focus — there it's still
      // a Tab, and stealing it would trap the caret.
      if (e.code !== 'Tab' || e.repeat) return
      if ((document.activeElement as HTMLElement | null)?.tagName === 'INPUT') return
      e.preventDefault()
      this.toggle()
    })

    // Clicking outside the panel closes. Strictly the backdrop itself — a
    // bubbled click would otherwise make the title bar and the map's own open
    // water dismiss the thing you're trying to aim with.
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.close()
    })
  }

  get isOpen(): boolean {
    return this.opened
  }

  toggle(): void {
    if (this.opened) this.close()
    else this.open()
  }

  open(): void {
    // Normal play keeps the mouse locked for the camera. The wheels cope by
    // sweeping a virtual cursor, but this is a flat panel you point at, so
    // hand the real cursor back — clicking the canvas re-grabs it after.
    document.exitPointerLock?.()
    // 30k terrain samples, paid once on the first open rather than on the
    // startup path — the islands never change shape, so it never runs again.
    if (!this.painted) {
      this.painted = true
      paintTerrain(this.canvas)
    }
    this.opened = true
    this.root.hidden = false
    sfx.uiTick()
    this.update()
  }

  close(): void {
    if (!this.opened) return
    this.opened = false
    this.root.hidden = true
  }

  // Called every frame from the game loop; cheap no-op while closed.
  update(): void {
    if (!this.opened) return
    const { me, friends } = this.data()

    const [mx, my] = project(me.x, me.z)
    this.me.style.left = `${mx}%`
    this.me.style.top = `${my}%`
    // A triangle drawn pointing up, turned to face the way you are. Screen +y
    // is world +z, so the map's north is world -z and the angle flips.
    this.me.style.transform = `translate(-50%, -50%) rotate(${180 - (me.ry * 180) / Math.PI}deg)`
    this.me.style.borderBottomColor = me.color

    const here = nearestIsland(me.x, me.z)
    this.islandChips.forEach((chip, i) => chip.classList.toggle('here', i === here))

    // Pins for everyone currently in the room, minted and dropped as people
    // come and go.
    const seen = new Set<string>()
    for (const f of friends) {
      seen.add(f.id)
      let pin = this.pins.get(f.id)
      if (!pin) {
        const el = document.createElement('div')
        el.className = 'map-pin'
        const label = document.createElement('div')
        label.className = 'map-pin-label'
        el.append(label)
        el.addEventListener('pointerdown', (e) => {
          e.preventDefault()
          e.stopPropagation()
          this.close()
          this.onPickPlayer(f.id)
        })
        this.view.append(el)
        pin = { el, label }
        this.pins.set(f.id, pin)
      }
      const [px, py] = project(f.x, f.z)
      pin.el.style.left = `${px}%`
      pin.el.style.top = `${py}%`
      pin.el.style.background = f.color
      pin.label.textContent = f.name
    }
    for (const [id, pin] of this.pins) {
      if (seen.has(id)) continue
      pin.el.remove()
      this.pins.delete(id)
    }
  }
}

// World (x, z) to a position inside the map view, as percentages — the view
// shrinks to fit narrow screens (max-width: 92vw), and pins pinned in pixels
// would slide off the islands the moment it did.
function project(x: number, z: number): [number, number] {
  return [
    ((x - MIN_X) / (MAX_X - MIN_X)) * 100,
    ((z - MIN_Z) / (MAX_Z - MIN_Z)) * 100,
  ]
}

// The islands, painted straight out of baseHeightAt with the same colour
// bands buildTerrain uses, so the map reads as the world you're standing on.
function paintTerrain(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(MAP_W, MAP_H)
  const px = img.data
  for (let j = 0; j < MAP_H; j++) {
    const z = MIN_Z + ((j + 0.5) / MAP_H) * (MAX_Z - MIN_Z)
    for (let i = 0; i < MAP_W; i++) {
      const x = MIN_X + ((i + 0.5) / MAP_W) * (MAX_X - MIN_X)
      const h = baseHeightAt(x, z)
      let r: number
      let g: number
      let b: number
      if (h <= 0) {
        // Shoals pale, open ocean dark.
        const t = Math.max(0, Math.min(1, -h / 26))
        r = 63 - 33 * t
        g = 118 - 60 * t
        b = 201 - 80 * t
      } else if (h < 1) {
        r = 216
        g = 196
        b = 122
      } else if (h < 10.5) {
        // Lighter as it climbs, so the map shows the shape of the hills.
        const t = (h - 1) / 9.5
        r = 79 + 40 * t
        g = 158 + 40 * t
        b = 63 + 30 * t
      } else {
        r = 138
        g = 138
        b = 146
      }
      const o = (j * MAP_W + i) * 4
      px[o] = r
      px[o + 1] = g
      px[o + 2] = b
      px[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

function styleTag(): HTMLStyleElement {
  const style = document.createElement('style')
  style.textContent = `
    #map-root {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.55);
      z-index: 7;
      font: 12px monospace;
    }
    #map-panel {
      background: rgba(0, 0, 0, 0.88);
      border: 2px solid rgba(255, 255, 255, 0.35);
      padding: 10px;
      max-width: 96vw;
    }
    #map-title {
      color: #ffdf3a;
      letter-spacing: 2px;
      text-align: center;
      margin-bottom: 8px;
    }
    #map-view {
      position: relative;
      width: ${VIEW_W}px;
      height: ${VIEW_H}px;
      max-width: 92vw;
      border: 1px solid rgba(255, 255, 255, 0.25);
    }
    #map-canvas {
      display: block;
      width: 100%;
      height: 100%;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    #map-hint {
      color: rgba(255, 255, 255, 0.55);
      text-align: center;
      margin-top: 8px;
    }
    .map-island {
      position: absolute;
      transform: translate(-50%, -50%);
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.5);
      color: #fff;
      padding: 3px 7px;
      white-space: nowrap;
      cursor: pointer;
    }
    .map-island::before {
      content: '🚀 ';
    }
    .map-island:hover {
      background: rgba(90, 90, 100, 0.95);
      border-color: #fff;
    }
    /* The island you're already standing on isn't a destination. */
    .map-island.here {
      opacity: 0.5;
      cursor: default;
      border-style: dashed;
    }
    .map-island.here::before {
      content: '📍 ';
    }
    .map-pin {
      position: absolute;
      width: 10px;
      height: 10px;
      margin: -5px 0 0 -5px;
      border: 1px solid #000;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.7);
      cursor: pointer;
    }
    /* The dot is only 10px, so the name tag is part of the click target too —
       otherwise picking a friend on a 448px-wide map is a game of darts. */
    .map-pin-label {
      position: absolute;
      left: 50%;
      bottom: 12px;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.75);
      color: #fff;
      padding: 2px 5px;
      white-space: nowrap;
    }
    .map-pin:hover {
      box-shadow: 0 0 0 2px #fff;
    }
    .map-pin:hover .map-pin-label {
      background: #fff;
      color: #111;
    }
    #map-me {
      position: absolute;
      width: 0;
      height: 0;
      border-left: 6px solid transparent;
      border-right: 6px solid transparent;
      border-bottom: 11px solid #fff;
      filter: drop-shadow(0 0 1px #000);
      pointer-events: none;
    }
    #map-open {
      position: fixed;
      right: calc(env(safe-area-inset-right) + 24px);
      bottom: calc(env(safe-area-inset-bottom) + 296px);
      width: 72px;
      height: 72px;
      border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, 0.5);
      background: rgba(255, 255, 255, 0.15);
      font-size: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      touch-action: none;
      -webkit-tap-highlight-color: transparent;
      z-index: 6;
    }
  `
  return style
}
