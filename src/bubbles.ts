import * as THREE from 'three'

// Chat bubbles are DOM overlays, not in-world sprites: the 3D canvas is
// 320x240, so text drawn inside it is unreadable. These track a character's
// head by projecting its position to screen space every frame.
interface Bubble {
  el: HTMLDivElement
  target: THREE.Object3D
  expires: number
}

// How long a message hangs over someone's head. The minimap's talking
// indicator runs off the same clock, so the blip stops pinging exactly when
// the bubble pops.
export const LIFETIME_MS = 6000
const MAX_DISTANCE = 80

export class Bubbles {
  private list: Bubble[] = []
  private v = new THREE.Vector3()

  constructor(
    private camera: THREE.PerspectiveCamera,
    private canvas: HTMLCanvasElement,
  ) {}

  show(target: THREE.Object3D, text: string): void {
    this.dismiss(target)
    const el = document.createElement('div')
    el.className = 'chat-bubble'
    el.textContent = text
    document.body.append(el)
    this.list.push({ el, target, expires: performance.now() + LIFETIME_MS })
  }

  update(): void {
    const now = performance.now()
    const rect = this.canvas.getBoundingClientRect()
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i]
      if (now > b.expires || !b.target.parent) {
        b.el.remove()
        this.list.splice(i, 1)
        continue
      }
      this.v.copy(b.target.position)
      this.v.y += 3.3
      const dist = this.v.distanceTo(this.camera.position)
      this.v.project(this.camera)
      if (this.v.z > 1 || dist > MAX_DISTANCE) {
        b.el.style.display = 'none'
        continue
      }
      b.el.style.display = 'block'
      b.el.style.left = `${rect.left + ((this.v.x + 1) / 2) * rect.width}px`
      b.el.style.top = `${rect.top + ((1 - this.v.y) / 2) * rect.height}px`
    }
  }

  private dismiss(target: THREE.Object3D): void {
    const i = this.list.findIndex((b) => b.target === target)
    if (i >= 0) {
      this.list[i].el.remove()
      this.list.splice(i, 1)
    }
  }
}
