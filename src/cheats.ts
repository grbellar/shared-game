import * as THREE from 'three'
import { forEachCharacter, characterCount, type Rig } from './character'
import { setGravityScale } from './player'
import type { Effects } from './effects'

// Chat cheat codes, the way N64 games did it.
//
// No new protocol: chat is already relayed to the whole room, so a code typed
// by anyone is parsed by everyone and toggles for everyone. Type it again to
// turn it off. main.ts swallows the message so the code shows up as a banner
// instead of a chat bubble.

export const CHEATS = ['bighead', 'dkmode', 'moonjump', 'paintball', 'ghost'] as const
export type CheatName = (typeof CHEATS)[number]

const BANNERS: Record<CheatName, [string, string]> = {
  bighead: ['BIG HEAD MODE', 'big head mode off'],
  dkmode: ['DK MODE', 'dk mode off'],
  moonjump: ['MOON JUMP', 'gravity restored'],
  paintball: ['PAINTBALL MODE', 'paintball mode off'],
  ghost: ['GHOST MODE', 'ghost mode off'],
}

export class Cheats {
  private on = new Set<CheatName>()
  private lastCount = -1

  constructor(private effects: Effects) {}

  // Does this chat line look like a code? Returns the cheat, or null.
  parse(text: string): CheatName | null {
    const word = text.trim().toLowerCase().replace(/\s+/g, '')
    return (CHEATS as readonly string[]).includes(word) ? (word as CheatName) : null
  }

  isOn(name: CheatName): boolean {
    return this.on.has(name)
  }

  // Flip a cheat. Returns the banner text to show.
  toggle(name: CheatName): { on: boolean; banner: string } {
    const on = !this.on.has(name)
    if (on) this.on.add(name)
    else this.on.delete(name)
    this.refresh()
    return { on, banner: BANNERS[name][on ? 0 : 1] }
  }

  // Called every frame. Cheap no-op unless the cast changed — a player
  // joining mid-cheat has to get the same treatment as everyone else.
  update(): void {
    if (characterCount() !== this.lastCount) this.refresh()
  }

  private refresh(): void {
    this.lastCount = characterCount()
    const big = this.on.has('bighead')
    const dk = this.on.has('dkmode')
    const ghost = this.on.has('ghost')

    forEachCharacter((group) => {
      const rig = group.userData.rig as Rig | undefined
      if (!rig) return
      // Heads: huge for bighead, shrunken for DK (DK wins the argument).
      rig.head.scale.setScalar(dk ? 0.55 : big ? 2.6 : 1)
      // DK arms: long and heavy. Scaling Y only, since the arm geometry is
      // already translated to pivot at the shoulder.
      const armY = dk ? 2.1 : 1
      rig.armL.scale.set(dk ? 1.5 : 1, armY, dk ? 1.5 : 1)
      rig.armR.scale.copy(rig.armL.scale)

      if (group.userData.ghosted !== ghost) {
        group.userData.ghosted = ghost
        group.traverse((obj) => {
          if (!(obj instanceof THREE.Mesh)) return
          const mat = obj.material as THREE.MeshLambertMaterial
          if (!mat || Array.isArray(mat)) return
          mat.transparent = ghost
          mat.opacity = ghost ? 0.35 : 1
          mat.needsUpdate = true
        })
      }
    })

    setGravityScale(this.on.has('moonjump') ? 0.28 : 1)
    this.effects.paintball = this.on.has('paintball')
  }
}
