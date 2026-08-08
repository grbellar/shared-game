// Keep the message types in sync with server/room.ts

import type { Pose } from './character'
import type { Crater } from './world'
import type { BlockSpec, WorldDamage } from './blocks'
import type { SharkNetState } from './shark'
import type { MobNetState } from './mobs'

export interface PlayerState {
  id: string
  x: number
  y: number
  z: number
  ry: number
  // Pitch and roll. Zero for anything on its feet — they exist for the
  // X-wing (see xwing.ts), which banks and dives, and a fighter that stays
  // bolt upright on everyone else's screen doesn't look like it's flying.
  rx: number
  rz: number
  color: string
  name: string
  pose: Pose
  weapon: string // 'none' | 'gun' | 'sword' | 'shovel' | 'firework'
  ride: string // 'none' | 'wheelchair' | 'ramsey' | 'xwing'
  skin: string // skin id from skins.ts; 'none' is the base look
  talk: number // 0..1 mic level, drives the mouth on remote screens
  emote: string // 'none' or an id from src/emotes.ts
  hp: number // head pitch, up-positive radians
  hy: number // head yaw, offset from the body's facing
}

export interface Face {
  id: string
  d: string
}

type ServerMsg =
  | {
      t: 'welcome'
      id: string
      players: PlayerState[]
      craters?: Crater[]
      blocks?: BlockSpec[]
      // Damage done to world-generated blocks (the castle), which the room
      // remembers even though it never stored the blocks themselves.
      wdmg?: WorldDamage[]
      clock?: { hours: number; running: boolean }
      faces?: Face[]
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
  | { t: 'laser'; id: string; x: number; y: number; z: number; dx: number; dy: number; dz: number }
  | { t: 'bplace'; gx: number; gy: number; gz: number; m: number }
  | { t: 'bhit'; gx: number; gy: number; gz: number; dmg: number }
  | { t: 'pet'; id: string; cat: number }
  | { t: 'fw'; id: string; x: number; z: number; c: number }
  | { t: 'fwgo'; id: string }
  | { t: 'face'; id: string; d: string }
  | { t: 'shark'; x: number; z: number; ry: number; hp: number; st: string; grab: string }
  | { t: 'sharkhit'; dmg: number }
  | { t: 'land'; id: string; x: number; y: number; z: number }
  | { t: 'mob'; i: number; x: number; z: number; ry: number; hp: number; st: string }
  | { t: 'mobhit'; i: number; dmg: number }
  | { t: 'skel'; s: number[] }
  | { t: 'skelhit'; i: number; dmg: number }

export class Net {
  id: string | null = null
  onWelcome: (
    players: PlayerState[],
    craters: Crater[],
    blocks: BlockSpec[],
    worldDamage: WorldDamage[],
    faces: Face[],
  ) => void = () => {}
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
  // A pair of X-wing cannon bolts. Everyone simulates them; only the shooter
  // works out what they hit (see lasers.ts).
  onLaser: (id: string, origin: [number, number, number], dir: [number, number, number]) => void =
    () => {}
  onClock: (hours: number, running: boolean) => void = () => {}
  onBlockPlace: (gx: number, gy: number, gz: number, m: number) => void = () => {}
  onBlockHit: (gx: number, gy: number, gz: number, dmg: number) => void = () => {}
  onPet: (cat: number) => void = () => {}
  onFirework: (id: string, x: number, z: number, c: number) => void = () => {}
  onFireworkLaunch: (id: string) => void = () => {}
  onFace: (id: string, dataUrl: string) => void = () => {}
  onShark: (s: SharkNetState) => void = () => {}
  onSharkHit: (dmg: number) => void = () => {}
  // Somebody's rocket trip touching down near us.
  onLand: (id: string, pos: [number, number, number]) => void = () => {}
  onMob: (s: MobNetState) => void = () => {}
  onMobHit: (i: number, dmg: number) => void = () => {}
  // The castle garrison, packed five numbers per skeleton (see skeletons.ts).
  // Its own message rather than `mob`: the whole roster rides in one array,
  // where land mobs stream one at a time.
  onSkeletons: (packed: number[]) => void = () => {}
  onSkeletonHit: (index: number, dmg: number) => void = () => {}
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
        this.onWelcome(
          msg.players,
          msg.craters ?? [],
          msg.blocks ?? [],
          msg.wdmg ?? [],
          msg.faces ?? [],
        )
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
      } else if (msg.t === 'laser') {
        if (msg.id !== this.id) this.onLaser(msg.id, [msg.x, msg.y, msg.z], [msg.dx, msg.dy, msg.dz])
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
      } else if (msg.t === 'face') {
        if (msg.id !== this.id) this.onFace(msg.id, msg.d)
      } else if (msg.t === 'shark') {
        const st = msg.st
        this.onShark({
          x: msg.x,
          z: msg.z,
          ry: msg.ry,
          hp: msg.hp,
          st: st === 'hunt' || st === 'grab' || st === 'dead' || st === 'land' ? st : 'patrol',
          grab: msg.grab,
        })
      } else if (msg.t === 'sharkhit') {
        this.onSharkHit(msg.dmg)
      } else if (msg.t === 'skel') {
        if (Array.isArray(msg.s)) this.onSkeletons(msg.s)
      } else if (msg.t === 'skelhit') {
        this.onSkeletonHit(msg.i, msg.dmg)
      } else if (msg.t === 'land') {
        if (msg.id !== this.id) this.onLand(msg.id, [msg.x, msg.y, msg.z])
      } else if (msg.t === 'mob') {
        const st = msg.st
        this.onMob({
          i: msg.i,
          x: msg.x,
          z: msg.z,
          ry: msg.ry,
          hp: msg.hp,
          st: st === 'chase' || st === 'dead' ? st : 'wander',
        })
      } else if (msg.t === 'mobhit') {
        this.onMobHit(msg.i, msg.dmg)
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

  // One trigger pull of the X-wing's cannons. The four bolts are fanned out
  // from this single origin/direction by lasers.ts on every client, so a
  // burst costs one message rather than four.
  sendLaser(
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
  ): void {
    if (!this.connected) return
    this.ws!.send(
      JSON.stringify({ t: 'laser', x: origin.x, y: origin.y, z: origin.z, dx: dir.x, dy: dir.y, dz: dir.z }),
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

  // Only the shark's host client sends this (see shark.ts).
  sendShark(s: SharkNetState): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'shark', ...s }))
  }

  sendSharkHit(dmg: number): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'sharkhit', dmg }))
  }

  // Host-only: the whole garrison in one packed array, ~10x/sec.
  sendSkeletons(packed: number[]): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'skel', s: packed }))
  }

  sendSkeletonHit(index: number, dmg: number): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'skelhit', i: index, dmg }))
  }

  // Rocket travel touching down. The flight itself needs no message — the
  // position stream and the pose in `state` already carry it — but the impact
  // has to land on the same frame for everyone, so it gets its own.
  sendLand(pos: { x: number; y: number; z: number }): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'land', x: pos.x, y: pos.y, z: pos.z }))
  }

  // Only the mob host client sends this (see mobs.ts).
  sendMob(s: MobNetState): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'mob', ...s }))
  }

  sendMobHit(i: number, dmg: number): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'mobhit', i, dmg }))
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

  // A 64px webcam frame as a JPEG data URL, or '' to drop back to a blocky
  // face. Sent ~5x/sec while the setting is on; see webcam.ts.
  sendFace(dataUrl: string): void {
    if (!this.connected) return
    this.ws!.send(JSON.stringify({ t: 'face', d: dataUrl }))
  }
}
