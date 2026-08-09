import * as THREE from 'three'
import { addCraters, heightAt, type Crater, type DestroyedProp } from './world'
import type { Effects } from './effects'
import type { Net } from './net'
import { sfx } from './audio'

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
    // Sky detonations (life expiry, mid-jump player hits) don't dig. The
    // threshold sits above rocket cruise height (~1.8-2.5 over the ground)
    // so trunk-level tree hits and grounded player hits still crater —
    // a tree that eats a rocket has to die.
    if (center.y - Math.max(heightAt(center.x, center.z), 0) >= 3) return
    this.applyLocal({ x: center.x, z: center.z, ...ROCKET_CRATER })
  }

  // A shovel scoop at (x, z), authored by the local player. Each scoop is
  // jittered a touch: repeated digs from one spot would otherwise produce
  // byte-identical craters and get eaten by the reconnect dedupe (and the
  // jitter is minted here, so it rides the message — all clients agree).
  dig(x: number, z: number): void {
    sfx.dig()
    this.applyLocal({
      x: x + (Math.random() - 0.5) * 0.7,
      z: z + (Math.random() - 0.5) * 0.7,
      ...DIG_CRATER,
    })
    this.effects.spawnDebris(new THREE.Vector3(x, Math.max(heightAt(x, z), 0) + 0.4, z), DIRT, 8, 5)
  }

  // A single heavy round biting the dirt (fifty.ts). Same synced-crater path
  // as a dig, minus the shovel's sound and debris — the gun makes its own
  // noise, and a burst would otherwise spray a hundred dirt cubes a second.
  // Jittered like a dig so repeated rounds from one spot aren't byte-identical
  // and eaten by the reconnect dedupe.
  bite(x: number, z: number, shape: { r: number; d: number }): void {
    this.applyLocal({
      x: x + (Math.random() - 0.5) * 0.5,
      z: z + (Math.random() - 0.5) * 0.5,
      ...shape,
    })
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
    sfx.crunch(0.6)
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
