// Player-local settings. initSettings() returns a live object the game loop
// reads every frame; the panel (gear button or Esc) mutates it in place and
// persists it to localStorage. Local-only — never sent over the network.

export interface Settings {
  cameraFollow: boolean
  firstPerson: boolean
  minimap: boolean
  clockRun: boolean // day/night cycle advances on its own
  timeOfDay: number // hours, 0-24; daynight.ts mutates this while clockRun is on
  music: boolean
  webcamFace: boolean
  webcamBar: boolean
  // Fired when the USER scrubs the time slider or flips the clock toggle
  // (not when the network updates them) — main.ts broadcasts the new clock.
  // fromToggle distinguishes "freeze/unfreeze now" from "jump to this time".
  onClockChange?: (fromToggle: boolean) => void
}

// Keys makeRow may bind — the boolean toggles only.
type BoolKey = { [K in keyof Settings]-?: Settings[K] extends boolean ? K : never }[keyof Settings]

// The character picker is profile-backed (skins.ts / profile.ts), not part of
// Settings — main.ts passes the options and current choice in, and gets the
// change callback out.
export interface CharacterPicker {
  current: string
  options: { id: string; label: string }[]
  onChange: (id: string) => void
}

// Rename field, also profile-backed. onChange returns the accepted name
// (trimmed/clamped, or the old one if the input was empty) so the field can
// snap back to what actually stuck.
export interface NameEditor {
  current: string
  onChange: (name: string) => string
}

const STORAGE_KEY = 'shared-game.settings'

function load(): Settings {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')
    const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
    return {
      cameraFollow: obj.cameraFollow === true,
      firstPerson: obj.firstPerson === true,
      // Minimap is on unless you turned it off.
      minimap: obj.minimap !== false,
      clockRun: obj.clockRun !== false,
      timeOfDay: typeof obj.timeOfDay === 'number' && isFinite(obj.timeOfDay) ? obj.timeOfDay : 10,
      // Music defaults on, so absence means true.
      music: obj.music !== false,
      // Restored from storage: main.ts restarts the camera on load (the
      // browser's permission prompt still gates it if access wasn't granted).
      webcamFace: obj.webcamFace === true,
      webcamBar: obj.webcamBar === true,
    }
  } catch {
    return {
      cameraFollow: false,
      firstPerson: false,
      minimap: true,
      clockRun: true,
      timeOfDay: 10,
      music: true,
      webcamFace: false,
      webcamBar: false,
    }
  }
}

function persist(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Storage unavailable (private mode); the switch still works this session.
  }
}

// Re-sync callbacks per row, so setSetting() can drive a switch from code
// (e.g. flipping the webcam back off when permission is denied).
const syncs = new Map<BoolKey, () => void>()
let live: Settings | null = null

export function setSetting(key: BoolKey, value: boolean): void {
  if (!live || live[key] === value) return
  live[key] = value
  persist(live)
  syncs.get(key)?.()
}

// onToggle fires when the player flips a switch (not for setSetting), for
// settings that need to do something rather than just be read each frame.
export function initSettings(
  character?: CharacterPicker,
  nameEditor?: NameEditor,
  onToggle: (key: BoolKey, value: boolean) => void = () => {},
): Settings {
  const settings = load()
  live = settings

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
      /* Above the minimap, which shares this corner on touch. */
      z-index: 5;
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
    .settings-row + .settings-row {
      margin-top: 6px;
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
    #settings-time-value {
      color: #fff;
    }
    #settings-time-slider {
      width: 100%;
      margin: 2px 0 0;
      accent-color: #4f9e3f;
    }
    #settings-skin {
      width: 118px;
      font: 11px monospace;
      color: #fff;
      background: rgba(0, 0, 0, 0.6);
      border: 2px solid rgba(255, 255, 255, 0.28);
      border-radius: 0;
    }
    #settings-skin:focus-visible {
      outline: 2px solid #fff;
    }
    #settings-name {
      width: 110px;
      font: 11px monospace;
      color: #fff;
      background: rgba(0, 0, 0, 0.6);
      border: 2px solid rgba(255, 255, 255, 0.28);
      border-radius: 0;
      padding: 2px 4px;
      outline: none;
    }
    #settings-name:focus {
      border-color: rgba(255, 255, 255, 0.6);
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

  const makeRow = (id: string, text: string, key: BoolKey): HTMLDivElement => {
    const row = document.createElement('div')
    row.className = 'settings-row'

    const label = document.createElement('span')
    label.id = id
    label.textContent = text

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'settings-switch'
    toggle.setAttribute('role', 'switch')
    toggle.setAttribute('aria-labelledby', label.id)

    const knob = document.createElement('span')
    knob.className = 'settings-knob'
    toggle.appendChild(knob)

    const sync = (): void => {
      toggle.classList.toggle('on', settings[key])
      toggle.setAttribute('aria-checked', String(settings[key]))
    }
    sync()
    syncs.set(key, sync)

    toggle.addEventListener('click', () => {
      settings[key] = !settings[key]
      persist(settings)
      sync()
      if (key === 'clockRun') settings.onClockChange?.(true)
      // Drop focus so Space stays the jump key instead of re-clicking the switch.
      toggle.blur()
      onToggle(key, settings[key])
    })

    // Clicking the label text toggles the switch too.
    label.addEventListener('click', () => toggle.click())

    row.append(label, toggle)
    return row
  }

  // Name field: rename yourself any time; commits on Enter or focus loss.
  const nameRow = document.createElement('div')
  nameRow.className = 'settings-row'
  if (nameEditor) {
    const nameLabel = document.createElement('span')
    nameLabel.textContent = 'name'
    const nameInput = document.createElement('input')
    nameInput.id = 'settings-name'
    nameInput.type = 'text'
    nameInput.maxLength = 24
    nameInput.value = nameEditor.current
    nameInput.setAttribute('aria-label', 'Player name')
    // Typing a name must not equip weapons or move the player: stop keys
    // from reaching the window-level game handlers (same trick as chat).
    nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') nameInput.blur()
    })
    nameInput.addEventListener('keyup', (e) => e.stopPropagation())
    nameInput.addEventListener('blur', () => {
      nameInput.value = nameEditor.onChange(nameInput.value)
    })
    nameRow.append(nameLabel, nameInput)
  } else {
    nameRow.hidden = true
  }

  // Character picker: a dropdown of skins from skins.ts.
  const charRow = document.createElement('div')
  charRow.className = 'settings-row'
  if (character) {
    const charLabel = document.createElement('span')
    charLabel.textContent = 'character'
    const select = document.createElement('select')
    select.id = 'settings-skin'
    select.setAttribute('aria-label', 'Character')
    for (const opt of character.options) {
      const option = document.createElement('option')
      option.value = opt.id
      option.textContent = opt.label
      select.appendChild(option)
    }
    select.value = character.current
    select.addEventListener('change', () => {
      character.onChange(select.value)
      // Drop focus so WASD/arrows go back to being game keys.
      select.blur()
    })
    charRow.append(charLabel, select)
  } else {
    charRow.hidden = true
  }

  // Time-of-day scrubber: live clock readout plus a slider over 0-24h.
  // While the clock runs, the readout (and idle slider) track game time.
  const fmtTime = (t: number): string => {
    const h = Math.floor(t) % 24
    const m = Math.floor((t % 1) * 60)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }
  const timeRow = document.createElement('div')
  timeRow.className = 'settings-row'
  const timeLabel = document.createElement('span')
  timeLabel.textContent = 'time of day'
  const timeValue = document.createElement('span')
  timeValue.id = 'settings-time-value'
  timeRow.append(timeLabel, timeValue)

  const slider = document.createElement('input')
  slider.type = 'range'
  slider.id = 'settings-time-slider'
  slider.min = '0'
  slider.max = '24'
  slider.step = '0.1'
  slider.setAttribute('aria-label', 'Time of day')
  let scrubbing = false
  slider.addEventListener('pointerdown', () => {
    scrubbing = true
  })
  window.addEventListener('pointerup', () => {
    scrubbing = false
  })
  slider.addEventListener('input', () => {
    settings.timeOfDay = parseFloat(slider.value) % 24
    persist(settings)
    settings.onClockChange?.(false)
  })
  // Drop focus after a scrub so WASD/Space go back to being game keys.
  slider.addEventListener('change', () => slider.blur())
  const syncTime = (): void => {
    timeValue.textContent = fmtTime(settings.timeOfDay)
    if (!scrubbing) slider.value = String(settings.timeOfDay % 24)
  }
  syncTime()
  setInterval(() => {
    if (!panel.hidden) syncTime()
  }, 250)

  // The running clock only persists on scrubs; catch it on the way out too.
  window.addEventListener('beforeunload', () => persist(settings))

  const setOpen = (open: boolean): void => {
    panel.hidden = !open
    gear.classList.toggle('open', open)
  }
  gear.addEventListener('click', () => {
    setOpen(panel.hidden)
    gear.blur()
  })
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && !e.repeat) setOpen(panel.hidden)
  })

  panel.append(
    title,
    nameRow,
    charRow,
    makeRow('settings-camera-follow-label', 'camera always behind me', 'cameraFollow'),
    makeRow('settings-first-person-label', 'first-person aim (with weapon)', 'firstPerson'),
    makeRow('settings-minimap-label', 'mini-map', 'minimap'),
    makeRow('settings-clock-run-label', 'day/night clock runs', 'clockRun'),
    timeRow,
    slider,
    makeRow('settings-music-label', 'music', 'music'),
    makeRow('settings-webcam-label', 'my webcam on my head', 'webcamFace'),
    makeRow('settings-webcam-bar-label', 'webcam strip along the top', 'webcamBar'),
  )
  document.body.append(gear, panel)

  return settings
}
