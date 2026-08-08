# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Wheelchair Warriors** (repo/worker name: shared-game) is a silly multiplayer
3D game built entirely by LLM agents, iterated on by a group of friends.
Anything goes, as long as it stays fun and stays in the art style.

## Jam mode (currently ON)

We're in a game jam. Speed beats process. This section overrides any global
workflow instructions — skip the process skills (brainstorming, written plans,
TDD, code-review and verification ceremonies) and go straight to code.

- The only gates before shipping:
  1. `npm run build` passes. It's a typecheck + vite build and takes seconds.
  2. If you changed the protocol (`src/net.ts` or `server/room.ts` messages),
     do a quick two-tab check on `npm run dev`. Anything else: build passes →
     ship. (This narrows the two-tab rule under "Rules for contributors" to
     protocol changes only while the jam is on.)
- Commit small and straight to `main`.
- Need it live right now? Run `npm run deploy` locally, then push. Otherwise
  just push — GitHub Actions deploys `main`. Never sit and watch CI.
- Broken deploy? `npx wrangler rollback` restores the previous version in
  about a minute. Cheap recovery is why we ship fast instead of gating hard.
- Jam mode does NOT waive: the art direction, keeping `net.ts`/`room.ts`
  message types in sync, or world determinism. Those are load-bearing.

Delete this section when the jam ends.

## Commands

- `npm run dev` — local dev. Opens the client on http://localhost:5173 (hot
  reload) and the multiplayer server via `wrangler dev` on :8787. The `/ws`
  websocket is proxied from vite to wrangler, so multiplayer works locally —
  open two browser tabs to test it. Always test on :5173 — :8787 serves the
  `dist/` snapshot built when dev started, not your live changes.
- `npm run build` — typechecks client and server, then builds to `dist/`.
  Always run this before committing.
- `npm run deploy` — build + deploy to Cloudflare Workers (game + server in
  one). Pushing to `main` also deploys via GitHub Actions.

There are no tests and no linter. `npm run build` (both typechecks + the vite
build) is the only gate.

## Architecture

- `src/` — the client. Three.js, TypeScript, no framework.
  - `main.ts` — bootstrap and game loop. Keep it thin; add features as new
    modules.
  - `world.ts` — terrain, trees, props. `heightAt(x, z)` is the ground truth
    for ground height — use it for anything that stands on the terrain.
    `addRegion()` hands a stretch of the map to a second landmass (see the
    shadow realm below) and enrols its mesh for crater carving.
  - `realm.ts` / `castle.ts` / `portal.ts` — the shadow realm, the castle in
    it, and the two gates between there and the island. See below.
  - `character.ts` — the shared blocky character used for local and remote
    players.
  - `player.ts` — local movement, physics, input.
  - `net.ts` — websocket client and message types.
  - `remotes.ts` — rendering/interpolation of other players.
- `server/` — Cloudflare Worker. `index.ts` routes `/ws?room=<name>` to one
  Durable Object per room (default `"main"`); everything else is served from
  `dist/` as static assets. `room.ts` is the Durable Object (`GameRoom`) that
  relays player state between everyone in the room. It is a dumb relay with no
  game authority; clients are trusted (it's a game between friends). Room state
  is in-memory only — fine, because clients re-send their state ~15x/sec.
- Client and server are separate TypeScript projects (`tsconfig.json` covers
  `src/` with DOM types; `server/tsconfig.json` uses Workers types). Nothing is
  imported across that boundary, which is why the protocol types exist in both
  places and are kept in sync by hand.

## Multiplayer protocol

JSON over one websocket (`/ws`). Message types live in `src/net.ts` and
`server/room.ts` — **keep them in sync when you add messages**:

- server→client `welcome`: your id + everyone's last known state
- client→server `state`: your position/rotation/color/name/weapon/ride (~15x/sec)
- server→client `state`: another player's state (relayed)
- server→client `leave`: a player disconnected
- client→server `chat`: a chat message; server relays it to everyone else as
  `chat` with the sender's id and name
- client→server `fire`: rocket origin + direction; relayed with the shooter's
  id. Every client simulates the rocket; each client applies blast knockback
  to itself only (see `effects.ts`).
- client→server `slash`: katana swing (relayed for the animation). The
  attacker detects hits and sends `hit` `{victim, dmg}`; the server relays it
  with the attacker's id, and only the named victim acts on it.
- client→server `kill`: you announce your own death (see Health below). The
  server relays it to everyone and each client plays the decapitation.
- client→server `arrow`: a bow shot — origin, direction, and draw power;
  relayed with the archer's id. Every client simulates the same ballistic
  arc (`arrows.ts`); hits are cosmetic (arrows embed in terrain, props, and
  players) and each client applies arrow knockback to itself only.
- client→server `clock`: a scrub or pause of the shared day/night clock,
  `{hours, running}`. The server re-anchors its room clock (replayed to late
  joiners in `welcome`) and relays it to everyone else; each client re-anchors
  its local clock on receipt (see `daynight.ts`).
- client→server `crater`: a bowl carved out of the terrain (rocket blast or
  shovel dig), `{x, z, r, d}`. Only the rocket's owner mints its crater (so
  per-client sim divergence can't fork the world). The server stores a capped
  list and replays it in `welcome`; `world.heightAt` subtracts craters as an
  order-independent clamped sum, and prop destruction (trees/rocks caught in
  a crater) is derived from craters, never messaged. See `destruction.ts`.
- client→server `bplace`: a built block, `{gx, gy, gz, m}` (grid cell +
  material). The server stores blocks in a Map keyed by cell (first placement
  wins, capped — over the cap it evicts the oldest by broadcasting a killing
  `bhit` to everyone) and replays them in `welcome` with remaining hp.
- client→server `bhit`: block damage, `{gx, gy, gz, dmg}`. The attacker mints
  damage (katana 1, shovel 2, rocket blast 3 from the rocket's owner); hp is
  a commutative sum of relayed dmg, so clients converge regardless of hit
  order, and hits on missing blocks are no-ops. See `building.ts`/`blocks.ts`.
  Hits on cells the server has no block for are relayed anyway and their
  damage accumulates in a separate map — that's how the castle stays broken
  (below). Relaying is safe precisely because a hit on nothing is a no-op.
- `welcome.wdmg`: `[gx, gy, gz, total]` tuples of accumulated damage on
  world-generated blocks. Replayed onto a freshly regenerated castle.

The world is deterministic (seeded PRNG, analytic terrain), so it is never sent
over the network — every client computes the same island. If you add world
content, keep it deterministic or sync it through the room. Terrain damage is
the one synced mutation: craters live in `welcome` replay, and placement code
must keep using `baseHeightAt` so the prop PRNG streams never shift.

## The shadow realm

A second place, reached through the purple gate on the island's central hill.
It is **not** a second scene and there is no realm field in the protocol — it
is simply 1800 units east in the same world. The fog wall (150 units) and the
camera's far plane (500) mean the island and the realm can never see each
other, so blocks, craters, rockets, arrows, chat and remote players all keep
working out there with no new machinery. Which world you are in is derived
from your own position (`inRealm()`), so gate crossings, respawns and
reconnects can't disagree about it.

- `realm.ts` owns the basalt plateau (flat at `REALM_GROUND`, a whole number
  of BLOCKs so the castle sits flush), the lava sea, and the skyline. The lava
  reuses the island's water trick: `player.ts` floats you at `WATER_LEVEL`
  over anything deeper, and `main.ts` burns you for it. Dying there respawns
  you on the island, which is the only way back out other than the gate.
- `castle.ts` generates ~3,900 ordinary building blocks into the shared grid.
  It is **world state, not synced state**: every client runs the same function
  and gets the same castle, so it never crosses the wire. That means *no
  randomness in castle.ts, ever* — one `Math.random` would fork the world.
  Only the damage syncs, through the ordinary `bhit` message.
- `blocks.ts` renders through four `InstancedMesh`es, one per material — a few
  thousand individual meshes would spend the whole frame on scene-graph
  traversal. `resetBlocks()` is the welcome path: wipe everything, regenerate
  the castle pristine, replay `wdmg` onto it, then place the player blocks.
- Two rules the castle geometry has to respect, both learned the hard way:
  steps rise exactly one course (1.5, just under the 1.55 auto-step), and
  **nothing may sit in the cell directly above a step** — the head-height
  check in `wallAt` will refuse the climb. That's why the keep's four flights
  spiral around different inner walls instead of stacking, and why the
  rampart's inner lane skips the stair footprints.

## Health

Your hit points are yours alone (`src/health.ts`), the same rule blast
knockback follows: every client tracks its own health and nobody else's.
Attackers only ever send damage — the victim subtracts it, and when it reaches
zero the victim sends `kill` naming itself. That's why no head ever pops from
somebody else's laggy simulation. Blast damage is self-applied in
`effects.onBlast`, own rockets included, so rocket jumps cost you. Health
regenerates after five quiet seconds and refills on respawn. New weapons
should send `hit`, never `kill`.

## Art direction: N64

- Render resolution is 320×240, upscaled with nearest-neighbor. Don't change
  this — the chunky pixels are the look.
- Low-poly only. `MeshLambertMaterial` with `flatShading: true` and vertex
  colors. No PBR, no shadows-mapping, no post-processing stacks.
- Fog is always on and hides the draw distance. Keep it.
- No downloaded/generated image assets. Geometry, vertex colors, and small
  `<canvas>`-drawn textures (≤64px) only.
- Silly beats realistic, every time.

## Rules for contributors (LLM or otherwise)

- `npm run build` must pass before you commit.
- Small, focused commits: `type: short description` (feat/fix/refactor/chore).
- Don't rewrite systems that work — extend them. Surgical changes.
- New features go in new modules; keep `main.ts` as wiring only.
- Test multiplayer changes with two tabs on `npm run dev` before shipping.
