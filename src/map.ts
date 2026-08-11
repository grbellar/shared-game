import { ISLANDS, baseHeightAt } from './world'
import { inRealm } from './realm'
import {
  WICHITA_X,
  WICHITA_Z,
  WICHITA_BOUNDS,
  inWichita,
  inOldTown,
  wichitaHeightAt,
} from './wichita'
import { BUILDINGS, ROADS } from './wichita-data'
import { inOz } from './oz'
import { DESTINATIONS } from './rocket'
import { sfx } from './audio'

// The map. Tab to open it: the whole archipelago drawn from the terrain
// function itself, every friend in the room pinned on it, and one click to
// rocket to any of them — or to any destination in rocket.ts, the castle
// included, from the button row underneath.
//
// The terrain is sampled once and cached — the island shape is analytic and
// never changes, and craters are far too small to show up at this scale. Only
// the pins move, and those are DOM so the names stay readable at 12px while
// the map behind them keeps its chunky N64 pixels.

const MAP_W = 224 // sample resolution; upscaled 2x with nearest-neighbour
const MAP_H = 136
const VIEW_W = MAP_W * 2
const VIEW_H = MAP_H * 2

// World bounds the island map covers: both terrain tiles, edge to edge.
const MIN_X = -170
const MAX_X = 390
const MIN_Z = -170
const MAX_Z = 170

// The Wichita inset: a real street map beside the islands, drawn from the
// same baked data the city itself is built from. The city is 2950x2170
// meters — five times the archipelago — so it gets its own canvas and its
// own projection rather than a share of the islands'.
const WMAP_W = 196
const WMAP_H = 144

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
  onPickDest: (index: number) => void = () => {}
  data: () => MapData = () => ({ me: { x: 0, z: 0, ry: 0, color: '#fff', name: '' }, friends: [] })
  private root: HTMLDivElement
  private view: HTMLDivElement
  private wview: HTMLDivElement
  private me: HTMLDivElement
  private canvas: HTMLCanvasElement
  private wcanvas: HTMLCanvasElement
  private dests: HTMLDivElement
  private destButtons: HTMLDivElement[] = []
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
    title.textContent = 'THE WORLD'

    // Two maps side by side (stacked on a narrow screen): the archipelago
    // and, five fog walls west of it, downtown Wichita.
    const views = document.createElement('div')
    views.id = 'map-views'

    this.view = document.createElement('div')
    this.view.id = 'map-view'
    this.canvas = document.createElement('canvas')
    this.canvas.id = 'map-canvas'
    this.canvas.width = MAP_W
    this.canvas.height = MAP_H
    this.view.append(this.canvas)

    this.wview = document.createElement('div')
    this.wview.id = 'map-wview'
    this.wcanvas = document.createElement('canvas')
    this.wcanvas.id = 'map-wcanvas'
    this.wcanvas.width = WMAP_W
    this.wcanvas.height = WMAP_H
    this.wview.append(this.wcanvas)
    // Landmark labels, same class as the island chips. Local city coords.
    for (const [lx, lz, label] of [
      [0, 60, 'downtown'],
      [1055, 10, '🕹 old town'],
      [-985, -729, '🔥 keeper'],
    ] as const) {
      const chip = document.createElement('div')
      chip.className = 'map-island'
      const [px, py] = wproject(WICHITA_X + lx, WICHITA_Z + lz)
      chip.style.left = `${px}%`
      chip.style.top = `${py}%`
      chip.textContent = label
      this.wview.append(chip)
    }

    // Labels only — which blob is which. Travel is the button row below, so
    // that the castle (1800 units east, nowhere near this map) is offered the
    // same way as everywhere else.
    ISLANDS.forEach((isl) => {
      const chip = document.createElement('div')
      chip.className = 'map-island'
      chip.textContent = isl.name
      const [px, py] = project(isl.x, isl.z)
      chip.style.left = `${px}%`
      chip.style.top = `${py}%`
      this.islandChips.push(chip)
      this.view.append(chip)
    })

    this.me = document.createElement('div')
    this.me.id = 'map-me'
    this.view.append(this.me)

    // Compass rose. Map-up is world -z, which is true north — the same north
    // Wichita's street grid runs on, so the rose never needs to rotate.
    const compass = document.createElement('div')
    compass.id = 'map-compass'
    for (const [dir, cls] of [['N', 'n'], ['E', 'e'], ['S', 's'], ['W', 'w']] as const) {
      const d = document.createElement('span')
      d.className = `map-compass-${cls}`
      d.textContent = dir
      compass.append(d)
    }
    const needle = document.createElement('div')
    needle.id = 'map-compass-needle'
    compass.append(needle)
    this.view.append(compass)

    // One button per destination. The one you're standing on is hidden rather
    // than greyed — a trip to where you already are isn't a choice.
    this.dests = document.createElement('div')
    this.dests.id = 'map-dests'
    DESTINATIONS.forEach((_dest, i) => {
      const button = document.createElement('div')
      button.className = 'map-dest'
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.close()
        this.onPickDest(i)
      })
      this.destButtons.push(button)
      this.dests.append(button)
    })

    const hint = document.createElement('div')
    hint.id = 'map-hint'
    hint.textContent = 'click a friend to rocket to them'

    views.append(this.view, this.wview)
    panel.append(title, views, this.dests, hint)
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
      paintWichita(this.wcanvas)
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

    // The marker rides whichever map you're actually on; in the realm or in
    // Oz there's no map to be on, and an off-panel marker (which is what
    // the island projection makes of x=1800) helps nobody.
    const meView =
      inWichita(me.x, me.z) ? this.wview : inRealm(me.x, me.z) || inOz(me.x, me.z) ? null : this.view
    this.me.style.display = meView ? '' : 'none'
    if (meView) {
      if (this.me.parentElement !== meView) meView.append(this.me)
      const [mx, my] = (meView === this.wview ? wproject : project)(me.x, me.z)
      this.me.style.left = `${mx}%`
      this.me.style.top = `${my}%`
      // A triangle drawn pointing up, turned to face the way you are. Screen
      // +y is world +z, so the map's north is world -z and the angle flips.
      this.me.style.transform = `translate(-50%, -50%) rotate(${180 - (me.ry * 180) / Math.PI}deg)`
      this.me.style.borderBottomColor = me.color
    }

    const here = DESTINATIONS.findIndex((dest) => dest.here(me.x, me.z))
    this.islandChips.forEach((chip, i) => chip.classList.toggle('here', i === here))
    // Straight display, not the hidden attribute: a class rule with a display
    // would beat [hidden] the same way #map-root did.
    this.destButtons.forEach((button, i) => {
      button.style.display = i === here ? 'none' : ''
      const dest = DESTINATIONS[i]
      // Headcount doubles as the only way to see who's at the castle, since
      // it's 1800 units east and can't be drawn on this map at all.
      const n = friends.filter((f) => dest.here(f.x, f.z)).length
      button.textContent = `${dest.icon} ${dest.name}${n ? `  (${n} there)` : ''}`
    })

    // Pins for everyone currently in the room, minted and dropped as people
    // come and go.
    const seen = new Set<string>()
    for (const f of friends) {
      // Anyone in the realm is off both maps entirely — they're counted on
      // the castle button instead. Oz players are off them too: fairyland
      // has no map, no button, and no rocket service (clicking their pin
      // would only bounce off the launch gate anyway).
      if (inRealm(f.x, f.z) || inOz(f.x, f.z)) continue
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
        pin = { el, label }
        this.pins.set(f.id, pin)
      }
      // Pinned to whichever map they're standing on — a friend at the arcade
      // used to project 400% off the island view's left edge.
      const view = inWichita(f.x, f.z) ? this.wview : this.view
      if (pin.el.parentElement !== view) view.append(pin.el)
      const [px, py] = (view === this.wview ? wproject : project)(f.x, f.z)
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

// Same, into the Wichita inset.
function wproject(x: number, z: number): [number, number] {
  const b = WICHITA_BOUNDS
  return [
    ((x - b.minX) / (b.maxX - b.minX)) * 100,
    ((z - b.minZ) / (b.maxZ - b.minZ)) * 100,
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

// The city, painted from the same baked data it's built from: terrain
// heights for prairie, river and sea, then every real building footprint
// (Old Town in its brick red), then the street grid stroked at true width.
// A genuine street map of downtown Wichita in 28k pixels, paid once.
function paintWichita(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!
  const b = WICHITA_BOUNDS
  const img = ctx.createImageData(WMAP_W, WMAP_H)
  const px = img.data
  for (let j = 0; j < WMAP_H; j++) {
    const z = b.minZ + ((j + 0.5) / WMAP_H) * (b.maxZ - b.minZ)
    for (let i = 0; i < WMAP_W; i++) {
      const x = b.minX + ((i + 0.5) / WMAP_W) * (b.maxX - b.minX)
      const h = wichitaHeightAt(x, z) ?? -20
      let r: number
      let g: number
      let bl: number
      if (h <= 0) {
        // The river reads pale, the rim-sea dark — the island map's bands.
        const t = Math.max(0, Math.min(1, -h / 26))
        r = 63 - 33 * t
        g = 118 - 60 * t
        bl = 201 - 80 * t
      } else {
        // Concrete slab; the prairie fringe takes over near the edges, the
        // same lerp the real terrain tile uses.
        const cw = (b.maxX - b.minX) / 2
        const cd = (b.maxZ - b.minZ) / 2
        const t = Math.max(
          (Math.abs(x - (b.minX + cw)) / cw) ** 3,
          (Math.abs(z - (b.minZ + cd)) / cd) ** 3,
        )
        const k = Math.min(1, t * 1.4)
        r = 185 - 58 * k
        g = 178 - 20 * k
        bl = 164 - 90 * k
      }
      const o = (j * WMAP_W + i) * 4
      px[o] = r
      px[o + 1] = g
      px[o + 2] = bl
      px[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  // Footprints and streets on top, in canvas space. Local city coords in,
  // pixels out.
  const sx = (lx: number) => ((lx + WICHITA_X - b.minX) / (b.maxX - b.minX)) * WMAP_W
  const sz = (lz: number) => ((lz + WICHITA_Z - b.minZ) / (b.maxZ - b.minZ)) * WMAP_H
  for (const bd of BUILDINGS) {
    ctx.beginPath()
    let cx = 0
    let cz = 0
    for (let i = 0; i < bd.p.length; i += 2) {
      cx += bd.p[i]
      cz += bd.p[i + 1]
      if (i === 0) ctx.moveTo(sx(bd.p[i]), sz(bd.p[i + 1]))
      else ctx.lineTo(sx(bd.p[i]), sz(bd.p[i + 1]))
    }
    ctx.closePath()
    const n = bd.p.length / 2
    ctx.fillStyle = inOldTown(cx / n, cz / n) ? '#8f4630' : '#7a6e60'
    ctx.fill()
  }
  const roadScale = WMAP_W / (b.maxX - b.minX)
  ctx.strokeStyle = '#54545c'
  ctx.lineCap = 'round'
  for (const r of ROADS) {
    if (r.w < 8) continue // alleys and footpaths are noise at this scale
    ctx.lineWidth = Math.max(0.7, r.w * roadScale)
    ctx.beginPath()
    for (let i = 0; i + 1 < r.p.length; i += 2) {
      if (i === 0) ctx.moveTo(sx(r.p[i]), sz(r.p[i + 1]))
      else ctx.lineTo(sx(r.p[i]), sz(r.p[i + 1]))
    }
    ctx.stroke()
  }
}

function styleTag(): HTMLStyleElement {
  const style = document.createElement('style')
  style.textContent = `
    /* MUST come with the rule below. An id selector beats the browser's
       [hidden] { display: none }, so setting .hidden on something an id rule
       gives a display to does exactly nothing and the overlay never goes
       away. The radial wheels dodge this only by never setting display. */
    #map-root[hidden] {
      display: none;
    }
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
    #map-views {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      align-items: center;
    }
    #map-view {
      position: relative;
      width: ${VIEW_W}px;
      height: ${VIEW_H}px;
      max-width: 92vw;
      border: 1px solid rgba(255, 255, 255, 0.25);
    }
    #map-wview {
      position: relative;
      width: ${WMAP_W * 2}px;
      height: ${WMAP_H * 2}px;
      max-width: 92vw;
      border: 1px solid rgba(255, 255, 255, 0.25);
    }
    #map-canvas, #map-wcanvas {
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
    /* Labels, not buttons — travel lives in #map-dests. */
    .map-island {
      position: absolute;
      transform: translate(-50%, -50%);
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.35);
      color: rgba(255, 255, 255, 0.8);
      padding: 3px 7px;
      white-space: nowrap;
      pointer-events: none;
    }
    .map-island.here {
      border-color: #fff;
      color: #fff;
    }
    .map-island.here::before {
      content: '📍 ';
    }
    #map-dests {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: center;
      margin-top: 8px;
    }
    .map-dest {
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.5);
      color: #fff;
      padding: 5px 9px;
      white-space: nowrap;
      cursor: pointer;
    }
    .map-dest:hover {
      background: rgba(90, 90, 100, 0.95);
      border-color: #fff;
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
    #map-compass {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.65);
      border: 1px solid rgba(255, 255, 255, 0.45);
      pointer-events: none;
      color: rgba(255, 255, 255, 0.75);
      font-size: 10px;
      line-height: 1;
    }
    #map-compass span {
      position: absolute;
    }
    .map-compass-n {
      top: 3px;
      left: 50%;
      transform: translateX(-50%);
      color: #ff6b5e;
      font-weight: bold;
    }
    .map-compass-e {
      right: 4px;
      top: 50%;
      transform: translateY(-50%);
    }
    .map-compass-s {
      bottom: 3px;
      left: 50%;
      transform: translateX(-50%);
    }
    .map-compass-w {
      left: 4px;
      top: 50%;
      transform: translateY(-50%);
    }
    /* Two stacked triangles: red half pointing at N, pale half at S. */
    #map-compass-needle {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 0;
      height: 0;
      transform: translateX(-50%);
      border-left: 3px solid transparent;
      border-right: 3px solid transparent;
      border-bottom: 9px solid #ff6b5e;
      margin-top: -9px;
    }
    #map-compass-needle::after {
      content: '';
      position: absolute;
      left: -3px;
      top: 9px;
      border-left: 3px solid transparent;
      border-right: 3px solid transparent;
      border-top: 9px solid rgba(255, 255, 255, 0.6);
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
