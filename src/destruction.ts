import * as THREE from 'three'
import { addCraters, heightAt, type Crater, type DestroyedProp } from './world'
import type { Effects } from './effects'
import type { Net } from './net'

// World damage orchestration: turns rocket blasts and shovel digs into
// synced craters, and blows up whatever props the craters catch. This is the
// only module that talks to world + effects + net together — world must
// never import effects (effects already imports world).

const ROCKET_CRATER = { r: 3.8, d: 1.6 }
const DIG_CRATER = { r: 2.2, d: 1.1 }
const DIRT = 0x6b4526

export class Destruction {
  constructor(
    private effects: Effects,
    private net: Net,
  ) {}

  // Called when one of OUR rockets explodes — only the shooter mints the
  // crater, everyone else learns about it over the wire.
  rocketCrater(center: THREE.Vector3): void {
    // Mid-air detonations (direct player hits, life expiry) don't dig.
    if (center.y - Math.max(heightAt(center.x, center.z), 0) >= 1.5) return
    this.applyLocal({ x: center.x, z: center.z, ...ROCKET_CRATER })
  }

  // A shovel scoop at (x, z), authored by the local player.
  dig(x: number, z: number): void {
    this.applyLocal({ x, z, ...DIG_CRATER })
    this.effects.spawnDebris(new THREE.Vector3(x, Math.max(heightAt(x, z), 0) + 0.4, z), DIRT, 8, 5)
  }

  // Craters arriving over the network — live relays or the welcome replay.
  // Silent skips debris bursts so a late joiner doesn't see 500 explosions.
  applyRemote(craters: Crater[], silent = false): void {
    this.apply(craters, !silent)
  }

  private applyLocal(c: Crater): void {
    this.apply([c], true)
    this.net.sendCrater(c)
  }

  private apply(craters: Crater[], debris: boolean): void {
    const dead = addCraters(craters)
    if (!debris) return
    for (const prop of dead) this.explodeProp(prop)
  }

  private explodeProp(prop: DestroyedProp): void {
    const base = new THREE.Vector3(prop.x, prop.y + 0.5, prop.z)
    if (prop.kind === 'tree') {
      this.effects.spawnDebris(base, 0x6b4a2b, 6, 7)
      const canopy = new THREE.Vector3(prop.x, prop.y + 3 * prop.s, prop.z)
      this.effects.spawnDebris(canopy, 0x2e7d32, 10, 8)
    } else {
      this.effects.spawnDebris(base, 0x7d7d85, 8, 6)
    }
  }
}
