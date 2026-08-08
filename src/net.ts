// Keep the message types in sync with server/room.ts

import type { Pose } from './character'
import type { Crater } from './world'
import type { BlockSpec } from './blocks'

export interface PlayerState {
  id: string
  x: number
  y: number
  z: number
  ry: number
  color: string
  name: string
  pose: Pose
  weapon: string // 'none' | 'gun' | 'sword' | 'shovel' | 'firework'
  ride: string // 'none' | 'wheelchair' | 'ramsey'
  skin: string // skin id from skins.ts; 'none' is the base look
  talk: number // 0..1 mic level, drives the mouth on remote screens
}

type ServerMsg =
  | {
      t: 'welcome'
      id: string
      players: PlayerState[]
      craters?: Crater[]
      blocks?: BlockSpec[]
      clock?: { hours: number; running: boolean }
    }
  | { t: 'clock'; hours: number; running: boolean }
  | { t: 'state'; p: PlayerState }
  | { t: 'leave'; id: string }
  | { t: 'chat'; id: string; name: string; text: string }
  | { t: 'fire'; id: string; x: number; y: number; z: number; dx: number; dy: number; dz: number }
  | { t: 'slash'; id: string }
  | { t: 'hit'; id: string; victim: string; dmg: number }
  | { t: 'kill'; victim: string }
  | { t: 'crater'; x: number; z: number; r: number; d: number }
  | { t: 'rtc'; from: string; data: unknown }
  | { t: 'arrow'; id: string; x: number; y: number; z: number; dx: number; dy: number; dz: number; p: number }
  | { t: 'bplace'; gx: number; gy: number; gz: number; m: number }
  | { t: 'bhit'; gx: number; gy: number; gz: number; dmg: number }
  | { t: 'pet'; id: string; cat: number }
  | { t: 'fw'; id: string; x: number; z: number; c: number }
  | { t: 'fwgo'; id: string }

export class Net {
  id: string | null = null
  onWelcome: (players: PlayerState[], craters: Crater[], blocks: BlockSpec[]) => void = () => {}
  onState: (p: PlayerState) => void = () => {}
  onLeave: (id: string) => void = () => {}
  onChat: (id: string, name: string, text: string) => void = () => {}
  onFire: (id: string, origin: [number, number, number], dir: [number, number, number]) => void =
    () => {}
  onSlash: (id: string) => void = () => {}
  // Only fires when the hit was aimed at us — you apply your own damage.
  onHit: (attacker: string, dmg: number) => void = () => {}
  onKill: (victim: string) => void = () => {}
  onCrater: (c: Crater) => void = () => {}
  onRtc: (from: string, data: unknown) => void = () => {}
  onArrow: (
    id: string,
    origin: [number, number, number],
    dir: [number, number, number],
    power: number,
  ) => void = () => {}
  onClock: (hours: number, running: boolean) => void = () => {}
  onBlockPlace: (gx: number, gy: number, gz: number, m: number) => void = () => {}
  onBlockHit: (gx: number, gy: number, gz: number, dmg: number) => void = () => {}
  onPet: (cat: number) => void = () => {}
  onFirework: (id: string, x: number, z: number, c: number) => void = () => {}
  onFireworkLaunch: (id: string) => void = () => {}
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
        this.onWelcome(msg.players, msg.craters ?? [], msg.blocks ?? [])
        if (msg.clock) this.onClock(msg.clock.hours, msg.clock.running)
      } else if (msg.t === 'clock') {
        // No self-echo check needed: the server never echoes to the sender.
        this.onClock(msg.hours, msg.running)
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
      } else if (msg.t === 'hit') {
        if (msg.victim === this.id) this.onHit(msg.id, msg.dmg)
      } else if (msg.t === 'kill') {
        this.onKill(msg.victim)
      } else if (msg.t === 'crater') {
        // No self-echo check needed: the server never echoes to the sender.
        this.onCrater({ x: msg.x, z: msg.z, r: msg.r, d: msg.d })
      } else if (msg.t === 'rtc') {
        // Voice-chat signaling, already targeted at us by the server.
        this.onRtc(msg.from, msg.data)
      } else if (msg.t === 'arrow') {
        if (msg.id !== this.id)
          this.onArrow(msg.id, [msg.x, msg.y, msg.z], [msg.dx, msg.dy, msg.dz], msg.p)
      } else if (msg.t === 'bplace') {
        this.onBlockPlace(msg.gx, msg.gy, msg.gz, msg.m)
      } else if (msg.t === 'bhit') {
        // Cap-eviction bhits DO come back to their own trigger (broadcast to
        // all) — safe, because damaging a missing block is a no-op.
        this.onBlockHit(msg.gx, msg.gy, msg.gz, msg.dmg)
      } else if (msg.t === 'pet') {
        if (msg.id !== this.id) this.onPet(msg.cat)
      } else if (msg.t === 'fw') {
        this.onFirework(msg.id, msg.x, msg.z, msg.c)
      } else if (msg.t === 'fwgo') {
        this.onFireworkLaunch(msg.id)
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

  sendHit(victim: string, dmg: number): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'hit', victim, dmg }))
  }

  sendKill(victim: string): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'kill', victim }))
  }

  sendCrater(c: Crater): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'crater', x: c.x, z: c.z, r: c.r, d: c.d }))
  }

  // Voice-chat signaling (offer/answer/ICE), relayed to one target peer.
  sendRtc(to: string, data: unknown): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'rtc', to, data }))
  }

  sendArrow(
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    power: number,
  ): void {
    if (!this.connected) return
    this.ws!.send(
      JSON.stringify({
        t: 'arrow',
        x: origin.x,
        y: origin.y,
        z: origin.z,
        dx: dir.x,
        dy: dir.y,
        dz: dir.z,
        p: power,
      }),
    )
  }

  sendClock(hours: number, running: boolean): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'clock', hours, running }))
  }

  sendBlockPlace(gx: number, gy: number, gz: number, m: number): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'bplace', gx, gy, gz, m }))
  }

  sendBlockHit(gx: number, gy: number, gz: number, dmg: number): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'bhit', gx, gy, gz, dmg }))
  }

  sendPet(cat: number): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'pet', cat }))
  }

  // Plant a firework at (x, z) with shell palette `c`. Ground height is
  // resolved per-client, so it isn't sent.
  sendFirework(x: number, z: number, c: number): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'fw', x, z, c }))
  }

  // Light every firework we have planted.
  sendFireworkLaunch(): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'fwgo' }))
  }
}
