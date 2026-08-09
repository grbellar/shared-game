import * as THREE from 'three'
import {
  BLOCK,
  GRID_XZ_MAX,
  GY_MAX,
  MATERIALS,
  blockAt,
  breakBlock,
  cellCenter,
  findPlacementGy,
  placeBlock,
  resetBlocks,
  type BlockSpec,
  type BrokenCell,
} from './blocks'
import type { Effects } from './effects'
import type { Net } from './net'
import { sfx } from './audio'

// Block building orchestration: turns clicks into synced placements and
// weapon hits into synced breaks. Like Destruction, this is the only module
// that talks to blocks + effects + net together.

const PLACE_REACH = 2.2 // fixed forward offset, matching how the shovel aims
const OVERHEAD_CAP = 4.6 // can't start a block more than ~1.5 cells over your head
const BLAST_RADIUS = 3.2

// What the builder is aiming at right now: the cell a place would fill and
// the block a break would take out (the top of the same column, which is the
// cell directly under the placement — that's what makes the two previews
// stack readably). `valid` is false when the placement itself is blocked but
// the column is still worth drawing a ghost for.
export interface BuildAim {
  gx: number
  gy: number
  gz: number
  valid: boolean
  breakGy: number | null
}

export class Building {
  // Distance falloff for remote sounds; main.ts wires this to distVol.
  volumeAt: (pos: THREE.Vector3) => number = () => 1
  // A dead block drops where it stood, as one loose voxel anyone can eat.
  // Fires for our own breaks and relayed ones alike, so the rubble is on every
  // screen — see pickups.ts.
  onBreak: (gx: number, gy: number, gz: number, m: number, at: THREE.Vector3) => void = () => {}
  // A cell got a fresh block, ours or relayed. main.ts unclaims the cell's
  // rubble key on this — placements are already synced, so every client
  // forgets the old claim together and the rebuilt block can spill again.
  onPlace: (gx: number, gy: number, gz: number) => void = () => {}

  constructor(
    private effects: Effects,
    private net: Net,
  ) {}

  // Single source of truth for where the builder points — the preview ghost
  // and the click that follows it both resolve through here, so what you see
  // is exactly what you get. Null = off the grid entirely, nothing to draw.
  aim(pos: THREE.Vector3, ry: number, aimed: { x: number; z: number } | null): BuildAim | null {
    const tx = aimed ? aimed.x : pos.x + Math.sin(ry) * PLACE_REACH
    const tz = aimed ? aimed.z : pos.z + Math.cos(ry) * PLACE_REACH
    const gx = Math.round(tx / BLOCK)
    const gz = Math.round(tz / BLOCK)
    if (Math.abs(gx) > GRID_XZ_MAX || Math.abs(gz) > GRID_XZ_MAX) return null
    // Search from the builder's own feet, not just the terrain: standing on a
    // castle rampart should build on the rampart rather than hunting for the
    // first arrow slit forty cells below.
    const gy = findPlacementGy(gx, gz, Math.floor(pos.y / BLOCK))
    const valid = gy <= GY_MAX && gy * BLOCK <= pos.y + OVERHEAD_CAP && !blockAt(gx, gy, gz)
    // You can always pry off what you could have stacked: same overhead cap,
    // one cell down. Nothing to break in a column that's still bare ground.
    const below = gy - 1
    const reachable = below * BLOCK <= pos.y + OVERHEAD_CAP && !!blockAt(gx, below, gz)
    return { gx, gy, gz, valid, breakGy: reachable ? below : null }
  }

  // Place the current material into the column in front of the player (or
  // under the first-person crosshair's ground point). False = whiffed click:
  // out of range, column full, or the cell is taken.
  place(pos: THREE.Vector3, ry: number, m: number, aimed: { x: number; z: number } | null): boolean {
    const at = this.aim(pos, ry, aimed)
    if (!at || !at.valid) return false
    if (!placeBlock({ gx: at.gx, gy: at.gy, gz: at.gz, m })) return false
    sfx.land(0.5)
    this.net.sendBlockPlace(at.gx, at.gy, at.gz, m)
    this.onPlace(at.gx, at.gy, at.gz)
    return true
  }

  // Right-click with the builder: pop the block out.
  breakAt(pos: THREE.Vector3, ry: number, aimed: { x: number; z: number } | null): boolean {
    const at = this.aim(pos, ry, aimed)
    if (!at || at.breakGy === null) return false
    if (!blockAt(at.gx, at.breakGy, at.gz)) return false
    this.breakCell(at.gx, at.breakGy, at.gz)
    return true
  }

  // Owner-minted break from our own weapons; everyone else learns over the
  // wire. A no-op on an empty cell, which is what makes a relayed break safe
  // to apply twice.
  breakCell(gx: number, gy: number, gz: number): void {
    if (!this.applyBreak(gx, gy, gz, 1)) return
    this.net.sendBlockHit(gx, gy, gz)
  }

  // Our own rocket went off. Each block inside it rides its own bhit, reusing
  // the single code path.
  blast(center: THREE.Vector3): void {
    const cgx = Math.round(center.x / BLOCK)
    const cgy = Math.floor(center.y / BLOCK)
    const cgz = Math.round(center.z / BLOCK)
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dz = -2; dz <= 2; dz++) {
          const gx = cgx + dx
          const gy = cgy + dy
          const gz = cgz + dz
          if (!blockAt(gx, gy, gz)) continue
          if (cellCenter(gx, gy, gz).distanceTo(center) > BLAST_RADIUS) continue
          this.breakCell(gx, gy, gz)
        }
      }
    }
  }

  applyRemotePlace(gx: number, gy: number, gz: number, m: number): void {
    if (m < 0 || m >= MATERIALS.length) return
    if (!placeBlock({ gx, gy, gz, m })) return
    sfx.land(0.4 * this.volumeAt(cellCenter(gx, gy, gz)))
    this.onPlace(gx, gy, gz)
  }

  applyRemoteBreak(gx: number, gy: number, gz: number): void {
    this.applyBreak(gx, gy, gz, this.volumeAt(cellCenter(gx, gy, gz)))
  }

  // Welcome snapshot: full reset, silent — no debris storm for late joiners.
  // The castle isn't in the snapshot (every client generates it); what the
  // room replays is the damage done to it, which re-breaks it identically.
  replay(specs: BlockSpec[], broken: BrokenCell[]): void {
    resetBlocks(specs, broken)
  }

  private applyBreak(gx: number, gy: number, gz: number, vol: number): boolean {
    const result = breakBlock(gx, gy, gz)
    if (!result) return false
    sfx.crunch(0.9 * vol)
    this.effects.spawnDebris(result.center, MATERIALS[result.m].debris, 10, 7)
    this.onBreak(gx, gy, gz, result.m, result.center)
    return true
  }
}
