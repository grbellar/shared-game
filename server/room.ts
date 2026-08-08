import { DurableObject } from 'cloudflare:workers'
import type { Env } from './index'

// Keep in sync with src/net.ts
interface Crater {
  x: number
  z: number
  r: number
  d: number
}

interface PlayerState {
  id: string
  x: number
  y: number
  z: number
  ry: number
  color: string
  name: string
  pose: 'stand' | 'crouch' | 'swim'
  weapon: string
  ride: string
  talk: number
}

// Dumb relay: clients send their own state, the room broadcasts it to
// everyone else. No server authority — this is a game between friends.
export class GameRoom extends DurableObject<Env> {
  // Last known state per player. In-memory only: if the DO hibernates this
  // empties out, but clients re-send state ~15x/sec so it refills instantly.
  private states = new Map<string, PlayerState>()
  // World damage (blast craters, shovel digs), replayed to late joiners in
  // `welcome`. In-memory like `states`: hibernation heals the island.
  private craters: Crater[] = []

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    const id = crypto.randomUUID().slice(0, 8)
    server.serializeAttachment({ id })
    this.ctx.acceptWebSocket(server)
    server.send(
      JSON.stringify({ t: 'welcome', id, players: [...this.states.values()], craters: this.craters }),
    )
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return
    const att = ws.deserializeAttachment() as { id: string } | null
    if (!att) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(message)
    } catch {
      return
    }
    if (msg.t === 'state') {
      const p: PlayerState = {
        id: att.id,
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        z: Number(msg.z) || 0,
        ry: Number(msg.ry) || 0,
        color: String(msg.color).slice(0, 16),
        name: String(msg.name).slice(0, 24),
        pose: msg.pose === 'crouch' || msg.pose === 'swim' ? msg.pose : 'stand',
        weapon: String(msg.weapon).slice(0, 8),
        ride: String(msg.ride).slice(0, 12),
        talk: Math.max(0, Math.min(1, Number(msg.talk) || 0)),
      }
      this.states.set(att.id, p)
      this.broadcast(JSON.stringify({ t: 'state', p }), ws)
    } else if (msg.t === 'chat') {
      const text = String(msg.text).slice(0, 120)
      if (!text) return
      const name = this.states.get(att.id)?.name ?? 'someone'
      this.broadcast(JSON.stringify({ t: 'chat', id: att.id, name, text }), ws)
    } else if (msg.t === 'fire') {
      this.broadcast(
        JSON.stringify({
          t: 'fire',
          id: att.id,
          x: Number(msg.x) || 0,
          y: Number(msg.y) || 0,
          z: Number(msg.z) || 0,
          dx: Number(msg.dx) || 0,
          dy: Number(msg.dy) || 0,
          dz: Number(msg.dz) || 0,
        }),
        ws,
      )
    } else if (msg.t === 'slash') {
      this.broadcast(JSON.stringify({ t: 'slash', id: att.id }), ws)
    } else if (msg.t === 'kill') {
      this.broadcast(JSON.stringify({ t: 'kill', victim: String(msg.victim).slice(0, 16) }), ws)
    } else if (msg.t === 'arrow') {
      this.broadcast(
        JSON.stringify({
          t: 'arrow',
          id: att.id,
          x: Number(msg.x) || 0,
          y: Number(msg.y) || 0,
          z: Number(msg.z) || 0,
          dx: Number(msg.dx) || 0,
          dy: Number(msg.dy) || 0,
          dz: Number(msg.dz) || 0,
          p: Math.max(0, Math.min(1, Number(msg.p) || 0)),
        }),
        ws,
      )
    } else if (msg.t === 'crater') {
      const x = Number(msg.x)
      const z = Number(msg.z)
      const r = Number(msg.r)
      const d = Number(msg.d)
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(r) || !Number.isFinite(d))
        return
      const c: Crater = {
        x: Math.max(-170, Math.min(170, x)),
        z: Math.max(-170, Math.min(170, z)),
        r: Math.max(0.5, Math.min(8, r)),
        d: Math.max(0.1, Math.min(4, d)),
      }
      this.craters.push(c)
      // Cap the replay list; connected clients keep the oldest craters, only
      // late joiners lose them. Fine between friends.
      if (this.craters.length > 500) this.craters.shift()
      this.broadcast(JSON.stringify({ t: 'crater', ...c }), ws)
    } else if (msg.t === 'rtc') {
      // Voice-chat signaling: relay to exactly one peer, tagged with the
      // sender's id. Payload passes through untouched (SDP blobs).
      const to = String(msg.to)
      for (const peer of this.ctx.getWebSockets()) {
        const pa = peer.deserializeAttachment() as { id: string } | null
        if (pa?.id !== to) continue
        try {
          peer.send(JSON.stringify({ t: 'rtc', from: att.id, data: msg.data }))
        } catch {
          // Socket already dead; close events will clean it up.
        }
        break
      }
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.drop(ws)
  }

  webSocketError(ws: WebSocket): void {
    this.drop(ws)
  }

  private drop(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as { id: string } | null
    if (!att) return
    this.states.delete(att.id)
    this.broadcast(JSON.stringify({ t: 'leave', id: att.id }), ws)
  }

  private broadcast(data: string, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue
      try {
        ws.send(data)
      } catch {
        // Socket already dead; close events will clean it up.
      }
    }
  }
}
