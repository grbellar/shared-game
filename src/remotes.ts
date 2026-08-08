import * as THREE from 'three'
import { createCharacter, animateCharacter } from './character'
import type { PlayerState } from './net'

interface Remote {
  group: THREE.Group
  target: { x: number; y: number; z: number; ry: number }
  walkPhase: number
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
      remote = { group, target: { x: p.x, y: p.y, z: p.z, ry: p.ry }, walkPhase: 0 }
      this.players.set(p.id, remote)
    }
    remote.target = { x: p.x, y: p.y, z: p.z, ry: p.ry }
  }

  remove(id: string): void {
    const remote = this.players.get(id)
    if (!remote) return
    this.scene.remove(remote.group)
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
      remote.walkPhase += dt * 11 * moving
      animateCharacter(group, remote.walkPhase, moving)
    }
  }
}
