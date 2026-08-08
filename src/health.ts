import { sfx } from './audio'

// The local player's hit points, plus the HUD meter that shows them.
//
// Your health is yours alone: every client runs this for its own player,
// applies its own blast damage, and announces its own death — the same rule
// blast knockback already follows in effects.ts. Attackers only ever send a
// `hit`; the victim decides whether that hit was fatal, so nobody loses their
// head to somebody else's laggy simulation.
//
// The meter is DOM, like the rest of the overlay. Ten chunky cells instead of
// a smooth bar, and every transition steps rather than fades — a smooth
// gradient would be the one thing on screen that isn't made of pixels.

export const MAX_HP = 100
const SEGMENTS = 10
const REGEN_DELAY = 5 // seconds unhurt before health starts creeping back
const REGEN_RATE = 14 // hp per second once it does
const CRITICAL = 30 // at or below this the meter starts jittering

export class Health {
  // Fires the moment hp reaches zero. main.ts turns it into the death show
  // and the `kill` broadcast.
  onDeath: () => void = () => {}
  // Fired whenever we take damage, whoever caused it. The Meckies listen.
  onHurt: () => void = () => {}
  hp = MAX_HP
  dead = false
  private sinceHurt = REGEN_DELAY
  private flash = 0
  private frame: HTMLDivElement
  private fills: HTMLSpanElement[] = []
  private vignette: HTMLDivElement

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
      .hp-fill {
        display: block;
        height: 100%;
        width: 0;
        background: #4f9e3f;
      }
      #hp-frame.hurt .hp-fill {
        background: #e2a53b;
      }
      #hp-frame.critical {
        border-color: #e23b3b;
        animation: hp-alarm 0.34s steps(1) infinite;
      }
      #hp-frame.critical .hp-fill {
        background: #e23b3b;
      }
      #hp-frame.down {
        border-color: rgba(226, 59, 59, 0.45);
      }
      /* Two hard frames, no in-between — a console alarm, not a CSS glow. */
      @keyframes hp-alarm {
        50% {
          transform: translateX(1px);
          border-color: rgba(226, 59, 59, 0.35);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        #hp-frame.critical {
          animation: none;
        }
      }
      #hp-vignette {
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
    this.frame.setAttribute('aria-valuemax', String(MAX_HP))
    for (let i = 0; i < SEGMENTS; i++) {
      const cell = document.createElement('div')
      cell.className = 'hp-cell'
      const fill = document.createElement('span')
      fill.className = 'hp-fill'
      cell.appendChild(fill)
      this.frame.appendChild(cell)
      this.fills.push(fill)
    }

    this.vignette = document.createElement('div')
    this.vignette.id = 'hp-vignette'

    meter.append(label, this.frame)
    document.body.append(meter, this.vignette)
    this.render()
  }

  damage(amount: number): void {
    if (this.dead || !(amount > 0)) return
    // Anything that hurts us, from any source. Mobs and skeletons call
    // damage() straight from their own modules rather than going through a
    // `hit` message, so this is the only place that sees ALL of it.
    this.onHurt()
    this.hp = Math.max(0, this.hp - amount)
    this.sinceHurt = 0
    this.flash = Math.min(1, 0.45 + amount / MAX_HP)
    sfx.hurt(0.5 + amount / MAX_HP)
    this.render()
    if (this.hp === 0) {
      this.dead = true
      this.onDeath()
    }
  }

  // Dead by some other route (a `kill` aimed at us). Stops regen until revive.
  kill(): void {
    this.hp = 0
    this.dead = true
    this.render()
  }

  // Back on your feet with a full bar — called when the player respawns.
  revive(): void {
    this.hp = MAX_HP
    this.dead = false
    this.sinceHurt = REGEN_DELAY
    this.flash = 0
    this.render()
  }

  update(dt: number): void {
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 2.6)
      // Quantized so the flash drops out in visible steps.
      this.vignette.style.opacity = String(Math.ceil(this.flash * 4) / 4)
    }
    if (this.dead || this.hp >= MAX_HP) return
    this.sinceHurt += dt
    if (this.sinceHurt < REGEN_DELAY) return
    this.hp = Math.min(MAX_HP, this.hp + REGEN_RATE * dt)
    this.render()
  }

  private render(): void {
    const perCell = MAX_HP / SEGMENTS
    for (let i = 0; i < SEGMENTS; i++) {
      const filled = Math.max(0, Math.min(1, this.hp / perCell - i))
      this.fills[i].style.width = `${filled * 100}%`
    }
    this.frame.classList.toggle('hurt', this.hp <= MAX_HP * 0.6 && this.hp > CRITICAL)
    this.frame.classList.toggle('critical', this.hp <= CRITICAL && this.hp > 0)
    this.frame.classList.toggle('down', this.hp === 0)
    this.frame.setAttribute('aria-valuenow', String(Math.round(this.hp)))
  }
}
