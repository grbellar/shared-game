# shared-game

A silly multiplayer 3D game built entirely by LLM agents, iterated on by a group
of friends. Anything goes, as long as it stays fun and stays in the art style.

## Commands

- `npm run dev` — local dev. Opens the client on http://localhost:5173 (hot
  reload) and the multiplayer server via `wrangler dev` on :8787. The `/ws`
  websocket is proxied from vite to wrangler, so multiplayer works locally —
  open two browser tabs to test it.
- `npm run build` — typechecks client and server, then builds to `dist/`.
  Always run this before committing.
- `npm run deploy` — build + deploy to Cloudflare Workers (game + server in
  one). Pushing to `main` also deploys via GitHub Actions.

## Architecture

- `src/` — the client. Three.js, TypeScript, no framework.
  - `main.ts` — bootstrap and game loop. Keep it thin; add features as new
    modules.
  - `world.ts` — terrain, trees, props. `heightAt(x, z)` is the ground truth
    for ground height — use it for anything that stands on the terrain.
  - `character.ts` — the shared blocky character used for local and remote
    players.
  - `player.ts` — local movement, physics, input.
  - `net.ts` — websocket client and message types.
  - `remotes.ts` — rendering/interpolation of other players.
- `server/` — Cloudflare Worker. `room.ts` is a Durable Object (`GameRoom`)
  that relays player state between everyone in the room. It is a dumb relay
  with no game authority; clients are trusted (it's a game between friends).

## Multiplayer protocol

JSON over one websocket (`/ws`). Message types live in `src/net.ts` and
`server/room.ts` — **keep them in sync when you add messages**:

- server→client `welcome`: your id + everyone's last known state
- client→server `state`: your position/rotation/color/name (sent ~15x/sec)
- server→client `state`: another player's state (relayed)
- server→client `leave`: a player disconnected

The world is deterministic (seeded PRNG, analytic terrain), so it is never sent
over the network — every client computes the same island. If you add world
content, keep it deterministic or sync it through the room.

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
