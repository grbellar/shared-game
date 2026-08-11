import { sfx } from './audio'

// The games inside the Old Town arcade's cabinets (arcade.ts). Each one
// draws into a 64x64 canvas — the same chunky-pixel budget as every other
// canvas texture in the game — and reads five held inputs. They are entirely
// local: nothing about a run is synced, only the high-score brag that rides
// the ordinary chat relay (see main.ts). Randomness is therefore fine here,
// the one corner of the codebase where Math.random can't fork anything.

export interface ArcadeInput {
  left: boolean
  right: boolean
  up: boolean
  down: boolean
  a: boolean // the one red button (space)
}

export interface ArcadeGame {
  title: string
  accent: number // cabinet paint and screen tint
  score: number
  over: boolean
  reset(): void
  update(dt: number, input: ArcadeInput, g: CanvasRenderingContext2D): void
  // Idle loop for a cabinet nobody is standing at.
  attract(t: number, g: CanvasRenderingContext2D): void
}

const S = 64

function clear(g: CanvasRenderingContext2D, color: string): void {
  g.fillStyle = color
  g.fillRect(0, 0, S, S)
}

function text(g: CanvasRenderingContext2D, s: string, y: number, color = '#fff'): void {
  g.fillStyle = color
  g.font = 'bold 8px monospace'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(s, S / 2, y, S - 4)
}

function drawOver(g: CanvasRenderingContext2D, score: number): void {
  clear(g, '#100a12')
  text(g, 'GAME OVER', 22, '#ff5a5a')
  text(g, String(score), 34, '#ffd54a')
  text(g, 'SPACE', 48, '#7a7a88')
}

// A press, not a hold: every game that fires or flaps wants the edge.
class Edge {
  private held = false
  hit(now: boolean): boolean {
    const fresh = now && !this.held
    this.held = now
    return fresh
  }
}

// ---- WORM -------------------------------------------------------------------
// Snake on a 16x16 grid. Eat, grow, don't eat yourself.

export class Worm implements ArcadeGame {
  title = 'WORM'
  accent = 0x39c66a
  score = 0
  over = false
  private body: number[] = [] // packed gx * 16 + gz, head first
  private dx = 1
  private dz = 0
  private food = 0
  private t = 0
  private pace = 0.16

  reset(): void {
    this.body = [8 * 16 + 8, 7 * 16 + 8, 6 * 16 + 8]
    this.dx = 1
    this.dz = 0
    this.score = 0
    this.pace = 0.16
    this.over = false
    this.t = 0
    this.drop()
  }

  private drop(): void {
    do this.food = Math.floor(Math.random() * 256)
    while (this.body.includes(this.food))
  }

  update(dt: number, input: ArcadeInput, g: CanvasRenderingContext2D): void {
    if (this.over) {
      drawOver(g, this.score)
      if (input.a) this.reset()
      return
    }
    // Steer, no reversing down your own throat.
    if (input.left && this.dx !== 1) (this.dx = -1), (this.dz = 0)
    else if (input.right && this.dx !== -1) (this.dx = 1), (this.dz = 0)
    else if (input.up && this.dz !== 1) (this.dx = 0), (this.dz = -1)
    else if (input.down && this.dz !== -1) (this.dx = 0), (this.dz = 1)

    this.t += dt
    while (this.t >= this.pace) {
      this.t -= this.pace
      const hx = Math.floor(this.body[0] / 16) + this.dx
      const hz = (this.body[0] % 16) + this.dz
      const head = hx * 16 + hz
      if (hx < 0 || hx > 15 || hz < 0 || hz > 15 || this.body.includes(head)) {
        this.over = true
        sfx.arcadeOver()
        return
      }
      this.body.unshift(head)
      if (head === this.food) {
        this.score += 10
        this.pace = Math.max(0.07, this.pace * 0.97)
        sfx.arcadeBlip(660)
        this.drop()
      } else this.body.pop()
    }

    clear(g, '#0a1408')
    g.fillStyle = '#ff4a4a'
    g.fillRect(Math.floor(this.food / 16) * 4, (this.food % 16) * 4, 4, 4)
    this.body.forEach((c, i) => {
      g.fillStyle = i === 0 ? '#b8ffb0' : '#39c66a'
      g.fillRect(Math.floor(c / 16) * 4, (c % 16) * 4, 4, 4)
    })
  }

  attract(t: number, g: CanvasRenderingContext2D): void {
    clear(g, '#0a1408')
    text(g, 'WORM', 20, '#39c66a')
    // A demo worm laps the border, eternally.
    const p = Math.floor((t * 6) % 60)
    for (let i = 0; i < 8; i++) {
      const k = (p - i + 60) % 60
      const x = k < 15 ? k : k < 30 ? 15 : k < 45 ? 45 - k : 0
      const z = k < 15 ? 0 : k < 30 ? k - 15 : k < 45 ? 15 : 60 - k
      g.fillStyle = i === 0 ? '#b8ffb0' : '#39c66a'
      g.fillRect(x * 4, 40 + Math.floor(z / 4), 4, 4)
    }
    if (Math.floor(t * 2) % 2) text(g, 'PRESS X', 32, '#8888a0')
  }
}

// ---- BRICKS -----------------------------------------------------------------
// Breakout: paddle, ball, a wall that deserves it. Three lives.

export class Bricks implements ArcadeGame {
  title = 'BRICKS'
  accent = 0xe2703b
  score = 0
  over = false
  private px = 26 // paddle left edge
  private bx = 32
  private by = 40
  private vx = 22
  private vy = -30
  private wall: boolean[] = []
  private lives = 3

  reset(): void {
    this.score = 0
    this.over = false
    this.lives = 3
    this.rack(1)
  }

  private rack(speed: number): void {
    this.wall = new Array(32).fill(true)
    this.px = 26
    this.bx = 32
    this.by = 40
    this.vx = 22 * speed * (Math.random() < 0.5 ? -1 : 1)
    this.vy = -30 * speed
  }

  update(dt: number, input: ArcadeInput, g: CanvasRenderingContext2D): void {
    if (this.over) {
      drawOver(g, this.score)
      if (input.a) this.reset()
      return
    }
    if (input.left) this.px = Math.max(0, this.px - 46 * dt)
    if (input.right) this.px = Math.min(S - 12, this.px + 46 * dt)
    this.bx += this.vx * dt
    this.by += this.vy * dt
    if (this.bx < 1 || this.bx > S - 1) (this.vx = -this.vx), sfx.arcadeBlip(220)
    if (this.by < 1) (this.vy = Math.abs(this.vy)), sfx.arcadeBlip(220)
    // Paddle at y=58: reflect, with english off the ends.
    if (this.by > 57 && this.by < 60 && this.bx > this.px - 1 && this.bx < this.px + 13) {
      this.vy = -Math.abs(this.vy)
      this.vx += ((this.bx - (this.px + 6)) / 6) * 18
      sfx.arcadeBlip(330)
    }
    if (this.by > 64) {
      if (--this.lives <= 0) {
        this.over = true
        sfx.arcadeOver()
        return
      }
      this.bx = 32
      this.by = 40
      this.vy = -Math.abs(this.vy)
    }
    // Bricks: 8 x 4, each 8x4 px, from y=8.
    const col = Math.floor(this.bx / 8)
    const row = Math.floor((this.by - 8) / 4)
    if (row >= 0 && row < 4 && col >= 0 && col < 8 && this.wall[row * 8 + col]) {
      this.wall[row * 8 + col] = false
      this.vy = -this.vy
      this.score += 5
      sfx.arcadeBlip(520 + row * 90)
      if (!this.wall.some(Boolean)) this.rack(1.15) // next wall, hotter ball
    }

    clear(g, '#0c0a14')
    const tints = ['#ff5a5a', '#ffb03a', '#ffe25a', '#5ad06a']
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 8; c++)
        if (this.wall[r * 8 + c]) {
          g.fillStyle = tints[r]
          g.fillRect(c * 8 + 1, 8 + r * 4, 6, 3)
        }
    g.fillStyle = '#e8e8f0'
    g.fillRect(this.px, 58, 12, 2)
    g.fillRect(this.bx - 1, this.by - 1, 3, 3)
  }

  attract(t: number, g: CanvasRenderingContext2D): void {
    clear(g, '#0c0a14')
    text(g, 'BRICKS', 20, '#e2703b')
    const x = 32 + Math.sin(t * 2.2) * 22
    const y = 44 + Math.abs(Math.sin(t * 3.1)) * -14
    g.fillStyle = '#e8e8f0'
    g.fillRect(x - 1, y, 3, 3)
    g.fillRect(30 + Math.sin(t * 2.2) * 20, 58, 12, 2)
    if (Math.floor(t * 2) % 2) text(g, 'PRESS X', 32, '#8888a0')
  }
}

// ---- PONG -------------------------------------------------------------------
// You on the left, the machine on the right. First to five.

export class Pong implements ArcadeGame {
  title = 'PONG'
  accent = 0xd8d8e4
  score = 0
  over = false
  private my = 28
  private ay = 28
  private bx = 32
  private by = 32
  private vx = 30
  private vy = 12
  private mine = 0
  private theirs = 0

  reset(): void {
    this.score = 0
    this.over = false
    this.mine = 0
    this.theirs = 0
    this.serve(1)
  }

  private serve(dir: number): void {
    this.bx = 32
    this.by = 32
    this.vx = 30 * dir
    this.vy = (Math.random() - 0.5) * 30
  }

  update(dt: number, input: ArcadeInput, g: CanvasRenderingContext2D): void {
    if (this.over) {
      clear(g, '#08080c')
      text(g, this.mine >= 5 ? 'YOU WIN' : 'MACHINE', 22, this.mine >= 5 ? '#5ad06a' : '#ff5a5a')
      text(g, `${this.mine}-${this.theirs}`, 34, '#ffd54a')
      text(g, 'SPACE', 48, '#7a7a88')
      if (input.a) this.reset()
      return
    }
    if (input.up) this.my = Math.max(0, this.my - 52 * dt)
    if (input.down) this.my = Math.min(S - 12, this.my + 52 * dt)
    // The machine is beatable: capped chase speed, aims late.
    const want = this.by - 6
    this.ay += Math.max(-34 * dt, Math.min(34 * dt, want - this.ay))
    this.bx += this.vx * dt
    this.by += this.vy * dt
    if (this.by < 1 || this.by > S - 1) (this.vy = -this.vy), sfx.arcadeBlip(200)
    if (this.bx < 4 && this.by > this.my - 1 && this.by < this.my + 13) {
      this.vx = Math.abs(this.vx) * 1.06
      this.vy += ((this.by - (this.my + 6)) / 6) * 20
      sfx.arcadeBlip(440)
    } else if (this.bx > 60 && this.by > this.ay - 1 && this.by < this.ay + 13) {
      this.vx = -Math.abs(this.vx) * 1.06
      sfx.arcadeBlip(300)
    }
    if (this.bx < -2 || this.bx > 66) {
      if (this.bx < 0) this.theirs++
      else {
        this.mine++
        this.score = this.mine * 100
        sfx.arcadeBlip(700)
      }
      if (this.mine >= 5 || this.theirs >= 5) {
        this.over = true
        sfx.arcadeOver()
        return
      }
      this.serve(this.bx < 0 ? 1 : -1)
    }

    clear(g, '#08080c')
    g.fillStyle = '#2c2c38'
    for (let y = 2; y < S; y += 8) g.fillRect(31, y, 2, 4)
    text(g, `${this.mine}  ${this.theirs}`, 8, '#6a6a7a')
    g.fillStyle = '#e8e8f0'
    g.fillRect(2, this.my, 2, 12)
    g.fillRect(60, this.ay, 2, 12)
    g.fillRect(this.bx - 1, this.by - 1, 3, 3)
  }

  attract(t: number, g: CanvasRenderingContext2D): void {
    clear(g, '#08080c')
    text(g, 'PONG', 20, '#d8d8e4')
    const y = 32 + Math.sin(t * 3) * 18
    g.fillStyle = '#e8e8f0'
    g.fillRect(2, y - 6 + Math.sin(t * 3) * 4, 2, 12)
    g.fillRect(60, y - 6 - Math.sin(t * 3) * 4, 2, 12)
    g.fillRect(30 + Math.sin(t * 3) * 26, y, 3, 3)
    if (Math.floor(t * 2) % 2) text(g, 'PRESS X', 44, '#8888a0')
  }
}

// ---- INVADERS ---------------------------------------------------------------
// A grid of somethings descending. One bullet in the air at a time, the way
// the original kept you honest.

export class Invaders implements ArcadeGame {
  title = 'INVADERS'
  accent = 0x7a5ad0
  score = 0
  over = false
  private alive: boolean[] = []
  private ox = 6
  private oy = 8
  private dir = 1
  private stepT = 0
  private pace = 0.5
  private sx = 30
  private shot: { x: number; y: number } | null = null
  private bombs: { x: number; y: number }[] = []
  private wave = 1
  private fire = new Edge()

  reset(): void {
    this.score = 0
    this.over = false
    this.wave = 1
    this.rack()
  }

  private rack(): void {
    this.alive = new Array(18).fill(true)
    this.ox = 6
    this.oy = 8
    this.dir = 1
    this.pace = Math.max(0.16, 0.5 - (this.wave - 1) * 0.07)
    this.stepT = 0
    this.shot = null
    this.bombs = []
  }

  update(dt: number, input: ArcadeInput, g: CanvasRenderingContext2D): void {
    if (this.over) {
      drawOver(g, this.score)
      if (input.a) this.reset()
      return
    }
    if (input.left) this.sx = Math.max(2, this.sx - 40 * dt)
    if (input.right) this.sx = Math.min(S - 6, this.sx + 40 * dt)
    if (this.fire.hit(input.a) && !this.shot) {
      this.shot = { x: this.sx + 2, y: 56 }
      sfx.arcadeBlip(880)
    }

    // The rank steps as one, drops at the walls, quickens as it thins.
    this.stepT += dt
    if (this.stepT >= this.pace) {
      this.stepT = 0
      const left = this.edge(-1)
      const right = this.edge(1)
      if ((this.dir > 0 && right >= 58) || (this.dir < 0 && left <= 2)) {
        this.dir = -this.dir
        this.oy += 4
      } else this.ox += this.dir * 3
      // One bomb per step from a random survivor's column.
      const cols = this.columns()
      if (cols.length) {
        const c = cols[Math.floor(Math.random() * cols.length)]
        this.bombs.push({ x: this.ox + c * 9 + 2, y: this.oy + 14 })
      }
    }

    if (this.shot) {
      this.shot.y -= 90 * dt
      if (this.shot.y < 0) this.shot = null
      else {
        const c = Math.floor((this.shot.x - this.ox) / 9)
        const r = Math.floor((this.shot.y - this.oy) / 6)
        if (c >= 0 && c < 6 && r >= 0 && r < 3 && this.alive[r * 6 + c]) {
          this.alive[r * 6 + c] = false
          this.score += 20
          this.shot = null
          const left = this.alive.filter(Boolean).length
          this.pace = Math.max(0.1, this.pace * (left ? 0.96 : 1))
          sfx.arcadeBlip(520)
          if (!left) {
            this.wave++
            this.score += 50
            this.rack()
          }
        }
      }
    }
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i]
      b.y += 40 * dt
      if (b.y > 64) this.bombs.splice(i, 1)
      else if (b.y > 56 && b.y < 62 && Math.abs(b.x - (this.sx + 2)) < 3.5) {
        this.over = true
        sfx.arcadeOver()
        return
      }
    }
    if (this.oy + 14 >= 54) {
      this.over = true // they landed
      sfx.arcadeOver()
      return
    }

    clear(g, '#060610')
    g.fillStyle = '#a88aff'
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 6; c++)
        if (this.alive[r * 6 + c]) {
          const x = this.ox + c * 9
          const y = this.oy + r * 6
          g.fillRect(x, y, 5, 3)
          g.fillRect(x + (Math.floor(this.stepT * 4) % 2 ? 0 : 4), y + 3, 1, 1)
        }
    g.fillStyle = '#5ad06a'
    g.fillRect(this.sx, 58, 5, 3)
    g.fillRect(this.sx + 2, 56, 1, 2)
    if (this.shot) {
      g.fillStyle = '#fff'
      g.fillRect(this.shot.x, this.shot.y, 1, 3)
    }
    g.fillStyle = '#ff8a5a'
    for (const b of this.bombs) g.fillRect(b.x, b.y, 1, 3)
  }

  private edge(dir: number): number {
    let best = dir > 0 ? 0 : 64
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 6; c++)
        if (this.alive[r * 6 + c]) {
          const x = this.ox + c * 9 + (dir > 0 ? 5 : 0)
          best = dir > 0 ? Math.max(best, x) : Math.min(best, x)
        }
    return best
  }

  private columns(): number[] {
    const out: number[] = []
    for (let c = 0; c < 6; c++) if (this.alive.some((a, i) => a && i % 6 === c)) out.push(c)
    return out
  }

  attract(t: number, g: CanvasRenderingContext2D): void {
    clear(g, '#060610')
    text(g, 'INVADERS', 18, '#a88aff')
    const ox = 14 + Math.sin(t * 1.5) * 8
    g.fillStyle = '#a88aff'
    for (let c = 0; c < 4; c++) g.fillRect(ox + c * 10, 36, 5, 3)
    g.fillStyle = '#5ad06a'
    g.fillRect(30, 56, 5, 3)
    if (Math.floor(t * 2) % 2) text(g, 'PRESS X', 27, '#8888a0')
  }
}

// ---- HOPPER -----------------------------------------------------------------
// One button. The bird is a box, the pipes are grudges.

export class Hopper implements ArcadeGame {
  title = 'HOPPER'
  accent = 0xffd54a
  score = 0
  over = false
  private y = 30
  private vy = 0
  private pipes: { x: number; gap: number; passed: boolean }[] = []
  private flap = new Edge()

  reset(): void {
    this.score = 0
    this.over = false
    this.y = 30
    this.vy = 0
    this.pipes = [
      { x: 70, gap: 28, passed: false },
      { x: 105, gap: 18, passed: false },
    ]
  }

  update(dt: number, input: ArcadeInput, g: CanvasRenderingContext2D): void {
    if (this.over) {
      drawOver(g, this.score)
      if (input.a) this.reset()
      return
    }
    if (this.flap.hit(input.a)) {
      this.vy = -46
      sfx.arcadeBlip(500)
    }
    this.vy += 120 * dt
    this.y += this.vy * dt
    const speed = 26 + Math.min(20, this.score * 0.8)
    for (const p of this.pipes) {
      p.x -= speed * dt
      if (!p.passed && p.x < 12) {
        p.passed = true
        this.score++
        sfx.arcadeBlip(700)
      }
      if (p.x < -6) {
        p.x += 70
        p.gap = 10 + Math.random() * 40
        p.passed = false
      }
      // The gap is 22 tall; the bird is a 4px box at x 12..16.
      if (p.x < 16 && p.x + 6 > 12 && (this.y < p.gap || this.y + 4 > p.gap + 22)) {
        this.over = true
        sfx.arcadeOver()
        return
      }
    }
    if (this.y < -2 || this.y > 62) {
      this.over = true
      sfx.arcadeOver()
      return
    }

    clear(g, '#0e1626')
    g.fillStyle = '#3f8a4f'
    for (const p of this.pipes) {
      g.fillRect(p.x, 0, 6, p.gap)
      g.fillRect(p.x, p.gap + 22, 6, 64)
    }
    g.fillStyle = '#ffd54a'
    g.fillRect(12, this.y, 4, 4)
    g.fillStyle = '#ff8a3a'
    g.fillRect(16, this.y + 1, 2, 2)
    text(g, String(this.score), 8, '#ffffff')
  }

  attract(t: number, g: CanvasRenderingContext2D): void {
    clear(g, '#0e1626')
    text(g, 'HOPPER', 20, '#ffd54a')
    g.fillStyle = '#ffd54a'
    g.fillRect(30, 38 + Math.sin(t * 4) * 6, 4, 4)
    if (Math.floor(t * 2) % 2) text(g, 'PRESS X', 32, '#8888a0')
  }
}

// The full lineup, in cabinet order. Duplicates get their own instance so
// two people back home can't scramble each other's run.
export function buildLineup(): ArcadeGame[] {
  return [
    new Worm(),
    new Bricks(),
    new Pong(),
    new Invaders(),
    new Hopper(),
    new Worm(),
    new Bricks(),
    new Invaders(),
  ]
}
