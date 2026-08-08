// The M2: a belt-fed .50 that kills anything it touches. It borrows the
// sniper's hitscan (`sniper.ts`) rather than carrying its own — one ray over
// players, the shark, the mobs and the skeletons means the ray's own ordering
// decides what was in front, with no second pass to double-count a round. It
// asks that ray for built blocks too, which the sniper doesn't.
//
// Every client draws the tracer, so a burst is a shared spectacle, but only
// the SHOOTER resolves what was hit and mints the consequences. That's the
// rule rockets and craters already follow, and it's what stops per-client aim
// drift forking the world.

export const FIFTY_RPM = 70 // ms between rounds — a slow, heavy thump
// Enough to end anything alive in one round — that's the whole idea of it.
// Players take MAX_HP through the ordinary `hit` path (the server caps it
// there anyway); this is for the mobs, the skeletons and the shark, whose
// health nothing else clamps.
export const FIFTY_LETHAL = 9999
// "Destroys anything" — any block, any material, one round. The server caps
// relayed damage at 999, which is the same thing it uses to evict a block.
export const FIFTY_BLOCK_DAMAGE = 999


// A round that lands in dirt digs a small bite. Deliberately much smaller than
// a rocket's — it's the sustained fire that flattens ground, not one round.
export const FIFTY_CRATER = { r: 1.2, d: 0.45 }
