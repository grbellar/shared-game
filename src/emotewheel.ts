// Radial emote menu. Hold X, sweep toward a wedge, release to play it.
// Tap X instead and the wheel sticks open: click a wedge, press 1-6, or
// press X again to back out.
//
// The pointer is locked in first person, so selection runs off a virtual
// cursor fed by movementX/Y — that way one code path covers both modes.

import { EMOTES } from './emotes'
import { sfx } from './audio'

const RADIUS = 92 // px from hub to wedge center
const DEADZONE = 30 // cursor travel before anything is selected
const OUTER = RADIUS + 48 // past this the pointer is outside the wheel
const HOLD_MS = 350 // longer than this and releasing X commits; shorter is a tap

export class EmoteWheel {
  onPick: (id: string) => void = () => {}
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

  constructor(touch: boolean) {
    document.head.appendChild(styleTag())

    this.root = document.createElement('div')
    this.root.id = 'emote-wheel'
    this.root.hidden = true

    const backdrop = document.createElement('div')
    backdrop.id = 'emote-backdrop'
    this.hub = document.createElement('div')
    this.hub.id = 'emote-hub'
    this.dot = document.createElement('div')
    this.dot.id = 'emote-dot'
    this.root.append(backdrop, this.hub, this.dot)

    EMOTES.forEach((emote, i) => {
      const angle = (i / EMOTES.length) * Math.PI * 2 // 0 = up, clockwise
      const chip = document.createElement('div')
      chip.className = 'emote-chip'
      chip.style.transform = `translate(-50%, -50%) translate(${Math.sin(angle) * RADIUS}px, ${-Math.cos(angle) * RADIUS}px)`
      const icon = document.createElement('div')
      icon.className = 'emote-icon'
      icon.textContent = emote.icon
      const label = document.createElement('div')
      label.className = 'emote-label'
      label.textContent = `${i + 1} ${emote.label}`
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
    this.select(-1)

    if (touch) {
      const button = document.createElement('div')
      button.id = 'emote-open'
      button.textContent = '😃'
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
        this.cx = e.clientX - window.innerWidth / 2
        this.cy = e.clientY - window.innerHeight / 2
      }
      this.selectFromCursor()
    })

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyX' && !e.repeat) {
        if (this.opened) this.close()
        else this.open()
        return
      }
      if (!this.opened) return
      const digit = /^Digit([1-6])$/.exec(e.code)
      if (digit) {
        e.preventDefault()
        // 1-4 also pick a build material; while the wheel is up it owns them.
        e.stopImmediatePropagation()
        this.select(Number(digit[1]) - 1)
        this.commit()
      }
    })

    window.addEventListener('keyup', (e) => {
      if (e.code !== 'KeyX' || !this.opened) return
      // Held long enough to be a sweep? Commit on release. A quick tap
      // instead leaves the wheel up, waiting for a click or a number key.
      if (performance.now() - this.openedAt > HOLD_MS) this.commit()
    })

    // Clicking anywhere else commits the highlighted wedge (or just closes).
    // Pointer lock keeps the cursor over the canvas, so this is the only
    // click that lands in first person.
    window.addEventListener('mousedown', (e) => {
      if (!this.opened) return
      e.preventDefault()
      // This listener is registered before main.ts's attack handler, so
      // stopping here is what keeps a wedge click from also firing a rocket.
      e.stopImmediatePropagation()
      if (e.button === 2) this.close()
      else this.commit()
    })
  }

  get isOpen(): boolean {
    return this.opened
  }

  private open(): void {
    this.opened = true
    this.openedAt = performance.now()
    const locked = document.pointerLockElement !== null
    // With a visible cursor the wheel opens under it, so highlight whatever
    // it is already pointing at. Locked, the virtual cursor starts centered.
    this.cx = locked ? 0 : this.mouseX - window.innerWidth / 2
    this.cy = locked ? 0 : this.mouseY - window.innerHeight / 2
    this.dot.hidden = !locked
    this.root.hidden = false
    this.selected = -1
    this.selectFromCursor()
  }

  private close(): void {
    this.opened = false
    this.root.hidden = true
  }

  private commit(): void {
    const picked = this.selected >= 0 ? EMOTES[this.selected] : null
    this.close()
    if (picked) this.onPick(picked.id)
  }

  private selectFromCursor(): void {
    this.dot.style.transform = `translate(-50%, -50%) translate(${this.cx}px, ${this.cy}px)`
    const r = Math.hypot(this.cx, this.cy)
    // Dead in the middle, and dead outside the ring — so releasing X with the
    // pointer parked off in a corner doesn't fire a random emote.
    if (r < DEADZONE || r > OUTER) {
      this.select(-1)
      return
    }
    const step = (Math.PI * 2) / EMOTES.length
    const angle = Math.atan2(this.cx, -this.cy) // 0 = up, clockwise
    const index = ((Math.round(angle / step) % EMOTES.length) + EMOTES.length) % EMOTES.length
    this.select(index)
  }

  private select(index: number): void {
    if (index === this.selected) return
    this.selected = index
    this.chips.forEach((chip, i) => chip.classList.toggle('on', i === index))
    this.hub.textContent = index >= 0 ? EMOTES[index].label : 'emote'
    this.hub.classList.toggle('on', index >= 0)
    if (index >= 0) sfx.uiTick()
  }
}

function styleTag(): HTMLStyleElement {
  const style = document.createElement('style')
  style.textContent = `
    #emote-wheel {
      position: fixed;
      left: 50%;
      top: 50%;
      width: 0;
      height: 0;
      pointer-events: none;
      z-index: 5;
      font: 12px monospace;
    }
    /* The wheel lands on top of your own character and name tag, so it
       needs its own ground to sit on. */
    #emote-backdrop {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 340px;
      height: 340px;
      transform: translate(-50%, -50%);
      background: radial-gradient(circle, rgba(0, 0, 0, 0.6) 45%, rgba(0, 0, 0, 0) 72%);
    }
    .emote-chip, #emote-hub {
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
    .emote-chip {
      width: 56px;
      height: 56px;
      gap: 2px;
      pointer-events: auto;
      cursor: pointer;
    }
    .emote-chip.on {
      border-color: #fff;
      background: rgba(80, 80, 90, 0.95);
      color: #fff;
    }
    .emote-icon {
      font-size: 21px;
      line-height: 1;
    }
    .emote-label {
      font-size: 9px;
      letter-spacing: 0.5px;
    }
    #emote-hub {
      width: 62px;
      height: 26px;
      transform: translate(-50%, -50%);
      border-color: rgba(255, 255, 255, 0.18);
      font-size: 10px;
    }
    #emote-hub.on {
      color: #fff;
      border-color: rgba(255, 255, 255, 0.5);
    }
    #emote-dot {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 6px;
      height: 6px;
      background: #fff;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.7);
      transform: translate(-50%, -50%);
    }
    #emote-open {
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
