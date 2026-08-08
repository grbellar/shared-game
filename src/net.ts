// Keep the message types in sync with server/room.ts

import type { Pose } from './character'

export interface PlayerState {
  id: string
  x: number
  y: number
  z: number
  ry: number
  color: string
  name: string
  pose: Pose
  gun: boolean
}

type ServerMsg =
  | { t: 'welcome'; id: string; players: PlayerState[] }
  | { t: 'state'; p: PlayerState }
  | { t: 'leave'; id: string }
  | { t: 'chat'; id: string; name: string; text: string }

export class Net {
  id: string | null = null
  onWelcome: (players: PlayerState[]) => void = () => {}
  onState: (p: PlayerState) => void = () => {}
  onLeave: (id: string) => void = () => {}
  onChat: (id: string, name: string, text: string) => void = () => {}
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
}
