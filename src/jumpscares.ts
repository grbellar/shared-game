import { sfx } from './audio'

const MIN_DELAY_MS = 35_000
const MAX_DELAY_MS = 110_000

const VISIONS = [
  {
    words: "DON'T TURN AROUND",
    art: `
      <svg viewBox="0 0 320 240" aria-hidden="true">
        <path class="scar-fill" d="M73 219 93 71l45-44 69 8 34 57-11 127z"/>
        <path class="scar-ink" d="m104 81 38-25 51 6 29 39-18 92-34 22-55-20-22-71z"/>
        <path class="scar-eye" d="m108 111 40-18-9 43zM174 95l37 24-39 15z"/>
        <path class="scar-teeth" d="m124 160 78-5-17 38-43-4z"/>
        <path class="scar-line" d="m132 163 4 25m13-27 2 29m14-29-1 29m15-31-5 27"/>
      </svg>`,
  },
  {
    words: 'IT SAW YOU',
    art: `
      <svg viewBox="0 0 320 240" aria-hidden="true">
        <path class="scar-fill" d="M22 122Q82 35 160 35t138 87q-60 84-138 84T22 122Z"/>
        <path class="scar-ink" d="M54 122q48-60 106-60t106 60q-48 59-106 59T54 122Z"/>
        <ellipse class="scar-eye" cx="160" cy="122" rx="48" ry="54"/>
        <circle class="scar-ink" cx="160" cy="122" r="17"/>
        <path class="scar-line" d="M160 67V24m-40 52L96 39m105 37 25-39M84 99 39 83m197 16 45-18"/>
      </svg>`,
  },
  {
    words: 'WAKE UP',
    art: `
      <svg viewBox="0 0 320 240" aria-hidden="true">
        <path class="scar-fill" d="m78 213 9-138 70-54 74 52 15 140z"/>
        <path class="scar-ink" d="m100 91 57-48 54 46-9 111-45 20-48-23z"/>
        <circle class="scar-eye" cx="128" cy="116" r="25"/>
        <circle class="scar-eye" cx="188" cy="116" r="25"/>
        <circle class="scar-ink" cx="128" cy="116" r="8"/>
        <circle class="scar-ink" cx="188" cy="116" r="8"/>
        <path class="scar-eye" d="m118 167 40-24 42 24-42 38z"/>
        <path class="scar-line" d="m129 163 5 32m15-43 2 49m17-49-2 49m17-38-5 32"/>
      </svg>`,
  },
] as const

export class JumpScares {
  private overlay: HTMLDivElement
  private timer: number | undefined
  private hideTimer: number | undefined

  constructor(private enabled: () => boolean) {
    const style = document.createElement('style')
    style.textContent = `
      #jump-scare {
        position: fixed;
        inset: 0;
        z-index: 10000;
        display: none;
        overflow: hidden;
        pointer-events: none;
        background: #080000;
        color: #f5e9d4;
        font-family: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif;
      }
      #jump-scare.show {
        display: grid;
        place-items: center;
        animation: scare-shake 90ms steps(2, end) infinite;
      }
      #jump-scare::before {
        content: "";
        position: absolute;
        inset: -30%;
        background: repeating-linear-gradient(0deg, transparent 0 4px, rgba(255, 0, 0, .16) 5px 7px);
        transform: rotate(-3deg);
      }
      #jump-scare svg {
        position: absolute;
        width: min(125vw, 920px);
        height: min(125vh, 760px);
        filter: drop-shadow(0 0 16px #ff1d00);
      }
      #jump-scare .scar-fill { fill: #d5160b; }
      #jump-scare .scar-ink { fill: #050000; }
      #jump-scare .scar-eye, #jump-scare .scar-teeth { fill: #fff1d6; }
      #jump-scare .scar-line { fill: none; stroke: #050000; stroke-width: 7; }
      #jump-scare .scare-words {
        position: absolute;
        bottom: 7vh;
        left: 0;
        right: 0;
        z-index: 1;
        text-align: center;
        font-size: clamp(38px, 11vw, 130px);
        letter-spacing: .06em;
        line-height: .8;
        text-shadow: 5px 5px 0 #130000, -3px -3px 0 #d5160b;
        transform: rotate(-2deg);
      }
      @keyframes scare-shake {
        0% { transform: translate(-7px, 5px) scale(1.03); }
        50% { transform: translate(8px, -6px) scale(1.08); }
        100% { transform: translate(-3px, -8px) scale(1.05); }
      }
      @media (prefers-reduced-motion: reduce) {
        #jump-scare.show { animation: none; }
      }
    `
    document.head.appendChild(style)

    this.overlay = document.createElement('div')
    this.overlay.id = 'jump-scare'
    this.overlay.setAttribute('aria-hidden', 'true')
    document.body.appendChild(this.overlay)

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clear()
      else this.schedule()
    })
  }

  start(): void {
    this.schedule()
  }

  private schedule(): void {
    if (this.timer !== undefined || document.hidden) return
    const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS)
    this.timer = window.setTimeout(() => {
      this.timer = undefined
      if (this.enabled()) this.show()
      else this.schedule()
    }, delay)
  }

  private show(): void {
    const vision = VISIONS[Math.floor(Math.random() * VISIONS.length)]
    this.overlay.innerHTML = `${vision.art}<div class="scare-words">${vision.words}</div>`
    this.overlay.classList.add('show')
    sfx.jumpScare()

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    this.hideTimer = window.setTimeout(() => {
      this.overlay.classList.remove('show')
      this.overlay.replaceChildren()
      this.hideTimer = undefined
      this.schedule()
    }, reduced ? 650 : 950 + Math.random() * 350)
  }

  private clear(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    if (this.hideTimer !== undefined) window.clearTimeout(this.hideTimer)
    this.timer = undefined
    this.hideTimer = undefined
    this.overlay.classList.remove('show')
    this.overlay.replaceChildren()
  }
}
