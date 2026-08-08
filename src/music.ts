// Generative background music, Minecraft-flavored: slow maj7 pad chords with
// a sparse pentatonic music-box melody drifting over the top. Everything is
// synthesized oscillators — no audio assets, per the art rules. Runs its own
// AudioContext (the sfx master lowpass would crush it); like sfx, it's a
// no-op until the browser unlocks audio on the first user gesture.
//
// Two scores. The island keeps the calm one. The shadow realm gets its own:
// same generative machinery, different furniture — a minor-second-heavy set
// of chords voiced an octave down, a slow tolling low note on every bar, and
// a melody that creeps rather than twinkles. `setScore()` crossfades between
// them, so walking through the portal changes the music with you.

const LOOKAHEAD = 2.5 // schedule this far ahead so background-tab throttling can't gap it

export type Score = 'island' | 'shadow'

interface Voicing {
  bar: number // seconds per chord
  chords: number[][]
  scale: number[]
  gain: number
  // The realm's low bell, struck once a bar. Null on the island.
  toll: number | null
  // How often a melody slot actually sounds, and how likely a bar rests.
  density: number
  rest: number
}

const SCORES: Record<Score, Voicing> = {
  // Cmaj7 → Am7 → Fmaj7 → G, voiced low and open (MIDI note numbers).
  island: {
    bar: 4.8, // slow enough to feel like weather
    chords: [
      [48, 55, 60, 64],
      [45, 52, 60, 64],
      [41, 48, 57, 60],
      [43, 50, 59, 62],
    ],
    scale: [60, 62, 64, 67, 69, 72, 74, 76, 79, 81], // C pentatonic, two octaves
    gain: 0.13,
    toll: null,
    density: 0.36,
    rest: 0.2,
  },
  // Dm(b6) → Bb → Gm → A7(b9): the flat sixth and the b9 are what make it
  // sound like something is standing behind you. Voiced an octave under the
  // island so it sits below the sfx instead of over them.
  shadow: {
    bar: 6.2, // slower still — the castle is not in a hurry
    chords: [
      [38, 45, 50, 53],
      [34, 41, 46, 50],
      [31, 38, 43, 46],
      [33, 40, 45, 49],
    ],
    scale: [50, 51, 53, 55, 56, 58, 62, 63, 65, 67], // D phrygian-ish, with the b2
    gain: 0.115,
    toll: 26, // a low bell under every bar
    density: 0.22, // sparser: mostly silence and the pad
    rest: 0.4,
  },
}

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
  private score: Score = 'island'
  // Bars already scheduled keep the old voicing — they're committed to the
  // audio clock. This is the score the NEXT bar will use.
  private pending: Score = 'island'

  private get voicing(): Voicing {
    return SCORES[this.score]
  }

  private get masterGain(): number {
    return this.voicing.gain
  }

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

  // Which world you're in. Idempotent, called every frame like setEnabled.
  // The switch lands on the next bar rather than immediately: already-queued
  // bars are committed to the audio clock, and cutting a pad off mid-swell is
  // more jarring than waiting a few seconds for the chord to turn.
  setScore(score: Score): void {
    if (score === this.pending) return
    this.pending = score
    if (!this.ctx || !this.out || !this.enabled) {
      this.score = score
      return
    }
    // Duck across the changeover so the two palettes don't collide.
    const g = this.out.gain
    const now = this.ctx.currentTime
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(0.0001, now + 0.9)
    g.linearRampToValueAtTime(SCORES[score].gain, now + 2.6)
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
      // A queued score change takes effect at a bar line, never mid-bar.
      if (this.pending !== this.score) {
        this.score = this.pending
        this.chordI = 0
      }
      this.scheduleBar(this.nextBar)
      this.nextBar += this.voicing.bar
    }
    this.timer = window.setTimeout(this.tick, 1000)
  }

  private scheduleBar(t: number): void {
    const v = this.voicing
    const chord = v.chords[this.chordI % v.chords.length]
    this.chordI = (this.chordI + 1) % v.chords.length

    this.pad(chord[0] - 12, t, 0.05) // low root under the chord
    for (const midi of chord) this.pad(midi, t, 0.035)
    if (v.toll !== null) this.bell(v.toll, t)

    // Sparse melody: a lazy random walk on the scale, eighth-note grid with
    // most slots empty. Some bars just rest — the silence is the vibe.
    if (Math.random() < v.rest) return
    const slot = v.bar / 8
    for (let i = 0; i < 8; i++) {
      if (Math.random() > v.density) continue
      const stride = Math.random() < 0.25 ? 2 : 1
      this.melodyI = Math.max(
        0,
        Math.min(v.scale.length - 1, this.melodyI + (Math.random() < 0.5 ? -stride : stride)),
      )
      this.pluck(v.scale[this.melodyI], t + i * slot, this.score === 'shadow' ? 0.1 : 0.13)
    }
  }

  // The realm's bell: a detuned pair of low sines with a long decay, plus a
  // gritty strike transient. Rings for most of a bar.
  private bell(midi: number, t: number): void {
    for (const [mult, peak] of [[1, 0.085], [2.01, 0.03], [3.02, 0.014]] as const) {
      const osc = this.ctx!.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq(midi) * mult
      const g = this.ctx!.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(peak, t + 0.04)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 5)
      osc.connect(g)
      g.connect(this.out!)
      osc.start(t)
      osc.stop(t + 5.1)
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
    const dur = this.voicing.bar + 1
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
