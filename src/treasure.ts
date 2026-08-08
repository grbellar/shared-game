import * as THREE from 'three'
import { baseHeightAt, mulberry32 } from './world'
import { sfx } from './audio'
import type { Hat } from './character'

// Buried treasure — the reason the shovel exists.
//
// Six caches are placed by their own seeded PRNG (never the prop stream, so
// digging can't shift where the trees are). Nothing marks them: hold the
// shovel and the detector blips faster as you close in. Dig on the spot and
// you get a hat, which is synced through PlayerState so everyone can see what
// you found. Claims are broadcast as an `egg` message (kind 'dig') and stored
// by the room, so a late joiner can't dig up a chest somebody already took.

const TREASURE_SEED = 777
const CACHE_COUNT = 6
const ISLAND_REACH = 78
const DIG_RANGE = 2.4 // how close a scoop has to land
const DETECT_RANGE = 15 // how far the detector reaches

export interface Cache {
  x: number
  z: number
  hat: Hat
  label: string
}

const LOOT: { hat: Hat; label: string }[] = [
  { hat: 'crown', label: 'THE CROWN' },
  { hat: 'wizard', label: 'A WIZARD HAT' },
  { hat: 'pirate', label: 'A PIRATE HAT' },
  { hat: 'tinfoil', label: 'A TINFOIL HAT' },
  { hat: 'cone', label: 'A TRAFFIC CONE' },
  { hat: 'bucket', label: 'A BUCKET' },
]

function placeCaches(): Cache[] {
  const rand = mulberry32(TREASURE_SEED)
  const caches: Cache[] = []
  // Rejection sampling onto walkable ground. Bounded so a pathological seed
  // can't spin forever; short lists just mean fewer chests.
  for (let attempt = 0; attempt < 400 && caches.length < CACHE_COUNT; attempt++) {
    const x = (rand() - 0.5) * 2 * ISLAND_REACH
    const z = (rand() - 0.5) * 2 * ISLAND_REACH
    if (Math.hypot(x, z) > ISLAND_REACH) continue
    const h = baseHeightAt(x, z)
    if (h < 1.8 || h > 9) continue
    // Spread them out so one lucky dig can't hit two.
    if (caches.some((c) => Math.hypot(c.x - x, c.z - z) < 18)) continue
    const loot = LOOT[caches.length]
    caches.push({ x, z, hat: loot.hat, label: loot.label })
  }
  return caches
}

export class Treasure {
  readonly caches = placeCaches()
  private claimed = new Set<number>()
  private blip = 0

  // How many are still out there — shown when the detector is humming.
  get remaining(): number {
    return this.caches.length - this.claimed.size
  }

  isClaimed(i: number): boolean {
    return this.claimed.has(i)
  }

  cache(i: number): Cache | undefined {
    return this.caches[i]
  }

  // A claim from the network (live relay or the welcome replay).
  markClaimed(i: number): void {
    if (i >= 0 && i < this.caches.length) this.claimed.add(i)
  }

  // A shovel scoop landed at (x, z). Returns the cache index if this scoop
  // claims one, else null. The caller broadcasts and applies the loot.
  tryDig(x: number, z: number): number | null {
    for (let i = 0; i < this.caches.length; i++) {
      if (this.claimed.has(i)) continue
      const c = this.caches[i]
      if (Math.hypot(c.x - x, c.z - z) > DIG_RANGE) continue
      this.claimed.add(i)
      return i
    }
    return null
  }

  // Distance to the nearest unclaimed cache, or null if none are in range.
  private nearest(pos: THREE.Vector3): number | null {
    let best = Infinity
    for (let i = 0; i < this.caches.length; i++) {
      if (this.claimed.has(i)) continue
      const c = this.caches[i]
      best = Math.min(best, Math.hypot(c.x - pos.x, c.z - pos.z))
    }
    return best === Infinity ? null : best
  }

  // Run the detector while the shovel is out. Returns the HUD line to show
  // (or null to hide it) and blips as a side effect.
  update(dt: number, pos: THREE.Vector3, holdingShovel: boolean): string | null {
    if (!holdingShovel) return null
    const d = this.nearest(pos)
    if (d === null) return 'the shovel is quiet. the island is picked clean.'
    if (d > DETECT_RANGE) return null

    const closeness = 1 - d / DETECT_RANGE
    this.blip -= dt
    if (this.blip <= 0) {
      // 1.1s between blips at the edge of range, 0.1s on top of it.
      this.blip = 1.1 - closeness * 1.0
      sfx.ping(closeness)
    }
    if (d < DIG_RANGE) return 'the shovel is SCREAMING. dig. dig here.'
    if (closeness > 0.66) return 'the shovel rattles hard…'
    if (closeness > 0.33) return 'the shovel is buzzing…'
    return 'the shovel hums faintly…'
  }
}
