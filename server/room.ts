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
const GRID_XZ_MAX = 1400 // |gx|,|gz| cap — keep in sync with src/blocks.ts
// Damage to blocks this room never stored: the castle in the shadow realm,
// which every client generates for itself. Roughly one entry per castle block
// anyone has touched, so the cap is sized to let the whole thing come down.
const WORLD_DMG_CAP = 5000
// Craters and world damage reach out to the realm — and to the far rock at
// x=280 (src/world.ts). Anything beyond this gets clamped somewhere nobody
// asked for, which forks everyone's terrain.
const WORLD_XZ_MAX = 2000
// Skeleton roster cap: 5 packed numbers each (see src/skeletons.ts), with room
// to grow the garrison without touching the server.
const SKEL_MAX_FIELDS = 64 * 5

interface PlayerState {
  id: string
  x: number
  y: number
  z: number
  ry: number
  rx: number // pitch — nonzero only for the X-wing (see src/xwing.ts)
  rz: number // roll
  color: string
  name: string
  pose: 'stand' | 'crouch' | 'swim'
  weapon: string
  ride: string
  skin: string
  talk: number
  emote: string
  hp: number // head pitch
  hy: number // head yaw, offset from the body's facing
  hat: string
}

interface Score {
  id: string
  name: string
  kills: number
  deaths: number
}

// A finite angle inside ±limit, or 0. Used for head aim (limits matching
// src/character.ts) and for the X-wing's pitch and roll.
function clampLook(v: unknown, limit: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(-limit, Math.min(limit, n))
}

// A finite number or 0. Infinity survives `Number(v) || 0` and then
// JSON.stringify turns it into null in every later welcome — so anything
// stored and replayed must come through here.
function finiteNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
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
  // Accumulated damage on cells that aren't in `blocks` — the castle, which
  // isn't ours to store because every client generates it identically. We
  // only have to remember how broken it is. Summed, so replay order can't
  // matter; insertion order doubles as the eviction order at the cap.
  private worldDmg = new Map<string, number>()
  // Where each Meckie was last left: index -> {x, z, by}. `by` is the id of
  // whoever is carrying them, '' if they're on the ground. A carried Meckie
  // needs no position updates — every client derives it from the carrier's
  // own state — so this only changes on a pick-up or a put-down.
  private meck = new Map<number, { x: number; z: number; by: string }>()
  // The shared day/night clock: time-of-day in hours anchored to this DO's
  // wall clock. Scrubs/pauses re-anchor it; late joiners get the advanced
  // value in `welcome`. In-memory: hibernation resets to mid-morning.
  private clock = { hours: 10, atMs: Date.now(), running: true }

  private clockHours(): number {
    if (!this.clock.running) return this.clock.hours
    return (this.clock.hours + ((Date.now() - this.clock.atMs) / 1000) * (24 / DAY_LENGTH_S)) % 24
  }

  // Last webcam frame per player (a small JPEG data URL), replayed in
  // `welcome` so late joiners see faces immediately instead of waiting up to
  // 200ms. Dropped when the player leaves or turns their camera off.
  private faces = new Map<string, string>()
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
        blocks: [...this.blocks.values()],
        wdmg: [...this.worldDmg].map(([cell, dmg]) => [...cell.split(',').map(Number), dmg]),
        clock: { hours: this.clockHours(), running: this.clock.running },
        faces: [...this.faces].map(([fid, d]) => ({ id: fid, d })),
        meck: [...this.meck].map(([i, m]) => [i, m.x, m.z, m.by]),
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
    // JSON.parse('null') succeeds — and msg.t on null would throw, which
    // resets the whole Durable Object and disconnects the room.
    if (msg === null || typeof msg !== 'object') return
    if (msg.t === 'state') {
      const p: PlayerState = {
        id: att.id,
        x: finiteNum(msg.x),
        y: finiteNum(msg.y),
        z: finiteNum(msg.z),
        ry: finiteNum(msg.ry),
        // Clamped to the flight model's own limits in src/xwing.ts, so a
        // bad number can't hand anyone an inside-out character.
        rx: clampLook(msg.rx, 1.6),
        rz: clampLook(msg.rz, 1.6),
        color: String(msg.color).slice(0, 16),
        name: String(msg.name).slice(0, 24),
        pose: msg.pose === 'crouch' || msg.pose === 'swim' ? msg.pose : 'stand',
        weapon: String(msg.weapon).slice(0, 8),
        ride: String(msg.ride).slice(0, 12),
        skin: String(msg.skin ?? 'none').slice(0, 12),
        talk: Math.max(0, Math.min(1, Number(msg.talk) || 0)),
        emote: String(msg.emote ?? 'none').slice(0, 12),
        hp: clampLook(msg.hp, 1.2),
        hy: clampLook(msg.hy, 1.0),
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
    } else if (msg.t === 'snipe') {
      this.broadcast(
        JSON.stringify({
          t: 'snipe',
          id: att.id,
          x: Number(msg.x) || 0,
          y: Number(msg.y) || 0,
          z: Number(msg.z) || 0,
          ex: Number(msg.ex) || 0,
          ey: Number(msg.ey) || 0,
          ez: Number(msg.ez) || 0,
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
      // The victim announces their own death (see Health in CLAUDE.md), so
      // the sender IS the victim and `by` is whoever they say finished them.
      // Deaths to lava, sharks and gravity arrive with no `by` at all.
      //
      // The victim is taken from the socket, never from the payload: this is
      // the one message that mutates stored room state (the killboard), so a
      // stale or buggy client must not be able to announce somebody else's
      // death or hang a kill on a player who isn't here.
      const victim = att.id
      if (String(msg.victim).slice(0, 16) !== victim) return
      const by = msg.by === undefined ? '' : String(msg.by).slice(0, 16)
      // An unknown killer id can't score — you can only be killed by someone
      // in the room, and unbacked ids would push real players off the board.
      const killer = this.states.has(by) ? by : ''
      const victimName = this.states.get(victim)?.name ?? 'someone'
      const killerName = killer ? (this.states.get(killer)?.name ?? 'someone') : ''
      this.broadcast(
        JSON.stringify({ t: 'kill', victim, killer, killerName, victimName }),
        ws,
      )
      // The room keeps the tally so every killboard agrees. Killing yourself
      // is a death and nothing else.
      if (killer && killer !== victim) this.score(killer, killerName).kills++
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
    } else if (msg.t === 'laser') {
      this.broadcast(
        JSON.stringify({
          t: 'laser',
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
    } else if (msg.t === 'crater') {
      const x = Number(msg.x)
      const z = Number(msg.z)
      const r = Number(msg.r)
      const d = Number(msg.d)
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(r) || !Number.isFinite(d))
        return
      const c: Crater = {
        x: Math.max(-WORLD_XZ_MAX, Math.min(WORLD_XZ_MAX, x)),
        z: Math.max(-WORLD_XZ_MAX, Math.min(WORLD_XZ_MAX, z)),
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
      if (Math.abs(gx) > GRID_XZ_MAX || Math.abs(gz) > GRID_XZ_MAX || gy < -8 || gy > 40) return
      const dmg = Math.max(1, Math.min(999, Math.round(Number(msg.dmg) || 0)))
      const cell = `${gx},${gy},${gz}`
      const b = this.blocks.get(cell)
      if (b) {
        b.hp -= dmg
        if (b.hp <= 0) this.blocks.delete(cell)
      } else {
        // Either a castle block — ours to remember the damage on, not the
        // block itself — or a stale hit on something already dead. We can't
        // tell the two apart and don't need to: damaging a cell with nothing
        // in it is a no-op on every client, so recording it is harmless.
        // But only remember cells where world-generated blocks can exist —
        // the realm's footprint (x 1800±400 over BLOCK 1.5 → gx 1200±267).
        // Anywhere else a recorded hit is pure no-op, and without this gate
        // one client spraying bhits at empty cells fills the cap and churns
        // real castle damage out of the map (the castle silently heals).
        if (Math.abs(gx - 1200) <= 267 && Math.abs(gz) <= 267) {
          this.worldDmg.set(cell, (this.worldDmg.get(cell) ?? 0) + dmg)
          if (this.worldDmg.size > WORLD_DMG_CAP) {
            this.worldDmg.delete(this.worldDmg.keys().next().value!)
          }
        }
      }
      // hp is a commutative sum of relayed dmg, so clients that see hits in
      // different orders still agree on when a block dies.
      this.broadcast(JSON.stringify({ t: 'bhit', gx, gy, gz, dmg }), ws)
    } else if (msg.t === 'pet') {
      // Cats are deterministic (src/cats.ts), so the index is all anyone
      // needs to pop a heart over the right one.
      const cat = Math.floor(Number(msg.cat))
      if (!Number.isFinite(cat) || cat < 0 || cat > 15) return
      this.broadcast(JSON.stringify({ t: 'pet', id: att.id, cat }), ws)
    } else if (msg.t === 'fw') {
      // A planted firework. Not replayed to late joiners: fuses burn down in
      // seconds, so there'd be nothing left to show them.
      const x = Number(msg.x)
      const z = Number(msg.z)
      const c = Math.floor(Number(msg.c))
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(c)) return
      this.broadcast(
        JSON.stringify({
          t: 'fw',
          id: att.id,
          // Wide enough to reach the shadow realm: clamping to the island
          // would relay someone's realm firework to everyone else's beach.
          x: Math.max(-WORLD_XZ_MAX, Math.min(WORLD_XZ_MAX, x)),
          z: Math.max(-WORLD_XZ_MAX, Math.min(WORLD_XZ_MAX, z)),
          c: Math.max(0, Math.min(15, c)),
        }),
        ws,
      )
    } else if (msg.t === 'fwgo') {
      this.broadcast(JSON.stringify({ t: 'fwgo', id: att.id }), ws)
    } else if (msg.t === 'face') {
      const d = String(msg.d)
      if (!d) {
        // Camera switched off: clear it everywhere.
        this.faces.delete(att.id)
        this.broadcast(JSON.stringify({ t: 'face', id: att.id, d: '' }), ws)
        return
      }
      // Only ever relay a small JPEG data URL. Clients feed this straight to
      // an Image, so don't let anything else through, and cap the size well
      // above a 64px frame (~1.5KB) but far below anything abusive.
      if (!d.startsWith('data:image/jpeg;base64,') || d.length > 8000) return
      this.faces.set(att.id, d)
      this.broadcast(JSON.stringify({ t: 'face', id: att.id, d }), ws)
    } else if (msg.t === 'shark') {
      // Relayed straight through: exactly one client (the lowest player id in
      // the room) owns the shark sim and pushes it ~10x/sec. Nothing is
      // stored — a late joiner picks it up on the next tick.
      const x = Number(msg.x)
      const z = Number(msg.z)
      const ry = Number(msg.ry)
      const hp = Number(msg.hp)
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(ry) || !Number.isFinite(hp))
        return
      this.broadcast(
        JSON.stringify({
          t: 'shark',
          x,
          z,
          ry,
          hp,
          st: String(msg.st).slice(0, 8),
          grab: String(msg.grab ?? '').slice(0, 16),
        }),
        ws,
      )
    } else if (msg.t === 'sharkhit') {
      const dmg = Number(msg.dmg)
      if (!Number.isFinite(dmg)) return
      this.broadcast(JSON.stringify({ t: 'sharkhit', dmg: Math.max(0, Math.min(200, dmg)) }), ws)
    } else if (msg.t === 'skel') {
      // The castle garrison, hosted by one client (lowest id) and relayed like
      // the shark. Not stored for late joiners: the roster is a fixed list in
      // castle.ts, and the next host update is a tenth of a second away.
      const s = msg.s
      if (!Array.isArray(s) || s.length > SKEL_MAX_FIELDS) return
      if (!s.every((n) => typeof n === 'number' && Number.isFinite(n))) return
      this.broadcast(JSON.stringify({ t: 'skel', s }), ws)
    } else if (msg.t === 'skelhit') {
      const i = Number(msg.i)
      const dmg = Number(msg.dmg)
      if (!Number.isInteger(i) || i < 0 || i > 63 || !Number.isFinite(dmg)) return
      this.broadcast(
        JSON.stringify({ t: 'skelhit', i, dmg: Math.max(0, Math.min(200, dmg)) }),
        ws,
      )
    } else if (msg.t === 'mg') {
      // One .50 round, straight through. Nothing stored: a tracer is gone in
      // a tenth of a second, and everything it actually broke arrives as the
      // ordinary hit / bhit / crater the shooter mints.
      this.broadcast(
        JSON.stringify({
          t: 'mg',
          id: att.id,
          x: Number(msg.x) || 0,
          y: Number(msg.y) || 0,
          z: Number(msg.z) || 0,
          tx: Number(msg.tx) || 0,
          ty: Number(msg.ty) || 0,
          tz: Number(msg.tz) || 0,
        }),
        ws,
      )
    } else if (msg.t === 'meck') {
      // Somebody picked a Meckie up or set them down. Last writer wins: two
      // people grabbing at once is rare and self-correcting, since the loser
      // sees the winner's relay and lets go.
      const i = Math.floor(Number(msg.i))
      const x = Number(msg.x)
      const z = Number(msg.z)
      if (!Number.isFinite(i) || i < 0 || i > 63) return
      if (!Number.isFinite(x) || !Number.isFinite(z)) return
      // 'me' means the sender; store the real id so a joiner can resolve it.
      const raw = String(msg.by ?? '').slice(0, 16)
      const by = raw === 'me' ? att.id : raw
      // Broadcast the same clamped values we store — relaying the raw ones
      // leaves live clients and late joiners disagreeing about where a
      // Meckie sits, with nothing to ever reconcile them.
      const cx = Math.max(-WORLD_XZ_MAX, Math.min(WORLD_XZ_MAX, x))
      const cz = Math.max(-WORLD_XZ_MAX, Math.min(WORLD_XZ_MAX, z))
      this.meck.set(i, { x: cx, z: cz, by })
      this.broadcast(JSON.stringify({ t: 'meck', id: att.id, i, x: cx, z: cz, by }), ws)
    } else if (msg.t === 'land') {
      // Rocket travel touching down. Relayed like `fire`: every client plays
      // the impact, and each one shoves only itself. Nothing stored — the
      // dust is gone in two seconds, so late joiners have nothing to catch up
      // on. The crater it leaves comes through as an ordinary `crater`.
      this.broadcast(
        JSON.stringify({
          t: 'land',
          id: att.id,
          x: Number(msg.x) || 0,
          y: Number(msg.y) || 0,
          z: Number(msg.z) || 0,
        }),
        ws,
      )
    } else if (msg.t === 'mob') {
      // Land mobs (bear, gary): same host-streamed relay as the shark, one
      // message per mob index. Nothing stored — late joiners catch the next
      // tick.
      const i = Number(msg.i)
      const x = Number(msg.x)
      const z = Number(msg.z)
      const ry = Number(msg.ry)
      const hp = Number(msg.hp)
      if (![i, x, z, ry, hp].every(Number.isFinite)) return
      this.broadcast(
        JSON.stringify({
          t: 'mob',
          i: Math.max(0, Math.min(7, Math.floor(i))),
          x,
          z,
          ry,
          hp,
          st: String(msg.st).slice(0, 8),
        }),
        ws,
      )
    } else if (msg.t === 'mobhit') {
      const i = Number(msg.i)
      const dmg = Number(msg.dmg)
      if (!Number.isFinite(i) || !Number.isFinite(dmg)) return
      this.broadcast(
        JSON.stringify({
          t: 'mobhit',
          i: Math.max(0, Math.min(7, Math.floor(i))),
          dmg: Math.max(0, Math.min(200, dmg)),
        }),
        ws,
      )
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
    this.faces.delete(att.id)
    // Anyone in their arms sits back down where they were picked up. Clients
    // do exactly the same on `leave`, so nobody diverges.
    for (const m of this.meck.values()) if (m.by === att.id) m.by = ''
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
    if (name) row.name = name
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
