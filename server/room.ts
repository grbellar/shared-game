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
  hat: string
}

interface Score {
  id: string
  name: string
  kills: number
  deaths: number
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
  // Kill tally for the killboard. Entries outlive the connection that earned
  // them, so leaving doesn't wipe your record for the session.
  private scores = new Map<string, Score>()
  // Treasure caches already dug up (indices into the client's deterministic
  // cache list). Replayed in `welcome` so a late joiner can't re-claim one.
  private found: number[] = []

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
      JSON.stringify({
        t: 'welcome',
        id,
        players: [...this.states.values()],
        craters: this.craters,
        scores: [...this.scores.values()],
        found: this.found,
      }),
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
        hat: String(msg.hat ?? 'none').slice(0, 12),
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
      const victim = String(msg.victim).slice(0, 16)
      const killerName = this.states.get(att.id)?.name ?? 'someone'
      const victimName = this.states.get(victim)?.name ?? 'someone'
      this.broadcast(
        JSON.stringify({ t: 'kill', victim, killer: att.id, killerName, victimName }),
        ws,
      )
      // The room keeps the tally so every killboard agrees. Suicides (which
      // shouldn't happen, but clients are trusted) only count as a death.
      if (victim !== att.id) this.score(att.id, killerName).kills++
      this.score(victim, victimName).deaths++
      this.broadcast(JSON.stringify({ t: 'score', scores: [...this.scores.values()] }))
    } else if (msg.t === 'egg') {
      const k = String(msg.k).slice(0, 12)
      const n = Number(msg.n)
      // 'dig' claims a treasure cache — the only egg the room remembers, so
      // late joiners can't dig up something that's already gone.
      if (k === 'dig') {
        if (!Number.isInteger(n) || n < 0 || n > 63) return
        if (this.found.includes(n)) return
        this.found.push(n)
      }
      const name = this.states.get(att.id)?.name ?? 'someone'
      this.broadcast(
        JSON.stringify({ t: 'egg', id: att.id, name, k, n: Number.isFinite(n) ? n : undefined }),
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

  // Fetch (or start) a player's row on the killboard, keeping the name fresh.
  private score(id: string, name: string): Score {
    let row = this.scores.get(id)
    if (!row) {
      row = { id, name, kills: 0, deaths: 0 }
      // Cap the board so a long-lived room can't grow without bound; the
      // oldest record falls off first.
      if (this.scores.size >= 32) {
        const oldest = this.scores.keys().next()
        if (!oldest.done) this.scores.delete(oldest.value)
      }
      this.scores.set(id, row)
    }
    row.name = name
    return row
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
