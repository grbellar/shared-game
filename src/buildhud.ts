import { MATERIALS } from './blocks'

// Material picker chips shown while the builder is equipped. Display-only:
// main.ts owns the 1-4 key handling and tells us what's selected.

export interface BuildHud {
  setVisible(v: boolean): void
  setMaterial(i: number): void
}

export function initBuildHud(): BuildHud {
  const style = document.createElement('style')
  style.textContent = `
    #build-hud {
      position: fixed;
      left: 50%;
      bottom: 34px;
      transform: translateX(-50%);
      display: none;
      gap: 6px;
      font: 12px monospace;
      pointer-events: none;
    }
    #build-hud.visible {
      display: flex;
    }
    .build-chip {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 4px 8px;
      color: rgba(255, 255, 255, 0.75);
      background: rgba(0, 0, 0, 0.55);
      border: 2px solid rgba(255, 255, 255, 0.28);
    }
    .build-chip.active {
      color: #fff;
      border-color: rgba(255, 255, 255, 0.85);
    }
    .build-swatch {
      width: 10px;
      height: 10px;
    }
  `
  document.head.appendChild(style)

  const hud = document.createElement('div')
  hud.id = 'build-hud'
  const chips = MATERIALS.map((mat, i) => {
    const chip = document.createElement('div')
    chip.className = 'build-chip'
    const swatch = document.createElement('span')
    swatch.className = 'build-swatch'
    swatch.style.background = `#${mat.debris.toString(16).padStart(6, '0')}`
    const label = document.createElement('span')
    label.textContent = `[${i + 1}] ${mat.name}`
    chip.append(swatch, label)
    hud.append(chip)
    return chip
  })
  document.body.append(hud)

  const setMaterial = (active: number): void => {
    chips.forEach((chip, i) => chip.classList.toggle('active', i === active))
  }
  setMaterial(0)

  return {
    setVisible: (v) => hud.classList.toggle('visible', v),
    setMaterial,
  }
}
