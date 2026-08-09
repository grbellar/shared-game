import { sfx } from './audio'
import { BASE_MASS, COLOSSUS_MASS, layout, massOf, orphans, partOfIndex, scaleOf } from './voxelbody'

// Your body IS your health. There is no hp: a voxel is a hit point, and you
// die when something takes one while you are down to the base figure.
//
// This replaces health.ts and keeps its call surface — damage(), kill(),
// revive(), update(), onDeath, onHurt — because a dozen sites in main.ts,
// mobs.ts, skeletons.ts and shark.ts already speak it. New are bore() for
// aimed weapons and eat() for growth.
//
// Ownership follows the old rule exactly. Attackers work out which voxels they
// took and say so; the victim is still the only one who decides that the last
// one was fatal.

// Voxels per point of old hp damage. Every hazard was tuned against a
// hundred-point bar, so this one constant carries all of that tuning across
// intact: lava still takes about two seconds, a skeleton still needs nine
// swings. Aimed weapons don't come through here — they bore.
const PER_HP = BASE_MASS / 100

// Hits the base figure takes before one is fatal, so a fresh spawn is not a
// one-shot. The grace window is what keeps them countable as HITS: lava burns
// every frame and a burst lands several calls at once, either of which would
// otherwise spend all three in a blink.
const CORE_HITS = 3
const CORE_GRACE = 0.35
const REGEN_S = 5

// Cells in the meter above the base figure. It fills toward colossus, so a
// full bar is the biggest anyone gets.
const SEGMENTS = 10

export class Mass {
  // A hit landed on the base figure. main.ts turns it into the death show and
  // the `kill` broadcast.
  onDeath: () => void = () => {}
  // We lost voxels, whoever caused it. The Meckies listen.
  onHurt: () => void = () => {}
  // Voxels that just came loose. Everything that leaves a body ends up on the
  // floor as food, so pickups.ts hangs off this.
  onSpill: (indices: number[]) => void = () => {}
  // The figure changed shape. main.ts rebuilds the mesh and restreams `grown`.
  onChange: () => void = () => {}
  // Voxels we took off ourselves — lava, a fall, a shark, a block we placed.
  // Nobody else has said anything about these, so main.ts puts them on the
  // wire. Damage BY someone else arrives through bore() already public, which
  // is why that path doesn't fire this.
  onSelfBore: (indices: number[]) => void = () => {}
  // Wounds we just closed by eating. main.ts relays them so the room's wound
  // set shrinks and everyone else's copy of our body fills back in.
  onHeal: (indices: number[]) => void = () => {}

  grown = BASE_MASS
  removed = new Set<number>()
  dead = false
  // massOf walks the whole wound set, and the render loop reads mass/scale
  // several times a frame; cached until the figure actually changes.
  private massCache = -1
  private flash = 0
  private lives = CORE_HITS
  private graceFor = 0
  private regenIn = 0
  private vignette: HTMLDivElement
  private frame: HTMLDivElement
  private count: HTMLSpanElement
  private fills: HTMLSpanElement[] = []
  private shown = -1
  private shownCore = true

  constructor() {
    const style = document.createElement('style')
    style.textContent = `
      #hp-meter {
        position: fixed;
        top: calc(env(safe-area-inset-top) + 32px);
        left: calc(env(safe-area-inset-left) + 12px);
        display: flex;
        align-items: center;
        gap: 6px;
        font: 12px monospace;
        color: rgba(255, 255, 255, 0.75);
        pointer-events: none;
      }
      #hp-label {
        letter-spacing: 1px;
      }
      #hp-frame {
        display: flex;
        gap: 2px;
        padding: 2px;
        background: rgba(0, 0, 0, 0.55);
        border: 2px solid rgba(255, 255, 255, 0.28);
      }
      .hp-cell {
        width: 11px;
        height: 12px;
        background: #22252a;
      }
      /* Three fat cells instead of ten thin ones, so the frame keeps its
         width when the meter flips to counting lives. */
      #hp-frame.core .hp-cell {
        width: 41px;
      }
      .hp-fill {
        display: block;
        height: 100%;
        width: 0;
        background: #4f9e3f;
      }
      #hp-frame.core {
        border-color: #e23b3b;
        animation: hp-alarm 0.34s steps(1) infinite;
      }
      #hp-frame.core .hp-fill {
        background: #e23b3b;
      }
      #hp-frame.down {
        border-color: rgba(226, 59, 59, 0.45);
        animation: none;
      }
      #hp-count {
        min-width: 28px;
        color: #fff;
        text-shadow: 0 1px 2px #000;
      }
      /* Two hard frames, no in-between — a console alarm, not a CSS glow. */
      @keyframes hp-alarm {
        50% {
          transform: translateX(1px);
          border-color: rgba(226, 59, 59, 0.35);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        #hp-frame.core {
          animation: none;
        }
      }
      #mass-vignette {
        position: fixed;
        inset: 0;
        opacity: 0;
        pointer-events: none;
        /* Banded stops, not a smooth falloff: three flat rings of red. */
        background: radial-gradient(
          ellipse at center,
          rgba(226, 59, 59, 0) 38%,
          rgba(226, 59, 59, 0.28) 38%,
          rgba(226, 59, 59, 0.28) 62%,
          rgba(226, 59, 59, 0.55) 62%,
          rgba(226, 59, 59, 0.55) 82%,
          rgba(178, 30, 30, 0.85) 82%
        );
      }
    `
    document.head.appendChild(style)

    const meter = document.createElement('div')
    meter.id = 'hp-meter'
    const label = document.createElement('span')
    label.id = 'hp-label'
    label.textContent = 'HP'
    this.frame = document.createElement('div')
    this.frame.id = 'hp-frame'
    this.frame.setAttribute('role', 'meter')
    this.frame.setAttribute('aria-label', 'Health')
    this.frame.setAttribute('aria-valuemin', '0')
    this.count = document.createElement('span')
    this.count.id = 'hp-count'
    meter.append(label, this.frame, this.count)

    this.vignette = document.createElement('div')
    this.vignette.id = 'mass-vignette'
    document.body.append(meter, this.vignette)
    this.cells(CORE_HITS)
    this.render()
  }

  get mass(): number {
    if (this.massCache < 0) this.massCache = massOf(this.grown, this.removed)
    return this.massCache
  }

  get scale(): number {
    return scaleOf(this.mass)
  }

  // Hazards and anything else without a direction: erosion off the surface.
  // Scaled by LINEAR (not volumetric) size, so a giant keeps real durability
  // without becoming immune — at a fixed voxel count it would take 500
  // skeleton strikes to fell one.
  damage(hp: number): void {
    if (this.dead || !(hp > 0)) return
    this.erode(Math.max(1, Math.round(hp * PER_HP * this.scale)))
  }

  // An aimed weapon already worked out exactly which voxels it took.
  bore(indices: number[]): void {
    if (this.dead || !indices.length) return
    const named = new Set(indices)
    // The whiff fallback can charge a voxel the attacker never named.
    // Announce it, or every other client keeps drawing the voxel we just
    // lost and the wound sets drift apart for good.
    const extra = this.take(indices, true).filter((i) => !named.has(i))
    if (extra.length) this.onSelfBore(extra)
  }

  // Wounds close before size grows: eaten voxels refill the LOWEST removed
  // indices first, which are the innermost cells. Without that, every meal
  // glues voxels onto the outside of a hollowed shell and a veteran giant is
  // permanent swiss cheese.
  eat(n: number): void {
    if (this.dead || n <= 0) return
    const wounds = [...this.removed].sort((a, b) => a - b).slice(0, n)
    for (const i of wounds) this.removed.delete(i)
    this.grown += n - wounds.length
    this.massCache = -1
    if (wounds.length) this.onHeal(wounds)
    this.onChange()
  }

  // Spend mass deliberately: one voxel per block placed. Refuses to go below
  // the base figure, because building should never be a way to die.
  spend(n: number): boolean {
    if (this.dead || this.mass - n < BASE_MASS) return false
    this.erode(n, false)
    return true
  }

  // Growth in reverse — newest voxels first, so a burned giant visibly shrinks
  // back down its own growth curve. With one exception: LEGS ARE SPARED. Limbs
  // grow downward, so a leg's newest voxels are its feet, and eating the ground
  // row makes the connectivity flood declare the whole body loose at once.
  // Legs only go to aimed cuts, or as a last resort when nothing else is left.
  private erode(n: number, hostile = true): void {
    const alive: number[] = []
    const legs: number[] = []
    for (let i = this.grown - 1; i >= BASE_MASS && alive.length < n; i--) {
      if (this.removed.has(i)) continue
      const part = partOfIndex(i)
      if (part === 'legL' || part === 'legR') {
        if (legs.length < n) legs.push(i)
        continue
      }
      alive.push(i)
    }
    if (!alive.length && !legs.length) {
      // Nothing but the protected core left. A hostile hit still has to land
      // (the floor-death rule lives in take), so name a core voxel.
      this.take(hostile ? [0] : [], hostile)
      return
    }
    // take() announces any orphan cascade itself and returns only the direct
    // cut, which is ours to send here.
    const direct = this.take(alive.length ? alive : legs, hostile)
    if (direct.length) this.onSelfBore(direct)
  }

  private take(indices: number[], hostile: boolean): number[] {
    // Indices below BASE_MASS are the starting figure, which never erodes, so
    // there is always a body left to render — sawing both legs off a colossus
    // would otherwise orphan every voxel it has. At the floor every voxel a hit
    // can name IS that protected core, so nothing gets removed. Hence the death
    // check ahead of the empty-cut early-out: after it, a base figure would be
    // unkillable, every hit filtering to nothing and returning first.
    if (hostile && this.mass <= BASE_MASS && indices.length) {
      if (this.graceFor > 0) return []
      this.regenIn = REGEN_S
      this.onHurt()
      this.lives--
      if (this.lives > 0) {
        this.graceFor = CORE_GRACE
        this.flash = 1
        sfx.hurt(0.9)
        return []
      }
      sfx.hurt(1)
      this.dead = true
      this.onDeath()
      return []
    }
    let fresh = indices.filter((i) => i >= BASE_MASS && i < this.grown && !this.removed.has(i))
    if (!fresh.length) {
      if (!hostile) return []
      // The shot landed, but everything it named is the protected core — a
      // hollowed body being hit square in the chest. A landed hit must never
      // whiff, so it costs one outermost voxel instead.
      for (let i = this.grown - 1; i >= BASE_MASS; i--) {
        if (!this.removed.has(i)) {
          fresh = [i]
          break
        }
      }
      if (!fresh.length) return []
    }
    if (hostile) {
      this.regenIn = REGEN_S
      this.onHurt()
      this.flash = Math.min(1, 0.45 + fresh.length / BASE_MASS)
      sfx.hurt(0.5 + fresh.length / BASE_MASS)
    }
    for (const i of fresh) this.removed.add(i)

    // Anything the cut left hanging off nothing falls away too, which is what
    // makes sawing through both legs drop the whole torso at once.
    const loose = orphans(layout(this.grown, this.removed)).filter((i) => i >= BASE_MASS)
    for (const i of loose) this.removed.add(i)
    this.massCache = -1
    // The attacker sent the cut, but the orphan flood runs on our body alone.
    // Unannounced, every other client keeps drawing a torso our legs no longer
    // hold up and the pickups it spills exist on no screen but ours.
    if (loose.length) this.onSelfBore(loose)

    this.onSpill([...fresh, ...loose])
    this.onChange()
    // The direct cut only; the loose part already went out above. The caller
    // decides whether this still needs announcing — an attacker's bore is
    // already public, an erosion is not.
    return fresh
  }

  // Dead by some other route (a `kill` aimed at us).
  kill(): void {
    this.dead = true
  }

  // Back on your feet at the starting figure, wounds and all growth gone.
  revive(): void {
    this.grown = BASE_MASS
    this.removed.clear()
    this.massCache = -1
    this.dead = false
    this.flash = 0
    this.lives = CORE_HITS
    this.graceFor = 0
    this.regenIn = 0
    this.onChange()
  }

  // No passive decay: it outpaced any realistic eating rate and capped how big
  // anyone could get. Combat is the only sink.
  update(dt: number): void {
    if (this.graceFor > 0) this.graceFor -= dt
    if (!this.dead && this.lives < CORE_HITS) {
      this.regenIn -= dt
      if (this.regenIn <= 0) this.lives = CORE_HITS
    }
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 2.6)
      // Quantized so the flash drops out in visible steps.
      this.vignette.style.opacity = String(Math.ceil(this.flash * 4) / 4)
    }
    this.render()
  }

  // Your body is still the health bar; this is the readout of it. Above the
  // base figure it counts the blocks you are carrying — one collected voxel is
  // one point, and one point is one hit — filling toward colossus. At the base
  // figure there is nothing left to erode, so it flips to the three hits that
  // kill you.
  //
  // Called every frame and cheap because it bails unless the number moved.
  private render(): void {
    const core = this.dead || this.mass <= BASE_MASS
    const value = this.dead ? 0 : core ? this.lives : this.mass - BASE_MASS
    if (core === this.shownCore && value === this.shown) return
    if (core !== this.shownCore) this.cells(core ? CORE_HITS : SEGMENTS)
    this.shownCore = core
    this.shown = value
    const per = core ? 1 : (COLOSSUS_MASS - BASE_MASS) / SEGMENTS
    for (let i = 0; i < this.fills.length; i++) {
      this.fills[i].style.width = `${Math.max(0, Math.min(1, value / per - i)) * 100}%`
    }
    this.count.textContent = String(value)
    this.frame.classList.toggle('core', core)
    this.frame.classList.toggle('down', this.dead)
    this.frame.setAttribute('aria-valuemax', String(core ? CORE_HITS : COLOSSUS_MASS - BASE_MASS))
    this.frame.setAttribute('aria-valuenow', String(value))
  }

  private cells(n: number): void {
    this.frame.replaceChildren()
    this.fills = []
    for (let i = 0; i < n; i++) {
      const cell = document.createElement('div')
      cell.className = 'hp-cell'
      const fill = document.createElement('span')
      fill.className = 'hp-fill'
      cell.append(fill)
      this.frame.append(cell)
      this.fills.push(fill)
    }
  }
}
