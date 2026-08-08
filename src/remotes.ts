import * as THREE from 'three'
import {
  createCharacter,
  animateCharacter,
  setWeapon,
  setRide,
  setHat,
  releaseCharacter,
  startSlash,
  popHead,
  type Pose,
} from './character'
import type { PlayerState } from './net'
import type { Effects } from './effects'

interface Remote {
  group: THREE.Group
  target: { x: number; y: number; z: number; ry: number }
  walkPhase: number
  pose: Pose
  weapon: string
  ride: string
  hat: string
  name: string
}

// Renders and interpolates the other players in the room.
export class Remotes {
  private players = new Map<string, Remote>()

  constructor(private scene: THREE.Scene) {}

  get count(): number {
    return this.players.size
  }

  upsert(p: PlayerState): void {
    let remote = this.players.get(p.id)
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
        hat: 'none',
        name: p.name,
      }
      this.players.set(p.id, remote)
    }
    remote.name = p.name
    remote.target = { x: p.x, y: p.y, z: p.z, ry: p.ry }
    remote.pose = p.pose ?? 'stand'
    const weapon =
      p.weapon === 'gun' || p.weapon === 'sword' || p.weapon === 'shovel' ? p.weapon : 'none'
    if (remote.weapon !== weapon) {
      remote.weapon = weapon
      setWeapon(remote.group, weapon)
    }
    const ride = p.ride === 'wheelchair' ? p.ride : 'none'
    if (remote.ride !== ride) {
      remote.ride = ride
      setRide(remote.group, ride)
    }
    const hat = typeof p.hat === 'string' ? p.hat : 'none'
    if (remote.hat !== hat) {
      remote.hat = hat
      setHat(remote.group, hat)
    }
  }

  // Who is wearing what, for the killboard badges.
  hats(): Map<string, string> {
    const map = new Map<string, string>()
    for (const [id, r] of this.players) map.set(id, r.hat)
    return map
  }

  getGroup(id: string): THREE.Group | undefined {
    return this.players.get(id)?.group
  }

  nameOf(id: string): string {
    return this.players.get(id)?.name ?? 'someone'
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

  // Positions rockets can collide with.
  targets(): { id: string; pos: THREE.Vector3 }[] {
    return [...this.players.entries()].map(([id, r]) => ({ id, pos: r.group.position }))
  }

  remove(id: string): void {
    const remote = this.players.get(id)
    if (!remote) return
    this.scene.remove(remote.group)
    releaseCharacter(remote.group)
    this.players.delete(id)
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
