// Player-local settings. initSettings() returns a live object the game loop
// reads every frame; the panel (gear button or Esc) mutates it in place and
// persists it to localStorage. Local-only — never sent over the network.

export interface Settings {
  cameraFollow: boolean
  firstPerson: boolean
}

const STORAGE_KEY = 'shared-game.settings'

function load(): Settings {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')
    const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
    return { cameraFollow: obj.cameraFollow === true, firstPerson: obj.firstPerson === true }
  } catch {
    return { cameraFollow: false, firstPerson: false }
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

  const makeRow = (id: string, text: string, key: keyof Settings): HTMLDivElement => {
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

    toggle.addEventListener('click', () => {
      settings[key] = !settings[key]
      persist(settings)
      sync()
      // Drop focus so Space stays the jump key instead of re-clicking the switch.
      toggle.blur()
    })

    // Clicking the label text toggles the switch too.
    label.addEventListener('click', () => toggle.click())

    row.append(label, toggle)
    return row
  }

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
    makeRow('settings-camera-follow-label', 'camera always behind me', 'cameraFollow'),
    makeRow('settings-first-person-label', 'first-person aim (with weapon)', 'firstPerson'),
  )
  document.body.append(gear, panel)

  return settings
}
