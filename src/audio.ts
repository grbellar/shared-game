// Lo-fi synthesized sound effects — no audio assets, matching the no-assets
// art rule. Everything is oscillators and low-sample-rate noise buffers; the
// resampling aliasing IS the N64 crunch. A master lowpass fakes the muffled
// mix of a console pushed through a CRT TV speaker.
//
// Usage: import { sfx } and call methods anywhere. Safe before the first user
// gesture (calls are no-ops until the AudioContext unlocks itself on the
// first pointerdown/keydown).

const MUTE_KEY = 'shared-game.sfx-muted'

class Sfx {
  private ctx: AudioContext | null = null
  private out: GainNode | null = null
  private masterGain = 0.4 // sits under voice chat, which has no gain stage of ours
  private mutedFlag = false
  private squeakHigh = false
  private sharkNext = 0
  private sharkLow = false

  constructor() {
    try {
      this.mutedFlag = localStorage.getItem(MUTE_KEY) === '1'
    } catch {
      // Storage unavailable (private mode); mute resets each session.
    }
    const unlock = () => {
      this.init()
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
  }

  get muted(): boolean {
    return this.mutedFlag
  }

  toggleMute(): boolean {
    this.mutedFlag = !this.mutedFlag
    try {
      localStorage.setItem(MUTE_KEY, this.mutedFlag ? '1' : '0')
    } catch {
      // Storage unavailable; the toggle still works this session.
    }
    if (this.out && this.ctx) {
      this.out.gain.setValueAtTime(this.mutedFlag ? 0 : this.masterGain, this.ctx.currentTime)
    }
    return this.mutedFlag
  }

  private init(): void {
    if (this.ctx) return
    this.ctx = new AudioContext()
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    this.out = this.ctx.createGain()
    this.out.gain.value = this.mutedFlag ? 0 : this.masterGain
    const muffle = this.ctx.createBiquadFilter()
    muffle.type = 'lowpass'
    muffle.frequency.value = 5500
    this.out.connect(muffle)
    muffle.connect(this.ctx.destination)
    this.startAmbient()
  }

  // A crunchy mono noise buffer. Low sample rates alias on playback — free grit.
  private noiseBuffer(seconds: number, sampleRate: number): AudioBuffer {
    const ctx = this.ctx!
    const len = Math.max(1, Math.floor(seconds * sampleRate))
    const buf = ctx.createBuffer(1, len, sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    return buf
  }

  private tone(
    type: OscillatorType,
    freqFrom: number,
    freqTo: number,
    dur: number,
    peak: number,
    delay = 0,
  ): void {
    if (!this.ctx || !this.out) return
    const t0 = this.ctx.currentTime + delay
    const osc = this.ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(Math.max(1, freqFrom), t0)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), t0 + dur)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(peak, t0)
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
    osc.connect(g)
    g.connect(this.out)
    osc.start(t0)
    osc.stop(t0 + dur + 0.02)
  }

  private noise(
    filterType: BiquadFilterType,
    freqFrom: number,
    freqTo: number,
    dur: number,
    peak: number,
    delay = 0,
    sampleRate = 11025,
  ): void {
    if (!this.ctx || !this.out) return
    const t0 = this.ctx.currentTime + delay
    const src = this.ctx.createBufferSource()
    src.buffer = this.noiseBuffer(dur + 0.05, sampleRate)
    const filter = this.ctx.createBiquadFilter()
    filter.type = filterType
    filter.frequency.setValueAtTime(Math.max(20, freqFrom), t0)
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), t0 + dur)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(peak, t0)
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
    src.connect(filter)
    filter.connect(g)
    g.connect(this.out)
    src.start(t0)
    src.stop(t0 + dur + 0.05)
  }

  // Endless quiet wave-wash: looped noise with a slow LFO breathing the gain.
  private startAmbient(): void {
    if (!this.ctx || !this.out) return
    const src = this.ctx.createBufferSource()
    src.buffer = this.noiseBuffer(2, 11025)
    src.loop = true
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 450
    const g = this.ctx.createGain()
    g.gain.value = 0.035
    const lfo = this.ctx.createOscillator()
    lfo.frequency.value = 0.13
    const lfoGain = this.ctx.createGain()
    lfoGain.gain.value = 0.02
    lfo.connect(lfoGain)
    lfoGain.connect(g.gain)
    src.connect(filter)
    filter.connect(g)
    g.connect(this.out)
    src.start()
    lfo.start()
  }

  // --- movement ---

  jump(): void {
    this.tone('square', 220, 520, 0.14, 0.18)
  }

  land(intensity: number): void {
    const v = Math.min(1, intensity)
    this.noise('lowpass', 700, 150, 0.09, 0.1 + 0.25 * v)
    this.tone('triangle', 90, 45, 0.1, 0.15 * v)
  }

  step(): void {
    this.noise('bandpass', 350 + Math.random() * 300, 250, 0.05, 0.1)
  }

  // Alternating wheek-wheek of an unoiled wheelchair wheel.
  squeak(): void {
    this.squeakHigh = !this.squeakHigh
    const f = this.squeakHigh ? 1350 : 1100
    this.tone('triangle', f, f * 1.25, 0.09, 0.05)
  }

  // A throaty vocal burst: sawtooth through a bandpass "mouth" so it reads
  // as a human noise instead of a synth beep.
  private voice(
    freqFrom: number,
    freqTo: number,
    formant: number,
    dur: number,
    peak: number,
    delay = 0,
  ): void {
    if (!this.ctx || !this.out) return
    const t0 = this.ctx.currentTime + delay
    const osc = this.ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(Math.max(1, freqFrom), t0)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), t0 + dur)
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = formant
    filter.Q.value = 1.4 // wide enough to keep some body; the peak makes up the rest
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.001, t0)
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.03)
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
    osc.connect(filter)
    filter.connect(g)
    g.connect(this.out)
    osc.start(t0)
    osc.stop(t0 + dur + 0.02)
  }

  // Ramsey's human engine, one call per stride: palms slapping the dirt,
  // winded panting, and sometimes an edgy grunt or a long put-upon groan
  // from the guy being ridden.
  gallop(): void {
    this.noise('lowpass', 550 + Math.random() * 250, 160, 0.07, 0.16)
    const r = Math.random()
    if (r < 0.3) {
      // Winded two-puff pant: "hh-hh".
      this.noise('bandpass', 1100, 700, 0.08, 0.16)
      this.noise('bandpass', 900, 600, 0.1, 0.14, 0.12)
    } else if (r < 0.5) {
      // Effort grunt: "ugh".
      this.voice(160 + Math.random() * 50, 80, 480, 0.2, 1.5)
    } else if (r < 0.58) {
      // He has opinions about this arrangement.
      this.voice(125, 100, 430, 0.5, 1.2)
      this.voice(100, 60, 380, 0.4, 1.1, 0.5)
    }
  }

  // The "oof" of taking a rider's full weight on your back.
  ramseyMount(): void {
    this.voice(180, 75, 520, 0.25, 1.5, 0.12)
    this.noise('bandpass', 1000, 600, 0.09, 0.15, 0.12)
  }

  splash(vol = 1): void {
    this.noise('lowpass', 2500, 250, 0.35, 0.3 * vol)
    this.tone('sine', 320, 85, 0.22, 0.2 * vol)
    this.noise('bandpass', 1600, 500, 0.18, 0.12 * vol, 0.05)
  }

  // A swim stroke: a watery scoop with a little droplet patter after it.
  paddle(): void {
    this.noise('lowpass', 700 + Math.random() * 400, 220, 0.16, 0.16)
    this.noise('bandpass', 1500, 550, 0.08, 0.06, 0.04)
    this.tone('sine', 230 + Math.random() * 60, 110, 0.1, 0.05)
  }

  // Water lapping against someone treading in place. Quiet.
  lap(): void {
    this.noise('lowpass', 550 + Math.random() * 300, 180, 0.28, 0.05)
  }

  // --- combat ---

  rocket(vol = 1): void {
    this.noise('bandpass', 900, 180, 0.5, 0.28 * vol)
    this.tone('square', 110, 55, 0.4, 0.12 * vol)
  }

  explosion(vol = 1): void {
    const v = Math.min(1, vol)
    if (v <= 0.02) return
    this.noise('lowpass', 3000, 60, 0.7, 0.8 * v, 0, 8000)
    this.tone('sine', 100, 32, 0.6, 0.45 * v)
    this.noise('highpass', 2000, 4000, 0.04, 0.3 * v)
  }

  // Rocket travel leaving the ground: an ignition crack, then a long roar
  // climbing away from you as the motor burns out (see rocket.ts).
  rocketLaunch(): void {
    this.noise('highpass', 400, 1800, 0.08, 0.4)
    this.noise('lowpass', 320, 90, 1.9, 0.5, 0.03, 8000)
    this.tone('sawtooth', 70, 260, 1.6, 0.16, 0.03)
    this.tone('square', 140, 520, 1.6, 0.07, 0.05)
  }

  // ...and coming back down on top of somebody. Heavier and dirtier than a
  // rocket blast: a thud you feel before the debris rattles down.
  impact(vol = 1): void {
    const v = Math.min(1, vol)
    if (v <= 0.02) return
    this.tone('sine', 130, 24, 0.9, 0.6 * v)
    this.noise('lowpass', 3600, 40, 1, 0.85 * v, 0, 8000)
    this.noise('bandpass', 900, 300, 0.5, 0.3 * v, 0.1)
  }

  slash(vol = 1): void {
    this.noise('bandpass', 800, 4200, 0.13, 0.22 * vol)
  }

  // Shovel scooping dirt.
  dig(vol = 1): void {
    this.noise('lowpass', 600, 180, 0.16, 0.25 * vol)
    this.noise('bandpass', 1800, 900, 0.05, 0.12 * vol)
  }

  // A tree or rock giving up.
  crunch(vol = 1): void {
    this.noise('lowpass', 900, 90, 0.25, 0.28 * vol)
    this.tone('square', 130, 55, 0.15, 0.08 * vol)
  }

  // Wood-and-string creak of a bow coming to full draw.
  bowDraw(): void {
    this.noise('bandpass', 280, 850, 0.45, 0.09)
    this.tone('sawtooth', 85, 140, 0.45, 0.045)
  }

  // String twang plus arrow whoosh; a fuller draw rings louder.
  bowShot(vol = 1): void {
    this.tone('triangle', 340, 70, 0.13, 0.3 * vol)
    this.noise('highpass', 1200, 3200, 0.16, 0.14 * vol)
  }

  // Thunk of an arrow finding something to live in.
  arrowStick(vol = 1): void {
    this.tone('sine', 210, 60, 0.09, 0.28 * vol)
    this.noise('lowpass', 900, 250, 0.06, 0.18 * vol)
  }

  // Getting hurt: a winded thud, louder the bigger the bite.
  hurt(vol = 1): void {
    const v = Math.min(1, vol)
    this.tone('square', 210, 85, 0.16, 0.2 * v)
    this.noise('lowpass', 1300, 220, 0.11, 0.22 * v)
  }

  // Tick that confirms your swing connected.
  hitmark(): void {
    this.tone('square', 1250, 1650, 0.04, 0.1)
    this.tone('square', 1650, 950, 0.05, 0.09, 0.05)
  }

  // Comedic decapitation pop.
  pop(vol = 1): void {
    this.tone('sine', 520, 70, 0.12, 0.35 * vol)
    this.noise('lowpass', 1500, 400, 0.08, 0.2 * vol)
  }

  // Sad little wah-wah-wah for your own demise.
  death(): void {
    this.tone('square', 330, 320, 0.22, 0.12, 0)
    this.tone('square', 294, 284, 0.22, 0.12, 0.26)
    this.tone('square', 262, 196, 0.5, 0.12, 0.52)
  }

  // --- the shadow realm ---

  // Falling through the gate: a rising shimmer, a swallow, and a thump out
  // the other side.
  warp(): void {
    this.tone('sine', 180, 1400, 0.35, 0.22)
    this.tone('sawtooth', 90, 700, 0.35, 0.07)
    this.noise('bandpass', 400, 5000, 0.4, 0.16)
    this.tone('sine', 900, 60, 0.5, 0.26, 0.3)
    this.noise('lowpass', 2400, 90, 0.55, 0.3, 0.32, 8000)
  }

  // Struck-bell toll that lands when the keep comes out of the fog.
  toll(): void {
    for (const [mult, delay] of [[1, 0], [1.5, 0.02], [2.02, 0.05]] as const) {
      this.tone('triangle', 88 * mult, 84 * mult, 3.2, 0.11 / mult, delay)
    }
    this.noise('lowpass', 900, 120, 0.5, 0.1)
  }

  // Dry bones knocking together — a skeleton moving, or taking a hit that
  // doesn't finish it.
  boneRattle(vol = 1): void {
    for (let i = 0; i < 4; i++) {
      this.noise('bandpass', 1800 + Math.random() * 1400, 900, 0.035, 0.11 * vol, i * 0.035)
    }
    this.tone('triangle', 220, 160, 0.06, 0.05 * vol)
  }

  // The whole thing coming apart in a heap.
  boneShatter(vol = 1): void {
    this.noise('bandpass', 2600, 700, 0.3, 0.3 * vol)
    this.tone('square', 150, 55, 0.22, 0.14 * vol)
    for (let i = 0; i < 7; i++) {
      this.noise('highpass', 1600 + Math.random() * 2200, 1200, 0.04, 0.1 * vol, 0.05 + i * 0.05)
    }
  }

  // A rusty blade finding you.
  boneHit(vol = 1): void {
    this.tone('square', 420, 90, 0.1, 0.22 * vol)
    this.noise('bandpass', 2200, 600, 0.12, 0.2 * vol)
    this.tone('sawtooth', 110, 60, 0.18, 0.1 * vol)
  }

  // Standing in lava. Called on a loop while you burn, so keep it short.
  sizzle(): void {
    this.noise('highpass', 1400, 3600, 0.24, 0.13)
    this.noise('lowpass', 320, 90, 0.3, 0.14)
  }

  // --- critters ---

  // Two-part "me-ow": the pitch rises, then falls away. The vibrato is what
  // sells it as a voice instead of a siren, and the sweeping bandpass is a
  // mouth opening and closing.
  meow(vol = 1, pitch = 1): void {
    if (!this.ctx || !this.out) return
    const t0 = this.ctx.currentTime
    const base = 520 * pitch
    const osc = this.ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(base * 0.8, t0)
    osc.frequency.exponentialRampToValueAtTime(base * 1.35, t0 + 0.13)
    osc.frequency.exponentialRampToValueAtTime(base * 0.6, t0 + 0.45)
    const lfo = this.ctx.createOscillator()
    lfo.frequency.value = 11
    const lfoGain = this.ctx.createGain()
    lfoGain.gain.value = base * 0.05
    lfo.connect(lfoGain)
    lfoGain.connect(osc.frequency)
    const mouth = this.ctx.createBiquadFilter()
    mouth.type = 'bandpass'
    mouth.Q.value = 3
    mouth.frequency.setValueAtTime(700, t0)
    mouth.frequency.linearRampToValueAtTime(1600, t0 + 0.15)
    mouth.frequency.linearRampToValueAtTime(600, t0 + 0.5)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(0.24 * vol, t0 + 0.06)
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5)
    osc.connect(mouth)
    mouth.connect(g)
    g.connect(this.out)
    osc.start(t0)
    osc.stop(t0 + 0.55)
    lfo.start(t0)
    lfo.stop(t0 + 0.55)
  }

  // Low rumble under a ~26 Hz tremolo — the rattle is the whole purr.
  purr(vol = 1): void {
    if (!this.ctx || !this.out) return
    const t0 = this.ctx.currentTime
    const src = this.ctx.createBufferSource()
    src.buffer = this.noiseBuffer(1.2, 6000)
    const lp = this.ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 260
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(0.3 * vol, t0 + 0.1)
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.1)
    const lfo = this.ctx.createOscillator()
    lfo.frequency.value = 26
    const lfoGain = this.ctx.createGain()
    lfoGain.gain.value = 0.22 * vol
    lfo.connect(lfoGain)
    lfoGain.connect(g.gain)
    src.connect(lp)
    lp.connect(g)
    g.connect(this.out)
    src.start(t0)
    src.stop(t0 + 1.15)
    lfo.start(t0)
    lfo.stop(t0 + 1.15)
  }

  // --- fireworks ---

  // Jamming a tube into the dirt: a thunk, then the fuse catching.
  plant(): void {
    this.tone('triangle', 160, 70, 0.13, 0.16)
    this.noise('highpass', 2800, 6000, 0.6, 0.05)
  }

  // Ascent: a whistle sliding up over the hiss of burning fuel.
  whistle(vol = 1): void {
    const v = Math.min(1, vol)
    if (v <= 0.02) return
    this.tone('sine', 360, 1600, 1.5, 0.16 * v)
    this.noise('highpass', 1800, 5200, 1.2, 0.09 * v)
  }

  // Shell opening: a crack, a deep thump, and a tail of crackling stars.
  burst(vol = 1): void {
    const v = Math.min(1, vol)
    if (v <= 0.02) return
    this.noise('highpass', 3000, 5200, 0.05, 0.35 * v)
    this.noise('lowpass', 2200, 55, 0.8, 0.6 * v, 0, 8000)
    this.tone('sine', 130, 38, 0.5, 0.32 * v)
    for (let i = 0; i < 8; i++) {
      this.noise(
        'bandpass',
        2400 + Math.random() * 2600,
        1200,
        0.05,
        0.09 * v,
        0.12 + Math.random() * 0.8,
      )
    }
  }

  // --- shark ---

  // The two-note stalking motif. Call it every frame with 0..1 closeness and
  // it schedules its own notes: the gap between them collapses as the shark
  // closes in. 0 (or not calling it) stops the theme.
  sharkTension(t: number): void {
    if (!this.ctx || !this.out) return
    if (t <= 0.02) {
      this.sharkNext = 0
      return
    }
    const now = this.ctx.currentTime
    // Restart the pulse when it's been silent (or the clock ran away).
    if (this.sharkNext === 0 || this.sharkNext > now + 1.5) this.sharkNext = now
    if (now < this.sharkNext) return
    const gap = 0.62 - 0.5 * t // ~0.6s at the edge of hearing, ~0.12s on top of you
    this.sharkNext = now + gap
    this.sharkLow = !this.sharkLow
    // The classic menacing half-step, an octave below the cellos.
    const f = this.sharkLow ? 49 : 51.9
    const vol = 0.16 + 0.5 * t
    this.tone('sawtooth', f, f * 0.985, Math.min(0.4, gap * 1.15), vol)
    this.tone('triangle', f * 2, f * 1.96, Math.min(0.28, gap * 0.9), vol * 0.3)
  }

  // Jaws closing on you.
  chomp(vol = 1): void {
    this.noise('lowpass', 1800, 200, 0.18, 0.42 * vol)
    this.tone('square', 150, 55, 0.16, 0.28 * vol)
    this.noise('bandpass', 2800, 900, 0.05, 0.22 * vol, 0.05)
  }

  // Water churning while it drags you out.
  thrash(vol = 1): void {
    this.noise('lowpass', 2400, 400, 0.3, 0.28 * vol)
    this.tone('sine', 240, 90, 0.2, 0.12 * vol)
  }

  // A weapon connecting with the shark.
  sharkHurt(vol = 1): void {
    this.noise('lowpass', 1200, 300, 0.14, 0.3 * vol)
    this.tone('sawtooth', 300, 140, 0.18, 0.16 * vol)
  }

  // Bear roar: a falling growl with a noisy throat.
  roar(vol = 1): void {
    const v = Math.min(1, vol)
    if (v <= 0.02) return
    this.tone('sawtooth', 170, 65, 0.5, 0.28 * v)
    this.tone('square', 95, 52, 0.5, 0.16 * v)
    this.noise('lowpass', 750, 240, 0.45, 0.24 * v)
  }

  // Gary has spotted you. Gary is coming.
  scream(vol = 1): void {
    const v = Math.min(1, vol)
    if (v <= 0.02) return
    this.tone('sawtooth', 590, 920, 0.3, 0.15 * v)
    this.tone('sawtooth', 660, 310, 0.35, 0.13 * v, 0.28)
    this.tone('square', 880, 1180, 0.12, 0.08 * v, 0.1)
  }

  // Big dumb death groan, then bubbles.
  sharkDie(vol = 1): void {
    this.tone('sawtooth', 200, 38, 0.8, 0.24 * vol)
    this.noise('lowpass', 900, 110, 0.7, 0.3 * vol)
    this.tone('sine', 700, 1300, 0.09, 0.08 * vol, 0.5)
    this.tone('sine', 620, 1150, 0.09, 0.07 * vol, 0.68)
  }

  // --- ui ---

  chat(): void {
    this.tone('square', 660, 660, 0.05, 0.08)
    this.tone('square', 880, 880, 0.05, 0.08, 0.06)
  }

  equip(on: boolean): void {
    if (on) this.tone('square', 520, 780, 0.09, 0.12)
    else this.tone('square', 780, 520, 0.09, 0.12)
  }

  // Blip as the emote wheel highlight moves.
  uiTick(): void {
    this.tone('square', 950, 950, 0.03, 0.05)
  }

  // One short cue per emote, played for whoever pulled it off (remotes
  // fade with distance).
  emote(id: string, vol = 1): void {
    const v = Math.min(1, vol)
    if (v <= 0.02) return
    if (id === 'wave') {
      this.tone('square', 660, 990, 0.08, 0.1 * v)
      this.tone('square', 990, 1320, 0.08, 0.09 * v, 0.09)
    } else if (id === 'dance') {
      const riff = [523, 659, 784, 1047]
      riff.forEach((f, i) => this.tone('square', f, f, 0.09, 0.09 * v, i * 0.11))
    } else if (id === 'clap') {
      for (let i = 0; i < 3; i++) this.noise('bandpass', 2400, 800, 0.06, 0.22 * v, i * 0.15)
    } else if (id === 'laugh') {
      const has = [740, 620, 520]
      has.forEach((f, i) => this.tone('square', f, f * 0.75, 0.09, 0.12 * v, i * 0.13))
    } else if (id === 'flex') {
      this.tone('sawtooth', 110, 240, 0.35, 0.11 * v)
      this.tone('square', 440, 660, 0.18, 0.07 * v, 0.12)
    } else if (id === 'bow') {
      this.tone('triangle', 560, 300, 0.28, 0.11 * v)
    }
  }
}

export const sfx = new Sfx()
