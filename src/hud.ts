// Chunky overlay text for the things that deserve a fuss: cheat codes,
// treasure finds, duck murder. Plus the shovel's detector readout.
export class Hud {
  private bannerEl: HTMLDivElement
  private feedEl: HTMLDivElement
  private detectorEl: HTMLDivElement
  private bannerTimer = 0
  private lastDetector: string | null = ''

  constructor() {
    this.bannerEl = document.createElement('div')
    this.bannerEl.id = 'banner'
    this.feedEl = document.createElement('div')
    this.feedEl.id = 'feed'
    this.detectorEl = document.createElement('div')
    this.detectorEl.id = 'detector'
    document.body.append(this.bannerEl, this.feedEl, this.detectorEl)
  }

  // Big centred announcement.
  banner(text: string, ms = 2400): void {
    this.bannerEl.textContent = text
    this.bannerEl.style.display = 'block'
    clearTimeout(this.bannerTimer)
    this.bannerTimer = window.setTimeout(() => {
      this.bannerEl.style.display = 'none'
    }, ms)
  }

  // A line in the event ticker (kills, finds, sightings).
  feed(text: string): void {
    const line = document.createElement('div')
    line.textContent = text
    this.feedEl.append(line)
    while (this.feedEl.children.length > 5) this.feedEl.firstChild!.remove()
    setTimeout(() => line.remove(), 8000)
  }

  // Null hides the readout. Called every frame, so it no-ops unless the
  // reading actually changed.
  detector(text: string | null): void {
    if (text === this.lastDetector) return
    this.lastDetector = text
    if (!text) {
      this.detectorEl.style.display = 'none'
      return
    }
    this.detectorEl.textContent = text
    this.detectorEl.style.display = 'block'
  }
}
