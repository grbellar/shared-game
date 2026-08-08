// Persistent per-character identity, stored in this browser's localStorage.
// Minted on first visit: a secret token (the save key — never broadcast it or
// use it as a visible id) plus a random name and color that now stick across
// reloads. Equipped loadout is remembered too. Local-only for now; the token
// is the key a future server-side save (DO storage) would look records up by.

import { SKIN_IDS } from './skins'

export interface Profile {
  token: string
  name: string
  color: string
  weapon: string
  ride: string
  skin: string
  material: number
  voice: boolean
}

const STORAGE_KEY = 'shared-game.profile'

const NAMES = ['Goober', 'Turnip', 'Moose', 'Bandit', 'Noodle', 'Crouton', 'Gremlin', 'Pebble', 'Sprout', 'Wizard']
const COLORS = ['#e23b3b', '#3b6fe2', '#2fa84f', '#e2a53b', '#9b4fd4', '#e26fb0', '#33c2c2', '#c2e23b']

const WEAPONS = ['none', 'gun', 'sword', 'shovel', 'bow', 'builder', 'firework']
const RIDES = ['none', 'wheelchair', 'ramsey']

function mint(): Profile {
  return {
    token: crypto.randomUUID(),
    name: `${NAMES[Math.floor(Math.random() * NAMES.length)]}${Math.floor(Math.random() * 90) + 10}`,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    weapon: 'none',
    ride: 'none',
    skin: 'none',
    material: 0,
    voice: true, // proximity voice chat defaults ON; V mutes
  }
}

export function loadProfile(): Profile {
  const fresh = mint()
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')
    const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
    const profile: Profile = {
      token: typeof obj.token === 'string' && obj.token ? obj.token : fresh.token,
      name: typeof obj.name === 'string' && obj.name ? obj.name.slice(0, 24) : fresh.name,
      color: typeof obj.color === 'string' && /^#[0-9a-f]{6}$/i.test(obj.color) ? obj.color : fresh.color,
      weapon: WEAPONS.includes(obj.weapon as string) ? (obj.weapon as string) : 'none',
      ride: RIDES.includes(obj.ride as string) ? (obj.ride as string) : 'none',
      skin: SKIN_IDS.includes(obj.skin as string) ? (obj.skin as string) : 'none',
      material:
        typeof obj.material === 'number' && obj.material >= 0 && obj.material <= 3
          ? Math.floor(obj.material)
          : 0,
      voice: obj.voice !== false, // absence means on
    }
    saveProfile(profile) // heal partial/corrupt records, persist first-run mints
    return profile
  } catch {
    saveProfile(fresh)
    return fresh
  }
}

export function saveProfile(profile: Profile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile))
  } catch {
    // Storage unavailable (private mode); you're a tourist this session.
  }
}
