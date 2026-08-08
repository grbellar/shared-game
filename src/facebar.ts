// A row of webcam squares across the top of the screen — the "everyone on a
// call" view, for when you want to see faces without hunting for the person
// they're attached to.
//
// Purely a renderer: it consumes the same frames webcam.ts captures and net.ts
// relays, so it costs no extra bandwidth and works whether or not your own
// camera is on. Squares are the raw 64px JPEGs, upscaled with nearest-neighbor
// to match the 320x240 canvas underneath.

interface Tile {
  wrap: HTMLDivElement
  img: HTMLImageElement
  label: HTMLDivElement
  name: string
}

export class FaceBar {
  private root: HTMLDivElement
  private tiles = new Map<string, Tile>()

  constructor() {
    const style = document.createElement('style')
    style.textContent = `
      #face-bar {
        position: fixed;
        top: calc(env(safe-area-inset-top) + 6px);
        left: 50%;
        transform: translateX(-50%);
        display: none;
        gap: 6px;
        pointer-events: none;
        z-index: 5;
      }
      #face-bar.on { display: flex; }
      .face-tile {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
      }
      .face-tile img {
        width: 54px;
        height: 54px;
        display: block;
        background: #000;
        border: 2px solid rgba(255, 255, 255, 0.28);
        image-rendering: pixelated;
        image-rendering: crisp-edges;
      }
      .face-tile.me img { border-color: rgba(255, 255, 255, 0.7); }
      .face-tile div {
        max-width: 58px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: rgba(255, 255, 255, 0.85);
        font: 10px monospace;
        text-shadow: 0 1px 2px #000;
      }
    `
    document.head.appendChild(style)

    this.root = document.createElement('div')
    this.root.id = 'face-bar'
    document.body.appendChild(this.root)
  }

  setEnabled(on: boolean): void {
    this.root.classList.toggle('on', on)
  }

  // Add or update someone's square. Called at the frame rate (~5x/sec), so it
  // only touches the DOM when something actually changed.
  set(id: string, dataUrl: string, name: string): void {
    let tile = this.tiles.get(id)
    if (!tile) {
      const wrap = document.createElement('div')
      wrap.className = id === 'me' ? 'face-tile me' : 'face-tile'
      const img = document.createElement('img')
      img.alt = ''
      const label = document.createElement('div')
      wrap.append(img, label)
      // You first, everyone else in arrival order.
      if (id === 'me') this.root.prepend(wrap)
      else this.root.appendChild(wrap)
      tile = { wrap, img, label, name: '' }
      this.tiles.set(id, tile)
    }
    tile.img.src = dataUrl
    if (tile.name !== name) {
      tile.name = name
      tile.label.textContent = name
    }
  }

  remove(id: string): void {
    const tile = this.tiles.get(id)
    if (!tile) return
    tile.wrap.remove()
    this.tiles.delete(id)
  }

  clear(): void {
    for (const id of [...this.tiles.keys()]) this.remove(id)
  }
}
