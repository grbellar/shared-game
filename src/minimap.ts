import * as THREE from 'three'
import { heightAt, terrainVersion } from './world'
import { REALM_X, REALM_Z, inRealm } from './realm'
import { WICHITA_X, WICHITA_Z, inWichita, inOldTown } from './wichita'
import { OZ_X, OZ_Z, inOz } from './oz'
import { BUILDINGS, ROADS } from './wichita-data'
import { BLOCK, MATERIALS, blocksVersion, forEachBlock } from './blocks'
import { LIFETIME_MS as TALK_MS } from './bubbles'
import type { Player } from './player'
import type { Remotes } from './remotes'
import type { Settings } from './settings'
import type { Skeletons } from './skeletons'

// Top-down radar in the corner, north-up, with a blip per player. Drawn on a
// deliberately tiny canvas and upscaled with nearest-neighbour, same trick as
// the main view — the chunk is the look.
//
// There are three maps: the island, the shadow realm with the castle drawn
// on it, and downtown Wichita with its real streets and footprints. Which
// one you get follows where you are. All are baked into an offscreen canvas
// and only re-baked when something actually changes — the terrain (craters),
// the realm's blocks, or (Wichita being far bigger than one frame) you
// wandering out of the baked neighbourhood — so per-frame work is a blit
// plus a handful of rectangles.

const SIZE = 72 // internal pixels
const ZOOM = 2 // CSS upscale — integer, or nearest-neighbour goes lumpy
// World units from map centre to map edge. The realm zooms in: the castle is
// only ~67 units across, and at the island's scale it would be a smudge.
const HALF_ISLAND = 94 // the shoreline plus a little sea
const HALF_REALM = 62 // the castle, its apron, and the top of the road
const HALF_CITY = 110 // a few Wichita blocks around you — the radar scrolls
const HALF_OZ = 160 // the whole meadow, shore to shore
// The city radar re-centres on you in steps this big, so the bake cache
// still works: cross a cell, get a fresh neighbourhood.
const CITY_SNAP = 24
// Re-baking the castle layer sweeps every block, so cap how often a siege can
// trigger it. A tenth of a second is well under one frame of visible lag.
const REBAKE_MS = 120

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
// Shadow realm: lava, scorched rim, basalt plateau, high ground.
const LAVA = [0xc4, 0x4a, 0x16]
const SCORCH = [0x6d, 0x34, 0x1c]
const BASALT = [0x4a, 0x40, 0x5c]
const HIGH = [0x38, 0x2e, 0x48]
// Wichita: the concrete slab; streets and footprints go on as vectors.
const CONCRETE = [0xb9, 0xb2, 0xa4]

type MapMode = 'island' | 'realm' | 'city' | 'oz'

function modeAt(x: number, z: number): MapMode {
  return inRealm(x, z) ? 'realm' : inWichita(x, z) ? 'city' : inOz(x, z) ? 'oz' : 'island'
}

export class Minimap {
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private island = document.createElement('canvas')
  private islandCtx: CanvasRenderingContext2D
  private visible = true
  // Which map is baked, from where, and what it was baked from.
  private bakedMode: MapMode | null = null
  private bakedCx = 0
  private bakedCz = 0
  private bakedTerrain = -1
  private bakedBlocks = -1
  private lastBake = 0
  // Map framing, swapped when you cross over.
  private half = HALF_ISLAND
  private cx = 0
  private cz = 0
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

  update(
    player: Player,
    remotes: Remotes,
    settings: Settings,
    myVoice: number,
    skeletons?: Skeletons,
  ): void {
    if (settings.minimap !== this.visible) {
      this.visible = settings.minimap
      this.canvas.style.display = this.visible ? '' : 'none'
    }
    if (!this.visible) return

    // Three maps, one canvas: which one you get follows which world you're
    // in. The island and the realm are small enough to frame whole; Wichita
    // is a radar that re-centres on you in CITY_SNAP steps.
    const p = player.group.position
    const mode = modeAt(p.x, p.z)
    this.half =
      mode === 'realm' ? HALF_REALM : mode === 'city' ? HALF_CITY : mode === 'oz' ? HALF_OZ : HALF_ISLAND
    this.cx =
      mode === 'realm' ? REALM_X : mode === 'city' ? Math.round(p.x / CITY_SNAP) * CITY_SNAP : mode === 'oz' ? OZ_X : 0
    this.cz =
      mode === 'realm' ? REALM_Z : mode === 'city' ? Math.round(p.z / CITY_SNAP) * CITY_SNAP : mode === 'oz' ? OZ_Z : 0
    const now = performance.now()
    // Terrain rebakes ride the same throttle as blocks: craters land in
    // bursts too (the fifty), and each bake sweeps thousands of heightAt
    // samples. Crossing worlds still swaps the map immediately.
    const stale =
      mode !== this.bakedMode ||
      this.cx !== this.bakedCx ||
      this.cz !== this.bakedCz ||
      ((terrainVersion() !== this.bakedTerrain ||
        (mode === 'realm' && blocksVersion() !== this.bakedBlocks)) &&
        now - this.lastBake > REBAKE_MS)
    if (stale) {
      this.bakedMode = mode
      this.bakedCx = this.cx
      this.bakedCz = this.cz
      this.bakedTerrain = terrainVersion()
      this.bakedBlocks = blocksVersion()
      this.lastBake = now
      this.bake(mode)
    }

    const ctx = this.ctx
    ctx.clearRect(0, 0, SIZE, SIZE)
    ctx.drawImage(this.island, 0, 0)

    // Only people in the same world as you — the other lot are through a
    // portal (or five fog walls west), not just off the edge of the picture.
    for (const { id, pos, color, talk } of remotes.blips()) {
      if (modeAt(pos.x, pos.z) !== mode) continue
      this.blip(pos, color, this.talkAge(id, now, talk))
    }
    if (mode === 'realm' && skeletons) {
      for (const s of skeletons.blips()) this.bones(s.x, s.z, s.hunting)
    }
    const mine = this.place(player.group.position)
    // Your wedge is already white-outlined to set it apart from the blips, so
    // the ping alone marks you as talking.
    this.ping(mine.x, mine.y, this.talkAge(ME, now, myVoice))
    this.arrow(mine.x, mine.y, player.group.rotation.y, this.color)
  }

  private get scale(): number {
    return SIZE / (this.half * 2)
  }

  private mapX(x: number): number {
    return SIZE / 2 + (x - this.cx) * this.scale
  }

  private mapY(z: number): number {
    return SIZE / 2 + (z - this.cz) * this.scale
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
    const x = this.mapX(pos.x)
    const y = this.mapY(pos.z)
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

  // Paint the ground from the same heightAt the game stands on, so craters and
  // dug-out ponds show up on the map. Heights are sampled one row at a time
  // and the next column's sample doubles as the east neighbour for a cheap
  // hillshade. In the realm the castle goes on top, drawn from the live block
  // grid — so the map falls down as the walls do.
  private bake(mode: MapMode): void {
    const img = this.islandCtx.createImageData(SIZE, SIZE)
    const cell = 1 / this.scale
    const row = new Float32Array(SIZE + 1)
    for (let py = 0; py < SIZE; py++) {
      const z = this.cz + (py + 0.5 - SIZE / 2) * cell
      for (let i = 0; i <= SIZE; i++) {
        row[i] = heightAt(this.cx + (i + 0.5 - SIZE / 2) * cell, z)
      }
      for (let px = 0; px < SIZE; px++) {
        const h = row[px]
        let c: number[]
        let shade = 1
        if (mode === 'realm') {
          // The realm's "sea" is molten and its ground starts at REALM_GROUND.
          if (h < 0) c = LAVA
          else if (h < 3) c = SCORCH
          else c = h > 8 ? HIGH : BASALT
          if (h >= 0) shade = 1 + Math.max(-0.4, Math.min(0.4, (h - row[px + 1]) * 0.22))
        } else if (h < 0) {
          // Water is water in both remaining worlds — the river cuts through
          // downtown at the same depths the island sea uses.
          c = h < -3 ? DEEP : WATER
        } else if (mode === 'city') {
          c = CONCRETE
          // Flat slab, so the only relief worth shading is crater damage.
          shade = 1 + Math.max(-0.4, Math.min(0.4, (h - row[px + 1]) * 0.22))
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
    if (mode === 'realm') this.bakeCastle(img)
    this.islandCtx.putImageData(img, 0, 0)
    if (mode === 'city') this.bakeCity()
  }

  // Streets and footprints over the slab, drawn as vectors on the baked
  // canvas — putImageData first, paths after, and the canvas clips whatever
  // falls outside the frame. ~1600 paths per bake, and a bake happens only
  // when you cross into a fresh CITY_SNAP cell.
  private bakeCity(): void {
    const ctx = this.islandCtx
    const lx = (x: number) => this.mapX(WICHITA_X + x)
    const lz = (z: number) => this.mapY(WICHITA_Z + z)
    const view = this.half + 60 // skip geometry nowhere near the frame
    ctx.strokeStyle = '#54545c'
    ctx.lineCap = 'round'
    for (const r of ROADS) {
      if (r.w < 6) continue
      if (!this.nearCity(r.p, view)) continue
      ctx.lineWidth = Math.max(1, r.w * this.scale)
      ctx.beginPath()
      for (let i = 0; i + 1 < r.p.length; i += 2) {
        if (i === 0) ctx.moveTo(lx(r.p[i]), lz(r.p[i + 1]))
        else ctx.lineTo(lx(r.p[i]), lz(r.p[i + 1]))
      }
      ctx.stroke()
    }
    for (const b of BUILDINGS) {
      if (!this.nearCity(b.p, view)) continue
      let cx = 0
      let cz = 0
      ctx.beginPath()
      for (let i = 0; i < b.p.length; i += 2) {
        cx += b.p[i]
        cz += b.p[i + 1]
        if (i === 0) ctx.moveTo(lx(b.p[i]), lz(b.p[i + 1]))
        else ctx.lineTo(lx(b.p[i]), lz(b.p[i + 1]))
      }
      ctx.closePath()
      const n = b.p.length / 2
      ctx.fillStyle = inOldTown(cx / n, cz / n) ? '#8f4630' : '#7a6e60'
      ctx.fill()
    }
  }

  // Does this local-coord polyline come near the framed neighbourhood?
  // Checked as the whole path's bounding box, not vertex by vertex — a long
  // straight avenue can cross the frame with both endpoints far outside it,
  // and Douglas vanishing from its own radar would be embarrassing.
  private nearCity(p: number[], view: number): boolean {
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (let i = 0; i < p.length; i += 2) {
      minX = Math.min(minX, p[i])
      maxX = Math.max(maxX, p[i])
      minZ = Math.min(minZ, p[i + 1])
      maxZ = Math.max(maxZ, p[i + 1])
    }
    const cx = this.cx - WICHITA_X
    const cz = this.cz - WICHITA_Z
    return minX < cx + view && maxX > cx - view && minZ < cz + view && maxZ > cz - view
  }

  // Every standing block, flattened to a plan view: keep the highest one per
  // pixel and tint by material, lighter the taller it stands. One sweep of the
  // grid (~4k) rather than a per-pixel column scan.
  private bakeCastle(img: ImageData): void {
    const top = new Int16Array(SIZE * SIZE).fill(-999)
    const mat = new Int8Array(SIZE * SIZE)
    forEachBlock((spec) => {
      const px = Math.floor(this.mapX(spec.gx * BLOCK))
      const py = Math.floor(this.mapY(spec.gz * BLOCK))
      if (px < 0 || px >= SIZE || py < 0 || py >= SIZE) return
      const i = py * SIZE + px
      if (spec.gy <= top[i]) return
      top[i] = spec.gy
      mat[i] = spec.m
    })
    for (let i = 0; i < top.length; i++) {
      if (top[i] === -999) continue
      const base = MATERIALS[mat[i]].debris
      // Taller courses read brighter, which turns the flat plan into towers.
      const lift = 0.62 + Math.min(0.55, Math.max(0, top[i] - 4) * 0.045)
      const o = i * 4
      img.data[o] = Math.min(255, ((base >> 16) & 255) * lift)
      img.data[o + 1] = Math.min(255, ((base >> 8) & 255) * lift)
      img.data[o + 2] = Math.min(255, (base & 255) * lift)
    }
  }

  // A skeleton: a small bone-white pip, red-ringed when it has seen someone.
  private bones(x: number, z: number, hunting: boolean): void {
    const px = Math.round(this.mapX(x))
    const py = Math.round(this.mapY(z))
    if (px < 1 || px > SIZE - 2 || py < 1 || py > SIZE - 2) return
    const ctx = this.ctx
    ctx.fillStyle = hunting ? '#e0392b' : '#151015'
    ctx.fillRect(px - 2, py - 2, 4, 4)
    ctx.fillStyle = '#e8e2ca'
    ctx.fillRect(px - 1, py - 1, 2, 2)
  }
}
