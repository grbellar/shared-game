// Radial item pickers: hold the wheel's key (E for hand items, Q for rides,
// X for emotes), sweep toward a wedge, release to equip it. Tap the key
// instead and the wheel sticks open: click a wedge, press its number, or tap
// again to back out. Same virtual-cursor trick throughout so it works under
// pointer lock.
//
// Each wedge shows the actual thing — the real mesh, turning, rendered at 64px
// (see preview.ts) — rather than an emoji standing in for it. That's why the
// wheel is as big as it is: a bazooka needs room to look like a bazooka. The
// wedge for what you have equipped right now is outlined in yellow.

import { sfx } from './audio'
import type { Preview } from './preview'

export interface WheelItem {
  id: string
  label: string // shown under the preview
  key?: string // hotkey badge in the corner of the wedge
  preview: () => Preview
}

export interface WheelOpts {
  key: string // e.g. 'KeyE'
  title: string // hub text while nothing is selected
  items: WheelItem[]
  onPick: (id: string) => void
  getCurrent?: () => string // which wedge gets the "equipped" outline
  digits?: boolean // 1-9 select a wedge while the wheel is open
  touchIcon?: string // if set, a touch button that opens the wheel
}

// Nine wedges is the widest wheel we have. Neighbours on a ring of R sit
// 2·R·sin(π/9) apart, and two squares of side S can't overlap once that
// distance clears S·√2 — hence 200 for a 96px wedge.
const RADIUS = 200 // px from hub to wedge center
const DEADZONE = 52 // cursor travel before anything is selected
const OUTER = RADIUS + 76 // past this the pointer is outside the wheel
const HOLD_MS = 350 // longer than this and releasing commits; shorter is a tap
// A full-size wheel wants ~540px of screen. Anything tighter (phones, a small
// window) shrinks the whole thing rather than spilling off the edges.
const WHEEL_PX = 560

let styled = false
let openNow: ItemWheel | null = null // opening one wheel closes the other

export class ItemWheel {
  private root: HTMLDivElement
  private ring: HTMLDivElement
  private hub: HTMLDivElement
  private dot: HTMLDivElement
  private chips: HTMLDivElement[] = []
  private items: WheelItem[]
  private previews: Preview[] = []
  private opened = false
  private openedAt = 0
  private lastFrame = 0
  private selected = -1
  private scale = 1
  private cx = 0 // cursor relative to the hub (which sits at screen center)
  private cy = 0
  private mouseX = 0 // last real mouse position, for the highlight on open
  private mouseY = 0

  constructor(private opts: WheelOpts) {
    this.items = opts.items
    if (!styled) {
      styled = true
      document.head.appendChild(styleTag())
    }

    this.root = document.createElement('div')
    this.root.className = 'iw-wheel'
    this.root.hidden = true
    // Everything that scales with the window lives on the ring; the cursor dot
    // does not, so a virtual sweep travels the same distance on any screen.
    this.ring = document.createElement('div')
    this.ring.className = 'iw-ring'

    const backdrop = document.createElement('div')
    backdrop.className = 'iw-backdrop'
    this.hub = document.createElement('div')
    this.hub.className = 'iw-hub'
    this.dot = document.createElement('div')
    this.dot.className = 'iw-dot'
    this.ring.append(backdrop, this.hub)
    this.root.append(this.ring, this.dot)

    this.items.forEach((item, i) => {
      const angle = (i / this.items.length) * Math.PI * 2 // 0 = up, clockwise
      const chip = document.createElement('div')
      chip.className = 'iw-chip'
      chip.style.transform = `translate(-50%, -50%) translate(${Math.sin(angle) * RADIUS}px, ${-Math.cos(angle) * RADIUS}px)`
      const art = document.createElement('div')
      art.className = 'iw-art'
      const label = document.createElement('div')
      label.className = 'iw-label'
      label.textContent = item.label
      chip.append(art)
      if (item.key) {
        const badge = document.createElement('div')
        badge.className = 'iw-key'
        badge.textContent = item.key
        chip.append(badge)
      }
      chip.append(label)
      chip.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.select(i)
        this.commit()
      })
      this.chips.push(chip)
      this.ring.append(chip)
    })

    document.body.append(this.root)
    this.hub.textContent = opts.title
    this.fit()
    window.addEventListener('resize', () => this.fit())

    if (opts.touchIcon) {
      const button = document.createElement('div')
      button.className = 'iw-open'
      button.textContent = opts.touchIcon
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        if (this.opened) this.close()
        else this.open()
      })
      document.body.append(button)
    }

    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX
      this.mouseY = e.clientY
      if (!this.opened) return
      if (document.pointerLockElement) {
        // First person: no visible cursor, so sweep a virtual one and pin it
        // to the ring once it gets there.
        this.cx += e.movementX
        this.cy += e.movementY
        const len = Math.hypot(this.cx, this.cy)
        if (len > OUTER) {
          this.cx *= OUTER / len
          this.cy *= OUTER / len
        }
      } else {
        // Real cursor: undo the shrink, so the pointer picks the wedge it is
        // actually sitting on.
        this.cx = (e.clientX - window.innerWidth / 2) / this.scale
        this.cy = (e.clientY - window.innerHeight / 2) / this.scale
      }
      this.selectFromCursor()
    })

    window.addEventListener('keydown', (e) => {
      if (e.code === this.opts.key && !e.repeat) {
        if (this.opened) this.close()
        else this.open()
        return
      }
      if (!this.opened || !this.opts.digits) return
      const digit = /^Digit([1-9])$/.exec(e.code)
      if (!digit || Number(digit[1]) > this.items.length) return
      e.preventDefault()
      // Digits mean something else when no wheel is up (equip a weapon, pick a
      // build material). While one is open, it owns them.
      e.stopImmediatePropagation()
      this.select(Number(digit[1]) - 1)
      this.commit()
    })

    window.addEventListener('keyup', (e) => {
      if (e.code !== this.opts.key || !this.opened) return
      // Held long enough to be a sweep? Commit on release. A quick tap
      // instead leaves the wheel up, waiting for a click or a number key.
      if (performance.now() - this.openedAt > HOLD_MS) this.commit()
    })

    // Clicking anywhere else commits the highlighted wedge (or just closes).
    // Registered before main.ts's attack handler, so stopping here is what
    // keeps a wedge click from also firing a rocket.
    window.addEventListener('mousedown', (e) => {
      if (!this.opened) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.button === 2) this.close()
      else this.commit()
    })
  }

  get isOpen(): boolean {
    return this.opened
  }

  private fit(): void {
    this.scale = Math.min(1, Math.min(window.innerWidth, window.innerHeight) / WHEEL_PX)
    this.ring.style.transform = `scale(${this.scale})`
  }

  private open(): void {
    if (openNow && openNow !== this) openNow.close()
    openNow = this
    this.opened = true
    this.openedAt = performance.now()
    // Meshes are built on first open, not at load: a wheel nobody touches
    // shouldn't cost a WebGL context or a scene per wedge.
    if (!this.previews.length) {
      this.previews = this.items.map((item, i) => {
        const preview = item.preview()
        this.chips[i].querySelector('.iw-art')!.append(preview.canvas)
        return preview
      })
    }
    const locked = document.pointerLockElement !== null
    // With a visible cursor the wheel opens under it, so highlight whatever
    // it is already pointing at. Locked, the virtual cursor starts centered.
    this.cx = locked ? 0 : (this.mouseX - window.innerWidth / 2) / this.scale
    this.cy = locked ? 0 : (this.mouseY - window.innerHeight / 2) / this.scale
    this.dot.hidden = !locked
    this.root.hidden = false
    const current = this.opts.getCurrent?.()
    this.chips.forEach((chip, i) => {
      chip.classList.toggle('now', this.items[i].id === current)
      // Cleared here rather than in select(), which bails early when the
      // highlight hasn't changed — and reopening in the deadzone would
      // otherwise leave last time's wedge lit.
      chip.classList.remove('on')
    })
    this.hub.textContent = this.opts.title
    this.hub.classList.remove('on')
    this.selected = -1
    this.selectFromCursor()
    this.lastFrame = performance.now()
    requestAnimationFrame(this.animate)
  }

  // The previews only turn while the wheel is up, so closing it stops all the
  // rendering dead.
  private animate = (now: number): void => {
    if (!this.opened) return
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000)
    this.lastFrame = now
    for (const preview of this.previews) preview.draw(dt)
    requestAnimationFrame(this.animate)
  }

  private close(): void {
    this.opened = false
    this.root.hidden = true
    if (openNow === this) openNow = null
  }

  private commit(): void {
    const picked = this.selected >= 0 ? this.items[this.selected] : null
    this.close()
    if (picked) this.opts.onPick(picked.id)
  }

  private selectFromCursor(): void {
    const s = this.scale
    this.dot.style.transform = `translate(-50%, -50%) translate(${this.cx * s}px, ${this.cy * s}px)`
    const r = Math.hypot(this.cx, this.cy)
    // Dead in the middle, and dead outside the ring — so releasing the key
    // with the pointer parked off in a corner doesn't equip something random.
    if (r < DEADZONE || r > OUTER) {
      this.select(-1)
      return
    }
    const step = (Math.PI * 2) / this.items.length
    const angle = Math.atan2(this.cx, -this.cy) // 0 = up, clockwise
    const index = ((Math.round(angle / step) % this.items.length) + this.items.length) % this.items.length
    this.select(index)
  }

  private select(index: number): void {
    if (index === this.selected) return
    this.selected = index
    this.chips.forEach((chip, i) => chip.classList.toggle('on', i === index))
    this.hub.textContent = index >= 0 ? this.items[index].label : this.opts.title
    this.hub.classList.toggle('on', index >= 0)
    if (index >= 0) sfx.uiTick()
  }
}

function styleTag(): HTMLStyleElement {
  const style = document.createElement('style')
  style.textContent = `
    .iw-wheel {
      position: fixed;
      left: 50%;
      top: 50%;
      width: 0;
      height: 0;
      pointer-events: none;
      z-index: 5;
      font: 12px monospace;
    }
    .iw-ring {
      position: absolute;
      left: 0;
      top: 0;
      width: 0;
      height: 0;
    }
    /* The wheel lands on top of your own character and name tag, so it needs
       its own ground to sit on. */
    .iw-backdrop {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 700px;
      height: 700px;
      transform: translate(-50%, -50%);
      background: radial-gradient(circle, rgba(0, 0, 0, 0.72) 42%, rgba(0, 0, 0, 0) 70%);
    }
    .iw-chip, .iw-hub {
      position: absolute;
      left: 50%;
      top: 50%;
      background: rgba(0, 0, 0, 0.88);
      border: 2px solid rgba(255, 255, 255, 0.28);
      color: rgba(255, 255, 255, 0.75);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .iw-chip {
      width: 96px;
      height: 96px;
      padding-bottom: 3px;
      pointer-events: auto;
      cursor: pointer;
    }
    .iw-chip.now {
      border-color: rgba(255, 223, 58, 0.8);
      color: #ffdf3a;
    }
    .iw-chip.on {
      border-color: #fff;
      background: rgba(80, 80, 90, 0.95);
      color: #fff;
    }
    .iw-art {
      width: 68px;
      height: 68px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    /* 64px of render blown up to 68 — nearest-neighbour, like the game. */
    .iw-art canvas {
      width: 68px;
      height: 68px;
      image-rendering: pixelated;
    }
    .iw-key {
      position: absolute;
      left: 4px;
      top: 3px;
      font-size: 10px;
      color: rgba(255, 255, 255, 0.55);
    }
    .iw-chip.on .iw-key {
      color: #fff;
    }
    .iw-label {
      font-size: 10px;
      letter-spacing: 0.5px;
    }
    .iw-hub {
      width: 96px;
      height: 28px;
      transform: translate(-50%, -50%);
      border-color: rgba(255, 255, 255, 0.18);
      font-size: 10px;
    }
    .iw-hub.on {
      color: #fff;
      border-color: rgba(255, 255, 255, 0.5);
    }
    .iw-dot {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 6px;
      height: 6px;
      background: #fff;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.7);
      transform: translate(-50%, -50%);
    }
    .iw-open {
      position: fixed;
      right: calc(env(safe-area-inset-right) + 24px);
      bottom: calc(env(safe-area-inset-bottom) + 208px);
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
