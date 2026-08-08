// Kills and deaths for the room, held N to view (Tab is the map).
//
// The room owns the tally (server/room.ts counts `kill` messages and
// broadcasts a `score` list) so every board agrees and late joiners see the
// damage already done. Entries outlive the player who earned them — leaving
// does not wipe your record. Kill credit rides on the victim's own `kill`
// message, since under health.ts the victim is the only one who knows what
// finished them.

export interface Score {
  id: string
  name: string
  kills: number
  deaths: number
}

const HAT_BADGE: Record<string, string> = {
  crown: '👑',
  wizard: '🧙',
  pirate: '🏴‍☠️',
  tinfoil: '🥄',
  cone: '🚧',
  bucket: '🪣',
  duck: '🦆',
}

export class Killboard {
  private el: HTMLDivElement
  private scores: Score[] = []
  private hats = new Map<string, string>()
  private open = false

  constructor() {
    this.el = document.createElement('div')
    this.el.id = 'killboard'
    document.body.append(this.el)
  }

  setScores(scores: Score[]): void {
    this.scores = scores
    if (this.open) this.render()
  }

  // Hats aren't part of the score, but a crown on the leaderboard is the
  // whole point of digging one up.
  setHats(hats: Map<string, string>): void {
    this.hats = hats
    if (this.open) this.render()
  }

  show(): void {
    if (this.open) return
    this.open = true
    this.el.style.display = 'block'
    this.render()
  }

  hide(): void {
    this.open = false
    this.el.style.display = 'none'
  }

  private render(): void {
    const rows = [...this.scores].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    this.el.replaceChildren()

    const title = document.createElement('div')
    title.className = 'kb-title'
    title.textContent = 'KILLBOARD'
    this.el.append(title, row('kb-head', 'player', 'K', 'D'))

    if (!rows.length) {
      this.el.append(row('kb-empty', 'nobody has died yet', '', ''))
      return
    }
    for (const s of rows) {
      // Names come off the wire from other players, so they only ever go in
      // as text — row() uses textContent, never markup.
      const badge = HAT_BADGE[this.hats.get(s.id) ?? ''] ?? ''
      this.el.append(row('', `${badge}${s.name}`, String(s.kills), String(s.deaths)))
    }
  }
}

function row(extraClass: string, name: string, kills: string, deaths: string): HTMLDivElement {
  const div = document.createElement('div')
  div.className = extraClass ? `kb-row ${extraClass}` : 'kb-row'
  for (const text of [name, kills, deaths]) {
    const span = document.createElement('span')
    span.textContent = text
    div.append(span)
  }
  return div
}
