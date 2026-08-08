import * as THREE from 'three'
import {
  BLOCK,
  GRID_XZ_MAX,
  GY_MAX,
  MATERIALS,
  blockAt,
  cellCenter,
  damageBlock,
  findPlacementGy,
  placeBlock,
  resetBlocks,
  type BlockSpec,
} from './blocks'
import type { Effects } from './effects'
import type { Net } from './net'
import { sfx } from './audio'

// Block building orchestration: turns clicks into synced placements and
// weapon hits into synced damage. Like Destruction, this is the only module
// that talks to blocks + effects + net together.

const PLACE_REACH = 2.2 // fixed forward offset, matching how the shovel aims
const OVERHEAD_CAP = 4.6 // can't start a block more than ~1.5 cells over your head
const BLAST_RADIUS = 3.2
const BLAST_DMG = 3

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
    const gy = findPlacementGy(gx, gz)
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
    if (!placeBlock({ gx: at.gx, gy: at.gy, gz: at.gz, m, hp: MATERIALS[m].hp })) return false
    sfx.land(0.5)
    this.net.sendBlockPlace(at.gx, at.gy, at.gz, m)
    return true
  }

  // Right-click with the builder: pop the block out whole, whatever it's made
  // of. The builder is the one tool that unbuilds — weapons still have to chew
  // through hp. Damage equal to remaining hp destroys it everywhere, and since
  // hp is a commutative sum of relayed dmg, a double-break is just a no-op.
  breakAt(pos: THREE.Vector3, ry: number, aimed: { x: number; z: number } | null): boolean {
    const at = this.aim(pos, ry, aimed)
    if (!at || at.breakGy === null) return false
    const spec = blockAt(at.gx, at.breakGy, at.gz)
    if (!spec) return false
    this.hit(at.gx, at.breakGy, at.gz, spec.hp)
    return true
  }

  // Owner-minted damage from our own weapons; everyone else learns over the
  // wire. No-op when there's no block at the cell.
  hit(gx: number, gy: number, gz: number, dmg: number): void {
    if (!this.applyDamage(gx, gy, gz, dmg, 1)) return
    this.net.sendBlockHit(gx, gy, gz, dmg)
  }

  // Our own rocket went off: chew through every block near the blast. Each
  // damaged cell rides its own bhit, reusing the single code path.
  blastDamage(center: THREE.Vector3): void {
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
          this.hit(gx, gy, gz, BLAST_DMG)
        }
      }
    }
  }

  applyRemotePlace(gx: number, gy: number, gz: number, m: number): void {
    if (m < 0 || m >= MATERIALS.length) return
    if (!placeBlock({ gx, gy, gz, m, hp: MATERIALS[m].hp })) return
    sfx.land(0.4 * this.volumeAt(cellCenter(gx, gy, gz)))
  }

  applyRemoteHit(gx: number, gy: number, gz: number, dmg: number): void {
    this.applyDamage(gx, gy, gz, dmg, this.volumeAt(cellCenter(gx, gy, gz)))
  }

  // Welcome snapshot: full reset, silent — no debris storm for late joiners.
  replay(specs: BlockSpec[]): void {
    resetBlocks(specs)
  }

  private applyDamage(gx: number, gy: number, gz: number, dmg: number, vol: number): boolean {
    const result = damageBlock(gx, gy, gz, dmg)
    if (!result) return false
    const color = MATERIALS[result.m].debris
    if (result.destroyed) {
      sfx.crunch(0.9 * vol)
      this.effects.spawnDebris(result.center, color, 10, 7)
    } else {
      sfx.crunch(0.35 * vol)
      this.effects.spawnDebris(result.center, color, 4, 4)
    }
    return true
  }
}
