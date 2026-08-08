// Radial item pickers: hold the wheel's key (E for hand items, Q for rides),
// sweep toward a wedge, release to equip it. Tap the key instead and the
// wheel sticks open: click a wedge, or tap again to back out. Same
// virtual-cursor trick as the emote wheel so it works under pointer lock.
// The wedge for what you have equipped right now is outlined in yellow.

import { sfx } from './audio'

export interface WheelItem {
  id: string
  icon: string
  label: string // shown under the icon, prefixed by its hotkey in main.ts
}

const RADIUS = 92 // px from hub to wedge center
const DEADZONE = 30 // cursor travel before anything is selected
const OUTER = RADIUS + 48 // past this the pointer is outside the wheel
const HOLD_MS = 350 // longer than this and releasing commits; shorter is a tap

let styled = false
let openNow: ItemWheel | null = null // opening one wheel closes the other

export class ItemWheel {
  private root: HTMLDivElement
  private hub: HTMLDivElement
  private dot: HTMLDivElement
  private chips: HTMLDivElement[] = []
  private opened = false
  private openedAt = 0
  private selected = -1
  private cx = 0 // cursor relative to the hub (which sits at screen center)
  private cy = 0
  private mouseX = 0 // last real mouse position, for the highlight on open
  private mouseY = 0

  constructor(
    private key: string, // e.g. 'KeyE'
    private title: string, // hub text while nothing is selected
    private items: WheelItem[],
    private getCurrent: () => string,
    private onPick: (id: string) => void,
  ) {
    if (!styled) {
      styled = true
      document.head.appendChild(styleTag())
    }

    this.root = document.createElement('div')
    this.root.className = 'iw-wheel'
    this.root.hidden = true

    const backdrop = document.createElement('div')
    backdrop.className = 'iw-backdrop'
    this.hub = document.createElement('div')
    this.hub.className = 'iw-hub'
    this.dot = document.createElement('div')
    this.dot.className = 'iw-dot'
    this.root.append(backdrop, this.hub, this.dot)

    items.forEach((item, i) => {
      const angle = (i / items.length) * Math.PI * 2 // 0 = up, clockwise
      const chip = document.createElement('div')
      chip.className = 'iw-chip'
      chip.style.transform = `translate(-50%, -50%) translate(${Math.sin(angle) * RADIUS}px, ${-Math.cos(angle) * RADIUS}px)`
      const icon = document.createElement('div')
      icon.className = 'iw-icon'
      icon.textContent = item.icon
      const label = document.createElement('div')
      label.className = 'iw-label'
      label.textContent = item.label
      chip.append(icon, label)
      chip.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.select(i)
        this.commit()
      })
      this.chips.push(chip)
      this.root.append(chip)
    })

    document.body.append(this.root)

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
        this.cx = e.clientX - window.innerWidth / 2
        this.cy = e.clientY - window.innerHeight / 2
      }
      this.selectFromCursor()
    })

    window.addEventListener('keydown', (e) => {
      if (e.code !== this.key || e.repeat) return
      if (this.opened) this.close()
      else this.open()
    })

    window.addEventListener('keyup', (e) => {
      if (e.code !== this.key || !this.opened) return
      // Held long enough to be a sweep? Commit on release. A quick tap
      // instead leaves the wheel up, waiting for a click.
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

  private open(): void {
    if (openNow && openNow !== this) openNow.close()
    openNow = this
    this.opened = true
    this.openedAt = performance.now()
    const locked = document.pointerLockElement !== null
    // With a visible cursor the wheel opens under it, so highlight whatever
    // it is already pointing at. Locked, the virtual cursor starts centered.
    this.cx = locked ? 0 : this.mouseX - window.innerWidth / 2
    this.cy = locked ? 0 : this.mouseY - window.innerHeight / 2
    this.dot.hidden = !locked
    this.root.hidden = false
    const current = this.getCurrent()
    this.chips.forEach((chip, i) => chip.classList.toggle('now', this.items[i].id === current))
    this.selected = -1
    this.selectFromCursor()
  }

  private close(): void {
    this.opened = false
    this.root.hidden = true
    if (openNow === this) openNow = null
  }

  private commit(): void {
    const picked = this.selected >= 0 ? this.items[this.selected] : null
    this.close()
    if (picked) this.onPick(picked.id)
  }

  private selectFromCursor(): void {
    this.dot.style.transform = `translate(-50%, -50%) translate(${this.cx}px, ${this.cy}px)`
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
    this.hub.textContent = index >= 0 ? this.items[index].label : this.title
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
    .iw-backdrop {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 340px;
      height: 340px;
      transform: translate(-50%, -50%);
      background: radial-gradient(circle, rgba(0, 0, 0, 0.6) 45%, rgba(0, 0, 0, 0) 72%);
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
      width: 56px;
      height: 56px;
      gap: 2px;
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
    .iw-icon {
      font-size: 21px;
      line-height: 1;
    }
    .iw-label {
      font-size: 9px;
      letter-spacing: 0.5px;
    }
    .iw-hub {
      width: 74px;
      height: 26px;
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
  `
  return style
}
