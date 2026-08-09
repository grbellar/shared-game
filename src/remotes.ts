import * as THREE from 'three'
import {
  createCharacter,
  animateCharacter,
  setWeapon,
  setRide,
  setName,
  setFace,
  setEmote,
  setLook,
  setHat,
  releaseCharacter,
  startSlash,
  popHead,
  type Pose,
} from './character'
import { applySkin } from './skins'
import { emoteById } from './emotes'
import { airborneAt } from './xwing'
import type { PlayerState } from './net'
import type { Effects } from './effects'

interface Remote {
  group: THREE.Group
  target: { x: number; y: number; z: number; ry: number; rx: number; rz: number }
  walkPhase: number
  pose: Pose
  weapon: string
  ride: string
  skin: string
  name: string
  emote: string
  color: string
  hat: string
}

// Scratch for update()'s speed measurement — one clone per remote per frame
// adds up to nothing but garbage.
const _before = new THREE.Vector3()

// Renders and interpolates the other players in the room.
export class Remotes {
  // Fired when a remote player hits the water (their pose flips to swim).
  onSplash: (x: number, z: number) => void = () => {}
  // Fires when someone starts an emote, so main.ts can play its sound.
  onEmote: (id: string, emote: string) => void = () => {}
  private players = new Map<string, Remote>()
  // Latest webcam frame per id, kept separately because a `face` message can
  // land before that player's first `state` creates their character.
  private faces = new Map<string, string>()
  // targets()/stickTargets()/blips() are read ~10x a frame (rockets, lasers,
  // the shark, mobs, skeletons, the minimap), so they hand out cached arrays
  // rebuilt only when a state message or a join/leave changes what's in them.
  // The positions inside are live references to each group, so a cached entry
  // never goes stale between rebuilds. Callers iterate or spread; none holds
  // an array across frames or mutates it.
  private targetsCache: { id: string; pos: THREE.Vector3; r?: number }[] = []
  private stickCache: { id: string; group: THREE.Group }[] = []
  private blipsCache: { id: string; pos: THREE.Vector3; color: string; talk: number }[] = []
  private cachesDirty = true

  constructor(private scene: THREE.Scene) {}

  get count(): number {
    return this.players.size
  }

  upsert(p: PlayerState): void {
    let remote = this.players.get(p.id)
    const isNew = !remote
    if (!remote) {
      const group = createCharacter(p.color, p.name)
      group.position.set(p.x, p.y, p.z)
      group.rotation.y = p.ry
      this.scene.add(group)
      remote = {
        group,
        target: { x: p.x, y: p.y, z: p.z, ry: p.ry, rx: 0, rz: 0 },
        walkPhase: 0,
        pose: 'stand',
        weapon: 'none',
        ride: 'none',
        skin: 'none',
        name: p.name,
        emote: 'none',
        color: p.color,
        hat: 'none',
      }
      this.players.set(p.id, remote)
      const face = this.faces.get(p.id)
      if (face) setFace(group, face)
    }
    // Older clients don't send rx/rz at all, so absence means level.
    remote.target = { x: p.x, y: p.y, z: p.z, ry: p.ry, rx: p.rx ?? 0, rz: p.rz ?? 0 }
    remote.color = p.color
    const pose = p.pose ?? 'stand'
    // Splash on the transition into water — but not for players who were
    // already swimming when we joined (the welcome replay).
    if (pose === 'swim' && remote.pose !== 'swim' && !isNew) this.onSplash(p.x, p.z)
    remote.pose = pose
    remote.group.userData.talk = p.talk ?? 0 // animateCharacter opens the mouth
    setLook(remote.group, p.hp ?? 0, p.hy ?? 0)
    const weapon =
      p.weapon === 'gun' ||
      p.weapon === 'sniper' ||
      p.weapon === 'sword' ||
      p.weapon === 'shovel' ||
      p.weapon === 'bow' ||
      p.weapon === 'builder' ||
      p.weapon === 'firework'
        ? p.weapon
        : 'none'
    if (remote.weapon !== weapon) {
      remote.weapon = weapon
      setWeapon(remote.group, weapon)
    }
    const ride =
      p.ride === 'wheelchair' || p.ride === 'ramsey' || p.ride === 'plane' || p.ride === 'xwing'
        ? p.ride
        : 'none'
    if (remote.ride !== ride) {
      remote.ride = ride
      setRide(remote.group, ride)
    }
    const hat = typeof p.hat === 'string' ? p.hat : 'none'
    if (remote.hat !== hat) {
      remote.hat = hat
      setHat(remote.group, hat)
    }
    // Unknown ids (older clients, garbage) just reset to the base look.
    const skin = p.skin ?? 'none'
    if (remote.skin !== skin) {
      remote.skin = skin
      applySkin(remote.group, skin)
    }
    // Renames redraw the floating tag.
    if (remote.name !== p.name) {
      remote.name = p.name
      setName(remote.group, p.name)
    }
    const emote = emoteById(p.emote) ? p.emote : 'none'
    if (remote.emote !== emote) {
      remote.emote = emote
      setEmote(remote.group, emote)
      if (emote !== 'none') this.onEmote(p.id, emote)
    }
    this.cachesDirty = true
  }

  getGroup(id: string): THREE.Group | undefined {
    return this.players.get(id)?.group
  }

  // Everyone in the room, for the map's pins.
  list(): { id: string; x: number; z: number; color: string; name: string }[] {
    return [...this.players.entries()].map(([id, r]) => ({
      id,
      x: r.group.position.x,
      z: r.group.position.z,
      color: r.color,
      name: r.name,
    }))
  }

  // Whoever is currently mid-flight, so main.ts can smoke behind them: under
  // rocket power, or out of the trebuchet. Derived entirely from the pose that
  // already rides in `state` — neither costs the network anything beyond the
  // position stream.
  flying(): THREE.Vector3[] {
    const out: THREE.Vector3[] = []
    for (const r of this.players.values()) {
      if (r.emote === 'rocketfly' || r.emote === 'slung') out.push(r.group.position)
    }
    return out
  }

  // Whoever else is sitting in the trebuchet's sling. Their facing is the
  // machine's aim (see trebuchet.ts), which is why this returns it — the frame
  // swings round on their streamed rotation without a message of its own.
  slingRider(): { ry: number } | undefined {
    for (const r of this.players.values()) {
      if (r.emote === 'slingride') return { ry: r.group.rotation.y }
    }
    return undefined
  }

  nameOf(id: string): string {
    return this.players.get(id)?.name ?? '???'
  }

  // Who is wearing what, for the killboard badges.
  hats(): Map<string, string> {
    const map = new Map<string, string>()
    for (const [id, r] of this.players) map.set(id, r.hat)
    return map
  }

  // Paint a webcam frame on a player's head; '' turns their camera off.
  setFace(id: string, dataUrl: string): void {
    if (dataUrl) this.faces.set(id, dataUrl)
    else this.faces.delete(id)
    const remote = this.players.get(id)
    if (remote) setFace(remote.group, dataUrl || null)
  }

  slash(id: string): void {
    const remote = this.players.get(id)
    if (remote) startSlash(remote.group)
  }

  decapitate(id: string, effects: Effects): void {
    const remote = this.players.get(id)
    if (!remote) return
    const headPos = popHead(remote.group)
    if (headPos) effects.spawnHeadPop(headPos)
  }

  // Where everyone is, in their own colour, and how loudly they're talking
  // right now — for the minimap.
  blips(): { id: string; pos: THREE.Vector3; color: string; talk: number }[] {
    if (this.cachesDirty) this.refreshCaches()
    return this.blipsCache
  }

  // Positions rockets and laser bolts can collide with. `r` overrides the
  // caller's default hit radius — an X-wing is seven units of wingspan, and
  // at person-sized tolerances nobody could ever hit one.
  targets(): { id: string; pos: THREE.Vector3; r?: number }[] {
    if (this.cachesDirty) this.refreshCaches()
    return this.targetsCache
  }

  // Groups arrows can stick into.
  stickTargets(): { id: string; group: THREE.Group }[] {
    if (this.cachesDirty) this.refreshCaches()
    return this.stickCache
  }

  // Rebuild the three cached views in place, reusing the entry objects so a
  // busy room churns no garbage. Cheap enough to run per state message.
  private refreshCaches(): void {
    this.cachesDirty = false
    const n = this.players.size
    this.targetsCache.length = n
    this.stickCache.length = n
    this.blipsCache.length = n
    let i = 0
    for (const [id, r] of this.players) {
      const t = (this.targetsCache[i] ??= { id: '', pos: r.group.position, r: undefined })
      t.id = id
      t.pos = r.group.position
      t.r = r.ride === 'xwing' ? 4.4 : undefined
      const s = (this.stickCache[i] ??= { id: '', group: r.group })
      s.id = id
      s.group = r.group
      const b = (this.blipsCache[i] ??= { id: '', pos: r.group.position, color: '', talk: 0 })
      b.id = id
      b.pos = r.group.position
      b.color = r.color
      b.talk = (r.group.userData.talk as number) ?? 0
      i++
    }
  }

  remove(id: string): void {
    const remote = this.players.get(id)
    if (!remote) return
    this.scene.remove(remote.group)
    releaseCharacter(remote.group)
    this.players.delete(id)
    this.faces.delete(id)
    this.cachesDirty = true
  }

  clear(): void {
    for (const id of [...this.players.keys()]) this.remove(id)
  }

  update(dt: number): void {
    for (const remote of this.players.values()) {
      const { group, target } = remote
      const before = _before.copy(group.position)
      const k = Math.min(1, 12 * dt)
      group.position.x += (target.x - group.position.x) * k
      group.position.y += (target.y - group.position.y) * k
      group.position.z += (target.z - group.position.z) * k
      const delta = Math.atan2(
        Math.sin(target.ry - group.rotation.y),
        Math.cos(target.ry - group.rotation.y),
      )
      group.rotation.y += delta * k
      // Pitch and roll never wrap (the flight model clamps them well inside
      // a half-turn), so they just chase their target.
      group.rotation.x += (target.rx - group.rotation.x) * k
      group.rotation.z += (target.rz - group.rotation.z) * k
      const speed = group.position.distanceTo(before) / Math.max(dt, 1e-6)
      const moving = Math.min(1, speed / 3)
      // Whether their S-foils are open and their engines are lit is worked
      // out here rather than sent: the terrain under them is deterministic,
      // so every client agrees on who's off the ground. Same for the glow,
      // which just tracks how fast they're actually going.
      if (remote.ride === 'xwing') {
        group.userData.airborne = airborneAt(group.position.x, group.position.y, group.position.z)
        group.userData.throttle = Math.min(1, speed / 70)
      }
      // Swimmers keep paddling even when idle, matching the local player.
      remote.walkPhase += dt * (remote.pose === 'swim' ? 2.8 + 4.2 * moving : 11 * moving)
      animateCharacter(group, dt, remote.walkPhase, moving, remote.pose)
    }
  }
}
