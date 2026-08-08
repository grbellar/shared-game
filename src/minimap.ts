import * as THREE from 'three'
import { heightAt, terrainVersion } from './world'
import { LIFETIME_MS as TALK_MS } from './bubbles'
import type { Player } from './player'
import type { Remotes } from './remotes'
import type { Settings } from './settings'

// Top-down radar in the corner: the whole island, north-up, with a blip per
// player. Drawn on a deliberately tiny canvas and upscaled with
// nearest-neighbour, same trick as the main view — the chunk is the look.
//
// The island layer is baked once into an offscreen canvas and only re-baked
// when the terrain actually changes (craters), so per-frame work is just a
// blit plus a handful of rectangles.

const SIZE = 72 // internal pixels
const ZOOM = 2 // CSS upscale — integer, or nearest-neighbour goes lumpy
const HALF = 94 // world units from map centre to map edge — the shoreline plus a little sea
const SCALE = SIZE / (HALF * 2) // pixels per world unit
const CELL = 1 / SCALE // world units per pixel

const PING_MS = 850 // one expanding ring per beat while someone's talking
// Mic level that counts as speech rather than room noise. voice.ts already
// smooths the level (fast attack, slow release), so this needn't hysteresis.
const VOICE_FLOOR = 0.06
const ME = 'me' // local player's key - server ids are 8-char uuid slices, so this can't clash

const DEEP = [0x2a, 0x4e, 0x86]
const WATER = [0x3f, 0x76, 0xc9]
const SAND = [0xd8, 0xc4, 0x7a]
const GRASS = [0x4f, 0x9e, 0x3f]
const ROCK = [0x8a, 0x8a, 0x92]

function mapX(x: number): number {
  return SIZE / 2 + x * SCALE
}

function mapY(z: number): number {
  return SIZE / 2 + z * SCALE
}

export class Minimap {
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private island = document.createElement('canvas')
  private islandCtx: CanvasRenderingContext2D
  private bakedVersion = -1
  private visible = true
  // Who has a chat bubble up right now: id -> when it stops showing.
  private talking = new Map<string, number>()
  // Who is on the mic right now: id -> when this burst of speech started.
  private speaking = new Map<string, number>()

  constructor(
    touch: boolean,
    private color: string,
  ) {
    this.canvas.id = 'minimap'
    this.canvas.width = SIZE
    this.canvas.height = SIZE
    this.island.width = SIZE
    this.island.height = SIZE
    this.ctx = this.canvas.getContext('2d')!
    this.islandCtx = this.island.getContext('2d')!
    this.ctx.imageSmoothingEnabled = false

    const style = document.createElement('style')
    style.textContent = `
      #minimap {
        position: fixed;
        right: calc(env(safe-area-inset-right) + 12px);
        ${
          // The touch build owns the bottom-right corner with its jump/fire
          // buttons, so the map moves up under the chat + gear buttons.
          // Desktop clears the two-line hint strip along the bottom.
          touch
            ? 'top: calc(env(safe-area-inset-top) + 44px);'
            : 'bottom: calc(env(safe-area-inset-bottom) + 48px);'
        }
        width: ${SIZE * ZOOM}px;
        height: ${SIZE * ZOOM}px;
        background: rgba(0, 0, 0, 0.55);
        border: 2px solid rgba(255, 255, 255, 0.28);
        image-rendering: pixelated;
        pointer-events: none;
      }
    `
    document.head.appendChild(style)
    document.body.appendChild(this.canvas)
  }

  update(player: Player, remotes: Remotes, settings: Settings, myVoice: number): void {
    if (settings.minimap !== this.visible) {
      this.visible = settings.minimap
      this.canvas.style.display = this.visible ? '' : 'none'
    }
    if (!this.visible) return

    if (this.bakedVersion !== terrainVersion()) {
      this.bakedVersion = terrainVersion()
      this.bakeIsland()
    }

    const ctx = this.ctx
    ctx.clearRect(0, 0, SIZE, SIZE)
    ctx.drawImage(this.island, 0, 0)

    const now = performance.now()
    for (const { id, pos, color, talk } of remotes.blips()) {
      this.blip(pos, color, this.talkAge(id, now, talk))
    }
    const mine = this.place(player.group.position)
    // Your wedge is already white-outlined to set it apart from the blips, so
    // the ping alone marks you as talking.
    this.ping(mine.x, mine.y, this.talkAge(ME, now, myVoice))
    this.arrow(mine.x, mine.y, player.group.rotation.y, this.color)
  }

  // Someone sent a chat message: ping their blip until the bubble pops. Voice
  // needs no equivalent — it's a live level read straight off the state
  // stream, so speech pings on its own.
  talk(id: string): void {
    this.talking.set(id, performance.now() + TALK_MS)
  }

  // You sent a chat message.
  talkLocal(): void {
    this.talk(ME)
  }

  // How far into their turn to talk this player is, or null if they're quiet.
  // Voice wins when the mic is live: the ping tracks the moment speech
  // started, so the rings keep beating for as long as they hold the floor.
  private talkAge(id: string, now: number, voice: number): number | null {
    if (voice > VOICE_FLOOR) {
      const since = this.speaking.get(id) ?? now
      this.speaking.set(id, since)
      return now - since
    }
    this.speaking.delete(id)
    const until = this.talking.get(id)
    if (until === undefined) return null
    if (until <= now) {
      this.talking.delete(id)
      return null
    }
    return TALK_MS - (until - now)
  }

  // Where a world position sits on the map. Anyone past the edge (swimming
  // for the horizon) gets pinned to the rim rather than vanishing.
  private place(pos: THREE.Vector3): { x: number; y: number; off: boolean } {
    const x = mapX(pos.x)
    const y = mapY(pos.z)
    return {
      x: Math.round(Math.min(SIZE - 3, Math.max(3, x))),
      y: Math.round(Math.min(SIZE - 3, Math.max(3, y))),
      off: x < 3 || x > SIZE - 3 || y < 3 || y > SIZE - 3,
    }
  }

  // A remote player: a fat pixel in their character colour, outlined so it
  // reads against sand as well as grass. Talkers get a white outline on top
  // of the ping, so you can still tell who's chatting between beats.
  private blip(pos: THREE.Vector3, color: string, talkAge: number | null): void {
    const { x, y, off } = this.place(pos)
    this.ping(x, y, talkAge)
    const s = off ? 2 : 4
    const ctx = this.ctx
    ctx.globalAlpha = off ? 0.6 : 1
    ctx.fillStyle = talkAge === null ? '#000' : '#fff'
    ctx.fillRect(x - s / 2 - 1, y - s / 2 - 1, s + 2, s + 2)
    ctx.fillStyle = color
    ctx.fillRect(x - s / 2, y - s / 2, s, s)
    ctx.globalAlpha = 1
  }

  // The talking indicator: a square ring shoving off the blip once a beat and
  // fading as it grows. Square rather than round because at 72 pixels across
  // a circle is just a bumpy square anyway.
  private ping(x: number, y: number, age: number | null): void {
    if (age === null) return
    const phase = (age % PING_MS) / PING_MS
    const r = Math.round(3 + phase * 7)
    const ctx = this.ctx
    ctx.globalAlpha = 1 - phase
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1
    // Half-pixel offset keeps the 1px stroke on a single row of pixels.
    ctx.strokeRect(x - r + 0.5, y - r + 0.5, r * 2, r * 2)
    ctx.globalAlpha = 1
  }

  // You: a wedge pointing where you're facing. Forward in world space is
  // (sin ry, cos ry), which on a north-up map is (right, down) — hence the
  // PI - ry to swing the wedge's default up-vector onto it.
  private arrow(x: number, y: number, ry: number, color: string): void {
    const ctx = this.ctx
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(Math.PI - ry)
    ctx.beginPath()
    ctx.moveTo(0, -4.5)
    ctx.lineTo(3.5, 3.5)
    ctx.lineTo(0, 1.5)
    ctx.lineTo(-3.5, 3.5)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = '#fff'
    ctx.stroke()
    ctx.restore()
  }

  // Paint the island from the same heightAt the game stands on, so craters
  // and dug-out ponds show up on the map. Heights are sampled one row at a
  // time and the next column's sample doubles as the east neighbour for a
  // cheap hillshade.
  private bakeIsland(): void {
    const img = this.islandCtx.createImageData(SIZE, SIZE)
    const row = new Float32Array(SIZE + 1)
    for (let py = 0; py < SIZE; py++) {
      const z = (py + 0.5 - SIZE / 2) * CELL
      for (let i = 0; i <= SIZE; i++) row[i] = heightAt((i + 0.5 - SIZE / 2) * CELL, z)
      for (let px = 0; px < SIZE; px++) {
        const h = row[px]
        let c: number[]
        let shade = 1
        if (h < 0) {
          c = h < -3 ? DEEP : WATER
        } else {
          c = h < 1 ? SAND : h < 10.5 ? GRASS : ROCK
          // Slopes falling away to the east catch the light, ones rising
          // into it go dark. Fake, but it makes the shape readable.
          shade = 1 + Math.max(-0.4, Math.min(0.4, (h - row[px + 1]) * 0.22))
        }
        const o = (py * SIZE + px) * 4
        img.data[o] = Math.min(255, c[0] * shade)
        img.data[o + 1] = Math.min(255, c[1] * shade)
        img.data[o + 2] = Math.min(255, c[2] * shade)
        img.data[o + 3] = 255
      }
    }
    this.islandCtx.putImageData(img, 0, 0)
  }
}
