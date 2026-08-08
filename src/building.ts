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

export class Building {
  // Distance falloff for remote sounds; main.ts wires this to distVol.
  volumeAt: (pos: THREE.Vector3) => number = () => 1

  constructor(
    private effects: Effects,
    private net: Net,
  ) {}

  // Place the current material into the column in front of the player (or
  // under the first-person crosshair's ground point). False = whiffed click:
  // out of range, column full, or the cell is taken.
  place(pos: THREE.Vector3, ry: number, m: number, aimed: { x: number; z: number } | null): boolean {
    const tx = aimed ? aimed.x : pos.x + Math.sin(ry) * PLACE_REACH
    const tz = aimed ? aimed.z : pos.z + Math.cos(ry) * PLACE_REACH
    const gx = Math.round(tx / BLOCK)
    const gz = Math.round(tz / BLOCK)
    if (Math.abs(gx) > GRID_XZ_MAX || Math.abs(gz) > GRID_XZ_MAX) return false
    const gy = findPlacementGy(gx, gz)
    if (gy > GY_MAX || gy * BLOCK > pos.y + OVERHEAD_CAP) return false
    if (!placeBlock({ gx, gy, gz, m, hp: MATERIALS[m].hp })) return false
    sfx.land(0.5)
    this.net.sendBlockPlace(gx, gy, gz, m)
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
