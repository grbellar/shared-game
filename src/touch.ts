// Virtual touch controls: floating joystick on the left half of the screen,
// camera drag on the right half, jump button bottom-right.
// Enabled on coarse-pointer devices; force with ?touch=1 for desktop testing.
export class TouchControls {
  readonly active: boolean
  moveF = 0 // forward, -1..1
  moveS = 0 // strafe, -1..1
  jumpHeld = false
  private yawDelta = 0
  private stickId: number | null = null
  private camId: number | null = null
  private lastCamX = 0
  private origin = { x: 0, y: 0 }
  private base: HTMLDivElement | null = null
  private knob: HTMLDivElement | null = null

  constructor() {
    this.active =
      matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch')
    if (!this.active) return

    this.base = div('touch-stick-base')
    this.knob = div('touch-stick-knob')
    const jump = div('touch-jump')
    jump.textContent = 'A'
    document.body.append(this.base, this.knob, jump)
    document.getElementById('hint')!.textContent = 'left: move · right: look · A: jump'

    jump.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.jumpHeld = true
    })
    jump.addEventListener('pointerup', () => (this.jumpHeld = false))
    jump.addEventListener('pointercancel', () => (this.jumpHeld = false))

    window.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).id === 'touch-jump') return
      if (e.clientX < window.innerWidth / 2 && this.stickId === null) {
        this.stickId = e.pointerId
        this.origin = { x: e.clientX, y: e.clientY }
        this.moveStick(0, 0)
      } else if (this.camId === null) {
        this.camId = e.pointerId
        this.lastCamX = e.clientX
      }
    })
    window.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) {
        let dx = e.clientX - this.origin.x
        let dy = e.clientY - this.origin.y
        const len = Math.hypot(dx, dy)
        const max = 50
        if (len > max) {
          dx *= max / len
          dy *= max / len
        }
        this.moveS = dx / max
        this.moveF = -dy / max
        this.moveStick(dx, dy)
      } else if (e.pointerId === this.camId) {
        this.yawDelta -= (e.clientX - this.lastCamX) * 0.008
        this.lastCamX = e.clientX
      }
    })
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.stickId) {
        this.stickId = null
        this.moveF = 0
        this.moveS = 0
        this.base!.style.display = 'none'
        this.knob!.style.display = 'none'
      }
      if (e.pointerId === this.camId) this.camId = null
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  // Camera yaw accumulated since the last frame; reading it resets it.
  consumeYaw(): number {
    const d = this.yawDelta
    this.yawDelta = 0
    return d
  }

  private moveStick(dx: number, dy: number): void {
    place(this.base!, this.origin.x, this.origin.y, 50)
    place(this.knob!, this.origin.x + dx, this.origin.y + dy, 22)
  }
}

function div(id: string): HTMLDivElement {
  const el = document.createElement('div')
  el.id = id
  return el
}

function place(el: HTMLDivElement, x: number, y: number, radius: number): void {
  el.style.display = 'block'
  el.style.left = `${x - radius}px`
  el.style.top = `${y - radius}px`
}
