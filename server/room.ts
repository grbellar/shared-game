import { DurableObject } from 'cloudflare:workers'
import type { Env } from './index'

// Keep in sync with src/net.ts
interface Crater {
  x: number
  z: number
  r: number
  d: number
}

interface Block {
  gx: number
  gy: number
  gz: number
  m: number
  hp: number
}

const BLOCK_HP = [2, 4, 6, 8] // keep in sync with MATERIALS in src/blocks.ts
const BLOCK_CAP = 1500
const GRID_XZ_MAX = 110 // |gx|,|gz| cap — keep in sync with src/blocks.ts

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

// Real seconds per full in-game day. Keep in sync with src/daynight.ts.
const DAY_LENGTH_S = 600

// Dumb relay: clients send their own state, the room broadcasts it to
// everyone else. No server authority — this is a game between friends.
export class GameRoom extends DurableObject<Env> {
  // Last known state per player. In-memory only: if the DO hibernates this
  // empties out, but clients re-send state ~15x/sec so it refills instantly.
  private states = new Map<string, PlayerState>()
  // World damage (blast craters, shovel digs), replayed to late joiners in
  // `welcome`. In-memory like `states`: hibernation heals the island.
  private craters: Crater[] = []
  // Player-built blocks, keyed by grid cell. Remaining hp lives here so
  // half-damaged blocks replay accurately; insertion order doubles as the
  // eviction order when the cap trips. In-memory like everything else.
  private blocks = new Map<string, Block>()
  // The shared day/night clock: time-of-day in hours anchored to this DO's
  // wall clock. Scrubs/pauses re-anchor it; late joiners get the advanced
  // value in `welcome`. In-memory: hibernation resets to mid-morning.
  private clock = { hours: 10, atMs: Date.now(), running: true }

  private clockHours(): number {
    if (!this.clock.running) return this.clock.hours
    return (this.clock.hours + ((Date.now() - this.clock.atMs) / 1000) * (24 / DAY_LENGTH_S)) % 24
  }

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
        blocks: [...this.blocks.values()],
        clock: { hours: this.clockHours(), running: this.clock.running },
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
    } else if (msg.t === 'hit') {
      // Relayed damage. Only the named victim acts on it: they own their own
      // health, and they're the one who announces the resulting `kill`.
      const dmg = Number(msg.dmg)
      if (!Number.isFinite(dmg)) return
      this.broadcast(
        JSON.stringify({
          t: 'hit',
          id: att.id,
          victim: String(msg.victim).slice(0, 16),
          dmg: Math.max(0, Math.min(100, dmg)),
        }),
        ws,
      )
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
    } else if (msg.t === 'clock') {
      const hours = Number(msg.hours)
      if (!Number.isFinite(hours)) return
      this.clock = {
        hours: ((hours % 24) + 24) % 24,
        atMs: Date.now(),
        running: msg.running === true,
      }
      this.broadcast(
        JSON.stringify({ t: 'clock', hours: this.clock.hours, running: this.clock.running }),
        ws,
      )
    } else if (msg.t === 'bplace') {
      const gx = Number(msg.gx)
      const gy = Number(msg.gy)
      const gz = Number(msg.gz)
      const m = Number(msg.m)
      // Reject rather than clamp: a clamped block would land somewhere the
      // client didn't ask for and fork everyone's world.
      if (!Number.isInteger(gx) || !Number.isInteger(gy) || !Number.isInteger(gz)) return
      if (Math.abs(gx) > GRID_XZ_MAX || Math.abs(gz) > GRID_XZ_MAX || gy < -8 || gy > 40) return
      if (!Number.isInteger(m) || m < 0 || m >= BLOCK_HP.length) return
      const cell = `${gx},${gy},${gz}`
      // Simultaneous place: first writer wins, the loser's phantom block
      // heals on their next welcome.
      if (this.blocks.has(cell)) return
      this.blocks.set(cell, { gx, gy, gz, m, hp: BLOCK_HP[m] })
      this.broadcast(JSON.stringify({ t: 'bplace', gx, gy, gz, m }), ws)
      if (this.blocks.size > BLOCK_CAP) {
        // Evict the oldest block and tell EVERYONE (no except): reusing the
        // bhit remove path keeps every client converged, including whoever
        // placed the block that tripped the cap.
        const oldest: Block = this.blocks.values().next().value!
        this.blocks.delete(`${oldest.gx},${oldest.gy},${oldest.gz}`)
        this.broadcast(
          JSON.stringify({ t: 'bhit', gx: oldest.gx, gy: oldest.gy, gz: oldest.gz, dmg: 999 }),
        )
      }
    } else if (msg.t === 'bhit') {
      const gx = Number(msg.gx)
      const gy = Number(msg.gy)
      const gz = Number(msg.gz)
      if (!Number.isInteger(gx) || !Number.isInteger(gy) || !Number.isInteger(gz)) return
      const dmg = Math.max(1, Math.min(999, Math.round(Number(msg.dmg) || 0)))
      const b = this.blocks.get(`${gx},${gy},${gz}`)
      if (!b) return // stale hit on an already-dead block: drop, don't relay
      b.hp -= dmg
      if (b.hp <= 0) this.blocks.delete(`${gx},${gy},${gz}`)
      // hp is a commutative sum of relayed dmg, so clients that see hits in
      // different orders still agree on when a block dies.
      this.broadcast(JSON.stringify({ t: 'bhit', gx, gy, gz, dmg }), ws)
    } else if (msg.t === 'pet') {
      // Cats are deterministic (src/cats.ts), so the index is all anyone
      // needs to pop a heart over the right one.
      const cat = Math.floor(Number(msg.cat))
      if (!Number.isFinite(cat) || cat < 0 || cat > 15) return
      this.broadcast(JSON.stringify({ t: 'pet', id: att.id, cat }), ws)
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
