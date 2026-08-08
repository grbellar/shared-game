import * as THREE from 'three'
import { heightAt, propInPath } from './world'
import { blockAtPoint, BLOCK, type BlockSpec } from './blocks'

// The M2: a belt-fed .50 that goes through anything. Not a projectile like the
// rocket — it's hitscan, marched along the line of fire in small steps until it
// meets something. Whatever it meets loses.
//
// Every client draws the tracer, so the burst is a shared spectacle, but only
// the SHOOTER resolves what was hit and mints the consequences — a block hit,
// a crater, damage on a player. That's the same rule rockets and craters
// already follow, and it's what stops per-client aim drift forking the world.

const RANGE = 220 // it reaches clean across the island
const STEP = 0.35 // march resolution; finer than the 1.5 block grid
export const FIFTY_RPM = 70 // ms between rounds — a slow, heavy thump
export const FIFTY_PLAYER_DAMAGE = 34 // three rounds and a head comes off
// "Destroys anything" — any block, any material, one round. The server caps
// relayed damage at 999, which is the same thing it uses to evict a block.
export const FIFTY_BLOCK_DAMAGE = 999

export interface Hit {
  point: THREE.Vector3
  // Exactly one of these, or none if the round went into the terrain/sea.
  player?: string
  block?: BlockSpec
  ground?: boolean
}

// March the line and report the first thing in the way. Players are checked
// against a chest-height capsule, the same approximation rockets use.
export function traceShot(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  targets: { id: string; pos: THREE.Vector3 }[],
  shooter: string,
): Hit {
  const p = origin.clone()
  const d = dir.clone().normalize().multiplyScalar(STEP)
  const chest = new THREE.Vector3()
  for (let travelled = 0; travelled < RANGE; travelled += STEP) {
    p.add(d)
    for (const t of targets) {
      if (t.id === shooter) continue
      chest.set(t.pos.x, t.pos.y + 1.2, t.pos.z)
      if (chest.distanceTo(p) < 1.1) return { point: p.clone(), player: t.id }
    }
    const block = blockAtPoint(p.x, p.y, p.z)
    if (block) return { point: p.clone(), block }
    if (propInPath(p)) return { point: p.clone(), ground: true }
    // Terrain, or the sea surface.
    if (p.y <= Math.max(heightAt(p.x, p.z), 0)) return { point: p.clone(), ground: true }
  }
  return { point: p.clone() }
}


// Where the muzzle sits, so the tracer leaves the barrel rather than the navel.
export function muzzleOf(pos: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 {
  return pos.clone().add(new THREE.Vector3(dir.x * 2.2, 1.75, dir.z * 2.2))
}

// A round that lands in dirt digs a small bite. Deliberately much smaller than
// a rocket's — it's the sustained fire that flattens ground, not one round.
export const FIFTY_CRATER = { r: 1.2, d: 0.45 }

export { BLOCK }
