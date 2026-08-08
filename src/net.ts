// Keep the message types in sync with server/room.ts

export interface PlayerState {
  id: string
  x: number
  y: number
  z: number
  ry: number
  color: string
  name: string
  weapon: string // 'none' | 'gun' | 'sword'
}

type ServerMsg =
  | { t: 'welcome'; id: string; players: PlayerState[] }
  | { t: 'state'; p: PlayerState }
  | { t: 'leave'; id: string }
  | { t: 'chat'; id: string; name: string; text: string }
  | { t: 'fire'; id: string; x: number; y: number; z: number; dx: number; dy: number; dz: number }
  | { t: 'slash'; id: string }
  | { t: 'kill'; victim: string }

export class Net {
  id: string | null = null
  onWelcome: (players: PlayerState[]) => void = () => {}
  onState: (p: PlayerState) => void = () => {}
  onLeave: (id: string) => void = () => {}
  onChat: (id: string, name: string, text: string) => void = () => {}
  onFire: (id: string, origin: [number, number, number], dir: [number, number, number]) => void =
    () => {}
  onSlash: (id: string) => void = () => {}
  onKill: (victim: string) => void = () => {}
  private ws: WebSocket | null = null

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws = ws
    ws.onmessage = (event) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg.t === 'welcome') {
        this.id = msg.id
        this.onWelcome(msg.players)
      } else if (msg.t === 'state') {
        if (msg.p.id !== this.id) this.onState(msg.p)
      } else if (msg.t === 'leave') {
        this.onLeave(msg.id)
      } else if (msg.t === 'chat') {
        if (msg.id !== this.id) this.onChat(msg.id, msg.name, msg.text)
      } else if (msg.t === 'fire') {
        if (msg.id !== this.id) this.onFire(msg.id, [msg.x, msg.y, msg.z], [msg.dx, msg.dy, msg.dz])
      } else if (msg.t === 'slash') {
        if (msg.id !== this.id) this.onSlash(msg.id)
      } else if (msg.t === 'kill') {
        this.onKill(msg.victim)
      }
    }
    ws.onclose = () => {
      this.id = null
      setTimeout(() => this.connect(), 1500)
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.id !== null
  }

  sendState(state: Omit<PlayerState, 'id'>): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'state', ...state }))
  }

  sendChat(text: string): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'chat', text }))
  }

  sendFire(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }): void {
    if (!this.connected) return
    this.ws!.send(
      JSON.stringify({ t: 'fire', x: origin.x, y: origin.y, z: origin.z, dx: dir.x, dy: dir.y, dz: dir.z }),
    )
  }

  sendSlash(): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'slash' }))
  }

  sendKill(victim: string): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'kill', victim }))
  }
}
