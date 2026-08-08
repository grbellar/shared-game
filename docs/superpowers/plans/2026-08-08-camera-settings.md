# Camera Settings (Follow-Cam Toggle + Settings Panel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A settings panel (gear button / Esc) with one switch — "camera always behind me" — that makes the camera ease in behind the character whenever the player moves.

**Architecture:** Two new modules keep `main.ts` wiring-only: `src/camera.ts` gets a `GameCamera` class extracted from the camera block currently in `main.ts`, and `src/settings.ts` owns a live settings object plus the DOM panel that mutates it and persists to localStorage. The camera reads `settings.cameraFollow` and `player.moving` each frame — no events, no pub/sub.

**Tech Stack:** TypeScript (strict), Three.js, Vite, plain DOM overlays. No UI framework. No test framework — verification is `npm run build` (typechecks client+server) plus manual checks in the browser.

**Spec:** `docs/superpowers/specs/2026-08-08-camera-settings-design.md`

## Global Constraints

- `npm run build` must pass before every commit (this is the repo's only gate; there are no tests or linter).
- Manual testing happens on http://localhost:5173 via `npm run dev` — never :8787, which serves a stale `dist/` snapshot.
- Commit messages: `type: short description` (feat/fix/refactor/chore). Never mention Claude or Anthropic.
- Art direction: DOM overlays are 12px monospace, low-fi, chunky. No images, no icon fonts — text glyphs only (the gear is the `⚙` character). Square corners (`border-radius: 0`).
- localStorage key is exactly `shared-game.settings`; default is `{ cameraFollow: false }`. Missing keys, unknown keys, and parse failures all fall back to defaults.
- No multiplayer/protocol/server changes anywhere in this plan.
- `tsconfig.json` has `noUnusedLocals` — an assigned-but-unread variable fails the build (Task 2 calls `initSettings()` without binding it for exactly this reason; Task 3 adds the binding).

---

### Task 1: Extract `GameCamera` into `src/camera.ts` (pure refactor)

**Files:**
- Create: `src/camera.ts`
- Modify: `src/main.ts` (removes lines 68–91 of the current file: the `camYaw`/`CAM_OFFSET`/`CAM_TARGET` declarations, `camera.position.set(0, 12, 14)`, and the camera portion of the animation loop)

**Interfaces:**
- Consumes: `Player` from `src/player.ts` (`player.group.position`, `player.group.rotation`), the `THREE.PerspectiveCamera` created in `main.ts`.
- Produces (Task 3 relies on these exact names):
  - `class GameCamera` with `constructor(camera: THREE.PerspectiveCamera)`
  - `get yaw(): number` — the current camera yaw; `main.ts` passes it to `player.update`
  - `update(dt: number, keys: Set<string>, player: Player): void`

- [ ] **Step 1: Create `src/camera.ts`**

```ts
import * as THREE from 'three'
import type { Player } from './player'

const ORBIT_SPEED = 2.2
const DISTANCE = 9
const HEIGHT = 6
const LOOK_HEIGHT = 2
const POSITION_LERP = 8

// Third-person orbit camera, steered with Q/E.
export class GameCamera {
  private camYaw = 0
  private readonly offset = new THREE.Vector3()
  private readonly lookTarget = new THREE.Vector3()

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    camera.position.set(0, 12, 14)
  }

  // Movement is camera-relative; main.ts feeds this to player.update.
  get yaw(): number {
    return this.camYaw
  }

  update(dt: number, keys: Set<string>, player: Player): void {
    if (keys.has('KeyQ')) this.camYaw += ORBIT_SPEED * dt
    if (keys.has('KeyE')) this.camYaw -= ORBIT_SPEED * dt

    this.offset.set(Math.sin(this.camYaw) * DISTANCE, HEIGHT, Math.cos(this.camYaw) * DISTANCE)
    this.lookTarget.copy(player.group.position).add(this.offset)
    this.camera.position.lerp(this.lookTarget, Math.min(1, POSITION_LERP * dt))
    this.lookTarget.copy(player.group.position)
    this.lookTarget.y += LOOK_HEIGHT
    this.camera.lookAt(this.lookTarget)
  }
}
```

- [ ] **Step 2: Rewire `src/main.ts`**

Add the import at the top with the other local imports:

```ts
import { GameCamera } from './camera'
```

Delete this block (currently after the `keydown`/`keyup` listeners):

```ts
let camYaw = 0
const CAM_OFFSET = new THREE.Vector3()
const CAM_TARGET = new THREE.Vector3()
camera.position.set(0, 12, 14)
```

Replace it with:

```ts
const gameCamera = new GameCamera(camera)
```

Replace the entire animation loop with:

```ts
const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05)

  player.update(dt, keys, gameCamera.yaw)
  remotes.update(dt)
  gameCamera.update(dt, keys, player)

  renderer.render(scene, camera)
})
```

Known, accepted nuance: Q/E used to be applied *before* `player.update` in the same frame; now the yaw the player reads is one frame stale. At 60fps that is ≤0.04 rad and imperceptible. Everything else (constants 2.2/9/6/2/8, lerp style, look height) is byte-identical behavior.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS (both typechecks + vite build). If `THREE` is now unused in `main.ts`, the build will say so — it is still used (`THREE.WebGLRenderer`, `THREE.Scene`, etc.), so no import changes are needed.

- [ ] **Step 4: Manual verification — behavior unchanged**

Run: `npm run dev`, open http://localhost:5173.
Expected: identical to before this task — WASD moves relative to camera, Q/E orbit the camera around the character, Space jumps, camera trails the player smoothly. Nothing new on screen.

- [ ] **Step 5: Commit**

```bash
git add src/camera.ts src/main.ts
git commit -m "refactor: extract orbit camera into GameCamera module"
```

---

### Task 2: Settings module — store, gear button, panel, switch

**Files:**
- Create: `src/settings.ts`
- Modify: `src/main.ts` (one import + one call)

**Interfaces:**
- Consumes: nothing from other tasks (standalone module; DOM + localStorage only).
- Produces (Task 3 relies on these exact names):
  - `interface Settings { cameraFollow: boolean }`
  - `initSettings(): Settings` — builds the DOM once, returns the live mutable object

- [ ] **Step 1: Create `src/settings.ts`**

```ts
// Player-local settings. initSettings() returns a live object the game loop
// reads every frame; the panel (gear button or Esc) mutates it in place and
// persists it to localStorage. Local-only — never sent over the network.

export interface Settings {
  cameraFollow: boolean
}

const STORAGE_KEY = 'shared-game.settings'

function load(): Settings {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')
    const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
    return { cameraFollow: obj.cameraFollow === true }
  } catch {
    return { cameraFollow: false }
  }
}

function persist(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Storage unavailable (private mode); the switch still works this session.
  }
}

export function initSettings(): Settings {
  const settings = load()

  const style = document.createElement('style')
  style.textContent = `
    #settings-gear, #settings-panel {
      position: fixed;
      right: 12px;
      font: 12px monospace;
      color: rgba(255, 255, 255, 0.75);
      background: rgba(0, 0, 0, 0.55);
      border: 2px solid rgba(255, 255, 255, 0.28);
      border-radius: 0;
    }
    #settings-gear {
      top: 8px;
      width: 26px;
      height: 26px;
      padding: 0;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
    }
    #settings-gear:hover, #settings-gear.open {
      color: #fff;
      border-color: rgba(255, 255, 255, 0.6);
    }
    #settings-panel {
      top: 40px;
      width: 210px;
      padding: 8px 10px;
    }
    #settings-title {
      color: #fff;
      margin-bottom: 8px;
    }
    .settings-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .settings-switch {
      flex: none;
      width: 34px;
      height: 16px;
      padding: 1px;
      background: rgba(0, 0, 0, 0.6);
      border: 2px solid rgba(255, 255, 255, 0.28);
      border-radius: 0;
      cursor: pointer;
      display: inline-flex;
      justify-content: flex-start;
    }
    .settings-switch.on {
      justify-content: flex-end;
      border-color: #4f9e3f;
    }
    .settings-knob {
      width: 10px;
      height: 10px;
      background: #9a9aa2;
    }
    .settings-switch.on .settings-knob {
      background: #4f9e3f;
    }
    #settings-gear:focus-visible, .settings-switch:focus-visible {
      outline: 2px solid #fff;
    }
  `
  document.head.appendChild(style)

  const gear = document.createElement('button')
  gear.id = 'settings-gear'
  gear.type = 'button'
  gear.textContent = '⚙'
  gear.setAttribute('aria-label', 'Settings')

  const panel = document.createElement('div')
  panel.id = 'settings-panel'
  panel.hidden = true

  const title = document.createElement('div')
  title.id = 'settings-title'
  title.textContent = 'settings'

  const row = document.createElement('div')
  row.className = 'settings-row'

  const label = document.createElement('span')
  label.textContent = 'camera always behind me'

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'settings-switch'
  toggle.setAttribute('role', 'switch')

  const knob = document.createElement('span')
  knob.className = 'settings-knob'
  toggle.appendChild(knob)

  const sync = (): void => {
    toggle.classList.toggle('on', settings.cameraFollow)
    toggle.setAttribute('aria-checked', String(settings.cameraFollow))
  }
  sync()

  toggle.addEventListener('click', () => {
    settings.cameraFollow = !settings.cameraFollow
    persist(settings)
    sync()
    // Drop focus so Space stays the jump key instead of re-clicking the switch.
    toggle.blur()
  })

  const setOpen = (open: boolean): void => {
    panel.hidden = !open
    gear.classList.toggle('open', open)
  }
  gear.addEventListener('click', () => {
    setOpen(panel.hidden)
    gear.blur()
  })
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') setOpen(panel.hidden)
  })

  row.append(label, toggle)
  panel.append(title, row)
  document.body.append(gear, panel)

  return settings
}
```

- [ ] **Step 2: Wire into `src/main.ts`**

Add the import with the other local imports:

```ts
import { initSettings } from './settings'
```

Add this line directly after the `const remotes = new Remotes(scene)` line:

```ts
initSettings()
```

Deliberately unbound: `tsconfig.json` has `noUnusedLocals`, so `const settings = initSettings()` would fail the build until Task 3 actually reads it. Task 3 adds the binding.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Manual verification — panel works, camera untouched**

Run: `npm run dev`, open http://localhost:5173. Check all of:

- Gear button (⚙) sits top-right; status text top-left is unobstructed.
- Clicking the gear opens the panel: "settings" title, "camera always behind me" row, chunky square switch. Clicking again closes it. Esc opens/closes it too.
- Clicking the switch: knob jumps right and turns grass-green, border turns green (no animation — instant jump is intentional). Clicking again: back to gray/left.
- After toggling, press Space: the character jumps; the switch does NOT flip again (blur() works).
- Reload the page: the switch remembers its state. In devtools → Application → Local Storage, key `shared-game.settings` holds `{"cameraFollow":true}` or `{"cameraFollow":false}`.
- Camera/gameplay behavior is completely unchanged regardless of the switch (it isn't wired to anything yet).

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts src/main.ts
git commit -m "feat: settings panel with camera follow switch (not yet wired)"
```

---

### Task 3: Follow behavior — camera eases in behind the moving character

**Files:**
- Modify: `src/player.ts` (add public `moving` flag)
- Modify: `src/camera.ts` (follow logic + new `settings` parameter)
- Modify: `src/main.ts` (bind `settings`, pass it to the camera)

**Interfaces:**
- Consumes: `GameCamera` from Task 1 (`update`, `yaw`), `Settings`/`initSettings` from Task 2, `Player` from `src/player.ts`.
- Produces (final public surface):
  - `Player.moving: boolean` — true iff there was WASD input this frame (jumping in place does not set it)
  - `GameCamera.update(dt: number, keys: Set<string>, player: Player, settings: Settings): void`

- [ ] **Step 1: Expose `moving` on `Player` in `src/player.ts`**

Add a public field under `group`:

```ts
export class Player {
  group: THREE.Group
  moving = false // WASD input this frame? The follow cam only recenters while true.
```

At the bottom of `update`, set it from the existing local `moving` (which is `1` only when there was WASD input), just before the `animateCharacter` call:

```ts
    this.moving = moving === 1
    animateCharacter(this.group, this.walkPhase, moving)
```

- [ ] **Step 2: Add follow logic to `src/camera.ts`**

Add to the imports:

```ts
import type { Settings } from './settings'
```

Add with the other constants (spec: slower than the character's own turn rate of 12, so the camera trails rather than snaps):

```ts
const FOLLOW_RATE = 4
```

Change the `update` signature and insert the follow block directly after the Q/E lines:

```ts
  update(dt: number, keys: Set<string>, player: Player, settings: Settings): void {
    if (keys.has('KeyQ')) this.camYaw += ORBIT_SPEED * dt
    if (keys.has('KeyE')) this.camYaw -= ORBIT_SPEED * dt

    // Follow cam: while the player moves, ease in behind the character
    // (their yaw + π), taking the short way around. Q/E peeks still work —
    // this pull just wins over time. Standing still, a peek sticks.
    if (settings.cameraFollow && player.moving) {
      const behind = player.group.rotation.y + Math.PI
      const delta = Math.atan2(Math.sin(behind - this.camYaw), Math.cos(behind - this.camYaw))
      this.camYaw += delta * Math.min(1, FOLLOW_RATE * dt)
    }
```

(The rest of `update` is unchanged.)

- [ ] **Step 3: Bind settings in `src/main.ts`**

Change the Task 2 line:

```ts
initSettings()
```

to:

```ts
const settings = initSettings()
```

and pass it to the camera in the animation loop:

```ts
  gameCamera.update(dt, keys, player, settings)
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Manual verification — the full feature**

Run: `npm run dev`, open http://localhost:5173. Check all of:

- Switch OFF: exactly today's behavior. Q/E orbit freely; camera yaw never moves on its own.
- Switch ON, run forward then turn with A/D-steered movement: the camera swings around to sit behind the character, trailing it smoothly (never snapping).
- Switch ON, hold Q while running: the view rotates while held (peek), and when released the camera glides back behind the character.
- Switch ON, stand still, press Q/E: the peeked angle sticks (no recentering). Start moving: camera swings back behind.
- Switch ON, jump in place (Space, no WASD): camera does not recenter mid-air.
- Flip the switch mid-game: takes effect immediately, no reload.
- Multiplayer sanity: open a second tab — both players see each other move normally; one tab's switch has no effect on the other tab.

- [ ] **Step 6: Commit**

```bash
git add src/player.ts src/camera.ts src/main.ts
git commit -m "feat: follow cam - camera eases in behind the moving character"
```
