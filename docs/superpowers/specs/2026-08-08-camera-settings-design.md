# Camera settings: follow-cam toggle + settings panel

**Date:** 2026-08-08
**Status:** Approved

## What

A settings panel with one switch: "camera always behind me." When on, the
camera automatically swings around to sit behind the character whenever the
player moves. When off (the default), the camera behaves exactly as it does
today: a fixed yaw the player steers with Q/E.

## Behavior

### Follow cam (switch ON)

- While the player is moving, `camYaw` eases toward "directly behind the
  character" — character yaw + π, taking the shortest way around, using the
  same `delta * Math.min(1, k * dt)` easing style as the existing camera and
  character lerps. Start with k = 4 and tune by feel; slower than the
  character's own turn rate (12) so the camera trails rather than snaps.
- Q/E still rotate the camera at all times (peek). Standing still, the peek
  sticks. Once the player moves, the recenter pull takes over and the camera
  swings back behind the character.
- Jumping in place does not count as moving — only horizontal movement
  triggers the recenter (the character doesn't rotate mid-air in place, so
  there is nothing to recenter behind).

### Switch OFF (default)

Exactly today's behavior. A player who never opens settings sees no change.

### Settings panel

- A gear button in the top-right corner (top-left is taken by the status
  line). Clicking it — or pressing Esc — opens/closes a small dark panel
  with one chunky toggle switch, monospace, matching the existing HUD style
  in `index.html`.
- The setting applies immediately (no reload) and persists to localStorage.

## Architecture

Approach A from brainstorming: two new modules, `main.ts` stays wiring-only.

| File | Change |
|---|---|
| `src/settings.ts` (new) | Owns settings state + panel UI. `initSettings()` returns a live settings object `{ cameraFollow: boolean }`, builds the gear button + panel DOM in JS, binds Esc, reads/writes localStorage. |
| `src/camera.ts` (new) | `GameCamera` class extracted from the camera block in `main.ts` (~lines 68–88): owns `camYaw`, Q/E handling, offset/lerp/lookAt. Gains the follow-recenter behavior gated on the setting and the player's `moving` flag. |
| `src/player.ts` | Expose a public `moving` flag (already computed inside `update`). |
| `src/main.ts` | Wiring only: `initSettings()`, `new GameCamera(camera)`, loop calls `cam.update(dt, keys, player, settings)`. |

### Data flow

`settings.ts` owns a plain mutable object; `camera.ts` reads
`settings.cameraFollow` each frame. No events, no pub/sub — a live object
reference is enough for one consumer.

### Persistence

localStorage key `shared-game.settings`, JSON. Unknown/missing keys fall back
to defaults; parse failures fall back to defaults. Default:
`{ cameraFollow: false }`.

## Out of scope

- No multiplayer impact: camera is purely local. No protocol messages, no
  server changes, world untouched.
- No other settings in this pass (the panel is built so adding a second
  toggle later is easy, but none are added now).
- No touch/gamepad controls.

## Art direction constraints

The panel is DOM (like the existing status/hint overlays), monospace,
low-fi, chunky. No images, no icon fonts — the gear can be a text glyph
(e.g. `⚙`) or a small canvas drawing ≤64px per the repo rules.

## Testing

Manual only (no test framework in this repo):

- Two tabs on `npm run dev` (test on :5173): toggle on in one tab — the
  other tab is unaffected (setting is local).
- Switch off → behavior identical to today (Q/E orbit, fixed yaw).
- Switch on → move around: camera swings behind; Q/E peek while moving is
  gradually overridden; peek while standing still sticks.
- Reload → setting persists. Esc and gear both open/close the panel.
- `npm run build` passes.
