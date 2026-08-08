// Generative calm background music, Minecraft-flavored: slow maj7 pad chords
// with a sparse pentatonic music-box melody drifting over the top. Everything
// is synthesized oscillators — no audio assets, per the art rules. Runs its
// own AudioContext (the sfx master lowpass would crush it); like sfx, it's a
// no-op until the browser unlocks audio on the first user gesture.

const BAR = 4.8 // seconds per chord — slow enough to feel like weather
const LOOKAHEAD = 2.5 // schedule this far ahead so background-tab throttling can't gap it
// Cmaj7 → Am7 → Fmaj7 → G, voiced low and open (MIDI note numbers).
const CHORDS: number[][] = [
  [48, 55, 60, 64],
  [45, 52, 60, 64],
  [41, 48, 57, 60],
  [43, 50, 59, 62],
]
const SCALE = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81] // C pentatonic, two octaves

const freq = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12)

class Music {
  private ctx: AudioContext | null = null
  private out: GainNode | null = null
  private enabled = false
  private unlocked = false
  private timer: number | null = null
  private nextBar = 0
  private chordI = 0
  private melodyI = 4
  private masterGain = 0.13

  constructor() {
    const unlock = (): void => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
      this.unlocked = true
      if (this.enabled) this.start()
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
  }

  // Idempotent; the game loop calls this every frame with the settings value.
  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) this.start()
    else this.stop()
  }

  private init(): void {
    if (this.ctx) return
    this.ctx = new AudioContext()
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    this.out = this.ctx.createGain()
    this.out.gain.value = 0
    const soften = this.ctx.createBiquadFilter()
    soften.type = 'lowpass'
    soften.frequency.value = 3200
    this.out.connect(soften)
    soften.connect(this.ctx.destination)
  }

  private start(): void {
    if (!this.unlocked) return
    this.init()
    const ctx = this.ctx!
    const g = this.out!.gain
    g.cancelScheduledValues(ctx.currentTime)
    g.setValueAtTime(g.value, ctx.currentTime)
    g.linearRampToValueAtTime(this.masterGain, ctx.currentTime + 1.2)
    this.nextBar = ctx.currentTime + 0.1
    this.tick()
  }

  private stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.ctx || !this.out) return
    const g = this.out.gain
    g.cancelScheduledValues(this.ctx.currentTime)
    g.setValueAtTime(g.value, this.ctx.currentTime)
    g.linearRampToValueAtTime(0, this.ctx.currentTime + 0.8)
  }

  private tick = (): void => {
    if (!this.ctx || !this.enabled) return
    const now = this.ctx.currentTime
    if (this.nextBar < now + 0.05) this.nextBar = now + 0.05
    while (this.nextBar < now + LOOKAHEAD) {
      this.scheduleBar(this.nextBar)
      this.nextBar += BAR
    }
    this.timer = window.setTimeout(this.tick, 1000)
  }

  private scheduleBar(t: number): void {
    const chord = CHORDS[this.chordI]
    this.chordI = (this.chordI + 1) % CHORDS.length

    this.pad(chord[0] - 12, t, 0.05) // low root under the chord
    for (const midi of chord) this.pad(midi, t, 0.035)

    // Sparse melody: a lazy random walk on the pentatonic scale, eighth-note
    // grid with most slots empty. Some bars just rest — the silence is the vibe.
    if (Math.random() < 0.2) return
    const slot = BAR / 8
    for (let i = 0; i < 8; i++) {
      if (Math.random() > 0.36) continue
      const stride = Math.random() < 0.25 ? 2 : 1
      this.melodyI = Math.max(
        0,
        Math.min(SCALE.length - 1, this.melodyI + (Math.random() < 0.5 ? -stride : stride)),
      )
      this.pluck(SCALE[this.melodyI], t + i * slot, 0.13)
    }
  }

  // Music-box note: triangle fundamental plus a faint sine an octave up.
  private pluck(midi: number, t: number, peak: number): void {
    const layers: [number, number, OscillatorType][] = [
      [1, 1, 'triangle'],
      [2, 0.3, 'sine'],
    ]
    for (const [mult, gainMul, type] of layers) {
      const osc = this.ctx!.createOscillator()
      osc.type = type
      osc.frequency.value = freq(midi) * mult
      const g = this.ctx!.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(peak * gainMul, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2)
      osc.connect(g)
      g.connect(this.out!)
      osc.start(t)
      osc.stop(t + 2.3)
    }
  }

  // Pad voice: a sine swelling in and out across the bar, overlapping the next.
  private pad(midi: number, t: number, peak: number): void {
    const dur = BAR + 1
    const osc = this.ctx!.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq(midi)
    const g = this.ctx!.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(peak, t + 1.6)
    g.gain.setValueAtTime(peak, t + dur - 1.4)
    g.gain.linearRampToValueAtTime(0.0001, t + dur)
    osc.connect(g)
    g.connect(this.out!)
    osc.start(t)
    osc.stop(t + dur + 0.1)
  }
}

export const music = new Music()
