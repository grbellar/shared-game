import { BLOCK, MATERIALS, placeBlock } from './blocks'
import { REALM_GROUND, REALM_X, REALM_Z } from './realm'

// Blackstone Keep: a few thousand blocks of the ordinary building grid,
// arranged into a castle. Every client runs this exact function and gets the
// exact same castle, so it never crosses the wire — only the damage does
// (`bhit`, the same message a katana sends). That is why there is not one
// call to Math.random in here: a single random number would fork the world.
//
// Coordinates are local cells (u east, v north) around the castle center,
// with gy absolute. G0 is the first course, and it sits flush on the plateau
// because REALM_GROUND is a whole number of BLOCKs.

const CGX = Math.round(REALM_X / BLOCK)
const CGZ = Math.round(REALM_Z / BLOCK)
const G0 = Math.round(REALM_GROUND / BLOCK)

const WOOD = 0
const STONE = 1
const BRICK = 2
const METAL = 3

const WALL = 22 // curtain half-width in cells: a 45x45 footprint, 67 units across
const WALL_TOP = G0 + 5 // top course; the walkway surface is one course above
const KEEP_V = 6 // the keep sits north of center, leaving the gate approach open
const KEEP_R = 5 // 11x11 footprint
const KEEP_TOP = G0 + 15
// Storeys, bottom to top. The last one is the open roof deck.
const STOREYS = [G0 + 3, G0 + 7, G0 + 11, KEEP_TOP]

// One flight per storey, each hugging a different inner wall so the keep
// spirals. They must not share a footprint: two runs in the same column would
// put the upper flight's first step directly over the lower flight's last
// one, and the head-height wall check would refuse to let you finish the
// climb. Cells are [du, dv-from-KEEP_V], in climbing order.
const RUNS: [number, number][][] = [
  [[4, -1], [4, 0], [4, 1], [4, 2]], // east wall, climbing north
  [[2, 4], [1, 4], [0, 4], [-1, 4]], // north wall, climbing west
  [[-4, 2], [-4, 1], [-4, 0], [-4, -1]], // west wall, climbing south
  [[-1, -4], [0, -4], [1, -4], [2, -4]], // south wall, climbing east
]

// Where the gate faces, in world units — the realm's road and arrival portal
// line up on this.
export const CASTLE_GATE_Z = REALM_Z - WALL * BLOCK

// Where the garrison stands, in world units. Fixed posts rather than random
// scatter: a skeleton wants somewhere to go back to, and a fixed list means
// every client agrees on the roster even before the host's first update.
// `y` is the walking surface — the courtyard, the wall walk at WALL_TOP, the
// keep's storeys, the roof deck.
const RAMPART_Y = (WALL_TOP + 1) * BLOCK
const FLOOR1_Y = (STOREYS[0] + 1) * BLOCK
const DECK_Y = (KEEP_TOP + 1) * BLOCK
export const GUARD_POSTS: { x: number; y: number; z: number }[] = [
  { x: REALM_X - 18, y: REALM_GROUND, z: REALM_Z - 12 }, // courtyard, four corners of it
  { x: REALM_X + 15, y: REALM_GROUND, z: REALM_Z - 14 },
  { x: REALM_X - 16, y: REALM_GROUND, z: REALM_Z + 15 },
  { x: REALM_X + 19, y: REALM_GROUND, z: REALM_Z + 7 },
  { x: REALM_X, y: REALM_GROUND, z: REALM_Z - 42 }, // the road, outside the gate
  { x: REALM_X - 9, y: REALM_GROUND, z: REALM_Z - 36 },
  { x: (0 - WALL + 1) * BLOCK + REALM_X, y: RAMPART_Y, z: REALM_Z + 6 }, // wall walk
  { x: (WALL - 1) * BLOCK + REALM_X, y: RAMPART_Y, z: REALM_Z - 6 },
  { x: REALM_X + 3, y: REALM_GROUND, z: (KEEP_V + 1) * BLOCK + REALM_Z }, // throne room
  { x: REALM_X - 3, y: FLOOR1_Y, z: (KEEP_V - 2) * BLOCK + REALM_Z }, // keep, first storey
  { x: REALM_X, y: DECK_Y, z: (KEEP_V + 3) * BLOCK + REALM_Z }, // roof deck lookout
]

function put(u: number, v: number, gy: number, m: number): void {
  placeBlock({ gx: CGX + u, gy, gz: CGZ + v, m, hp: MATERIALS[m].hp })
}

// A solid column from `from` up to and including `to`.
function column(u: number, v: number, from: number, to: number, m: number): void {
  for (let gy = from; gy <= to; gy++) put(u, v, gy, m)
}

// Alternating merlons. Two courses on the curtain, where the walk is two
// cells wide and the battlements stand on the outer lane — proper cover you
// can't stroll through, with embrasures between them to shoot from. Towers
// pass 1, because their walk is only the cell the merlon sits on.
function merlon(u: number, v: number, gy: number, m: number, courses = 1): void {
  if ((u + v + 1000) % 2 !== 0) return
  for (let i = 0; i < courses; i++) put(u, v, gy + i, m)
}

// ---------------------------------------------------------------- curtain

function curtainWall(): void {
  for (let u = -WALL; u <= WALL; u++) {
    for (let v = -WALL; v <= WALL; v++) {
      if (Math.abs(u) !== WALL && Math.abs(v) !== WALL) continue
      const gateway = v === -WALL && Math.abs(u) <= 1
      // The last siege got this far: a ragged breach in the north wall — the
      // one way in that doesn't involve smashing the portcullis.
      const breached = v === WALL && u >= 4 && u <= 8
      for (let gy = G0; gy <= WALL_TOP; gy++) {
        if (gateway && gy <= G0 + 3) continue // the arch; iron fills it below
        if (breached && gy <= G0 + 2) continue
        if (breached && gy === G0 + 3 && u >= 5 && u <= 7) continue
        if (gy === G0 + 3 && (u + v + 4400) % 6 === 0) continue // arrow slits
        put(u, v, gy, STONE)
      }
      if (!breached) merlon(u, v, WALL_TOP + 1, STONE, 2)
    }
  }
  // Inner lane of the wall walk, corbelled out over the courtyard. Without
  // it the rampart is one cell wide and you spend the whole lap falling off.
  // Skips the stair footprints: a slab directly over a step is a ceiling the
  // head-height check won't let you climb into.
  for (let u = -WALL + 1; u <= WALL - 1; u++) {
    for (let v = -WALL + 1; v <= WALL - 1; v++) {
      if (Math.abs(u) !== WALL - 1 && Math.abs(v) !== WALL - 1) continue
      if (onStairs(u, v)) continue
      put(u, v, WALL_TOP - 1, STONE)
      put(u, v, WALL_TOP, STONE)
    }
  }
  // Rubble spilled out of the breach.
  for (const [u, gy] of [[4, G0], [6, G0], [9, G0], [9, G0 + 1]] as const) {
    put(u, WALL + 1, gy, STONE)
  }
  // The portcullis. Iron, four courses of it, and the loudest thing in the
  // castle when it finally goes.
  for (let u = -1; u <= 1; u++) column(u, -WALL, G0, G0 + 3, METAL)
}

// Round-ish corner tower: an annulus mask on the grid, which at 1.5-unit
// cells reads as a proper drum tower from any distance the fog allows. The
// wall walk runs straight through it — the ring opens at walkway height where
// it crosses the curtain, so each corner is a room on your lap of the walls.
function drumTower(cu: number, cv: number): void {
  const top = G0 + 11
  for (let du = -4; du <= 4; du++) {
    for (let dv = -4; dv <= 4; dv++) {
      const u = cu + du
      const v = cv + dv
      const d = Math.hypot(du, dv)
      if (d > 2.9 && d <= 3.75) {
        // Where the ring crosses either lane of the wall walk, open a
        // head-height passage — that's what makes the corners walk-through
        // rooms instead of four dead ends.
        const lane = u === cu || u === cu - Math.sign(cu) || v === cv || v === cv - Math.sign(cv)
        for (let gy = G0; gy <= top; gy++) {
          if (lane && gy > WALL_TOP && gy <= WALL_TOP + 3) continue // doorway
          if (gy === G0 + 7 && (du + dv + 1000) % 3 === 0) continue // windows
          put(u, v, gy, STONE)
        }
        merlon(u, v, top + 1, BRICK)
      } else if (d <= 2.9) {
        // Floor flush with the rampart walkway, so you stroll straight in.
        put(u, v, WALL_TOP, WOOD)
      }
    }
  }
}

// Square turret flanking the gate road. Sits entirely outside the curtain so
// it never interrupts the wall walk.
function gateTurret(cu: number): void {
  const cv = -WALL - 3
  const top = G0 + 9
  for (let du = -2; du <= 2; du++) {
    for (let dv = -2; dv <= 2; dv++) {
      const ring = Math.abs(du) === 2 || Math.abs(dv) === 2
      if (ring) {
        for (let gy = G0; gy <= top; gy++) {
          if (dv === 2 && du === 0 && gy <= G0 + 2) continue // door, facing the gate
          if (gy === G0 + 6 && (du + dv + 1000) % 4 === 0) continue // windows
          put(cu + du, cv + dv, gy, STONE)
        }
        merlon(cu + du, cv + dv, top + 1, BRICK)
      } else {
        put(cu + du, cv + dv, G0 + 4, WOOD)
      }
    }
  }
}

// ------------------------------------------------------------------- keep

function keep(): void {
  for (let du = -KEEP_R; du <= KEEP_R; du++) {
    for (let dv = -KEEP_R; dv <= KEEP_R; dv++) {
      if (Math.abs(du) !== KEEP_R && Math.abs(dv) !== KEEP_R) continue
      const u = du
      const v = KEEP_V + dv
      const doorway = dv === -KEEP_R && Math.abs(du) <= 1
      for (let gy = G0; gy <= KEEP_TOP; gy++) {
        if (doorway && gy <= G0 + 2) continue
        // Tall windows on the upper storeys.
        if ((gy === G0 + 5 || gy === G0 + 9 || gy === G0 + 13) && (du + dv + 4400) % 4 === 0) {
          continue
        }
        put(u, v, gy, BRICK)
      }
      merlon(u, v, KEEP_TOP + 1, BRICK)
    }
  }

  // Storeys, each pierced where its own flight comes up through it. Steps
  // rise one course apiece — exactly the auto-step height — so the whole keep
  // walks top to bottom without ever needing the jump key.
  for (let i = 0; i < STOREYS.length; i++) {
    const gy = STOREYS[i]
    const deck = i === STOREYS.length - 1
    const base = i === 0 ? G0 : STOREYS[i - 1] + 1
    const run = RUNS[i]
    for (let du = -KEEP_R + 1; du <= KEEP_R - 1; du++) {
      for (let dv = -KEEP_R + 1; dv <= KEEP_R - 1; dv++) {
        if (run.some(([ru, rv]) => ru === du && rv === dv)) continue // stairwell
        put(du, KEEP_V + dv, gy, deck ? BRICK : WOOD)
      }
    }
    // The top step lands at `gy`, plugging the hole it climbs through.
    run.forEach(([du, dv], k) => column(du, KEEP_V + dv, base, base + k, BRICK))
  }

  // The watch spire on the roof, with a door out onto the deck.
  for (let du = -2; du <= 2; du++) {
    for (let dv = -2; dv <= 2; dv++) {
      if (Math.abs(du) !== 2 && Math.abs(dv) !== 2) continue
      for (let gy = KEEP_TOP + 1; gy <= KEEP_TOP + 8; gy++) {
        if (dv === -2 && du === 0 && gy <= KEEP_TOP + 3) continue
        put(du, KEEP_V + dv, gy, METAL)
      }
    }
  }
  for (let du = -1; du <= 1; du++) {
    for (let dv = -1; dv <= 1; dv++) put(du, KEEP_V + dv, KEEP_TOP + 9, METAL)
  }
  put(0, KEEP_V, KEEP_TOP + 10, METAL)

  // Somebody used to sit here.
  for (let du = -1; du <= 1; du++) {
    put(du, KEEP_V + 3, G0, METAL)
    put(du, KEEP_V + 4, G0 + 1, METAL)
    put(du, KEEP_V + 4, G0 + 2, METAL)
  }
}

// Two flights up to the wall walk, one either side of the courtyard. They run
// along the inner lane, so that lane's slab has to make way for them.
function onStairs(u: number, v: number): boolean {
  if (u === -WALL + 1 && v >= -6 && v <= -1) return true
  return u === WALL - 1 && v >= 1 && v <= 6
}

function rampartStairs(): void {
  for (let step = 0; step <= 5; step++) {
    column(-WALL + 1, -6 + step, G0, G0 + step, STONE)
    column(WALL - 1, 6 - step, G0, G0 + step, STONE)
  }
}

export function buildCastle(): void {
  curtainWall()
  drumTower(-WALL, -WALL)
  drumTower(WALL, -WALL)
  drumTower(-WALL, WALL)
  drumTower(WALL, WALL)
  gateTurret(-5)
  gateTurret(5)
  rampartStairs()
  keep()
}
