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
  startSlash,
  popHead,
  type Pose,
} from './character'
import { applySkin } from './skins'
import { emoteById } from './emotes'
import type { PlayerState } from './net'
import type { Effects } from './effects'

interface Remote {
  group: THREE.Group
  target: { x: number; y: number; z: number; ry: number }
  walkPhase: number
  pose: Pose
  weapon: string
  ride: string
  skin: string
  name: string
  emote: string
  color: string
}

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
        target: { x: p.x, y: p.y, z: p.z, ry: p.ry },
        walkPhase: 0,
        pose: 'stand',
        weapon: 'none',
        ride: 'none',
        skin: 'none',
        name: p.name,
        emote: 'none',
        color: p.color,
      }
      this.players.set(p.id, remote)
      const face = this.faces.get(p.id)
      if (face) setFace(group, face)
    }
    remote.target = { x: p.x, y: p.y, z: p.z, ry: p.ry }
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
      p.ride === 'wheelchair' || p.ride === 'ramsey' || p.ride === 'plane' ? p.ride : 'none'
    if (remote.ride !== ride) {
      remote.ride = ride
      setRide(remote.group, ride)
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

  // Whoever is currently mid rocket-trip, so main.ts can smoke behind them.
  // Derived entirely from the pose that already rides in `state` — a rocket
  // flight costs the network nothing beyond the position stream.
  flying(): THREE.Vector3[] {
    const out: THREE.Vector3[] = []
    for (const r of this.players.values()) {
      if (r.emote === 'rocketfly') out.push(r.group.position)
    }
    return out
  }

  nameOf(id: string): string {
    return this.players.get(id)?.name ?? '???'
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
    return [...this.players.entries()].map(([id, r]) => ({
      id,
      pos: r.group.position,
      color: r.color,
      talk: (r.group.userData.talk as number) ?? 0,
    }))
  }

  // Positions rockets can collide with.
  targets(): { id: string; pos: THREE.Vector3 }[] {
    return [...this.players.entries()].map(([id, r]) => ({ id, pos: r.group.position }))
  }

  // Groups arrows can stick into.
  stickTargets(): { id: string; group: THREE.Group }[] {
    return [...this.players.entries()].map(([id, r]) => ({ id, group: r.group }))
  }

  remove(id: string): void {
    const remote = this.players.get(id)
    if (!remote) return
    this.scene.remove(remote.group)
    this.players.delete(id)
    this.faces.delete(id)
  }

  clear(): void {
    for (const id of [...this.players.keys()]) this.remove(id)
  }

  update(dt: number): void {
    for (const remote of this.players.values()) {
      const { group, target } = remote
      const before = group.position.clone()
      const k = Math.min(1, 12 * dt)
      group.position.x += (target.x - group.position.x) * k
      group.position.y += (target.y - group.position.y) * k
      group.position.z += (target.z - group.position.z) * k
      const delta = Math.atan2(
        Math.sin(target.ry - group.rotation.y),
        Math.cos(target.ry - group.rotation.y),
      )
      group.rotation.y += delta * k
      const speed = group.position.distanceTo(before) / Math.max(dt, 1e-6)
      const moving = Math.min(1, speed / 3)
      // Swimmers keep paddling even when idle, matching the local player.
      remote.walkPhase += dt * (remote.pose === 'swim' ? 2.8 + 4.2 * moving : 11 * moving)
      animateCharacter(group, dt, remote.walkPhase, moving, remote.pose)
    }
  }
}
