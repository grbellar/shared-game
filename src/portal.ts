import * as THREE from 'three'
import { heightAt } from './world'
import { REALM_GROUND, REALM_X, REALM_Z } from './realm'

// Two standing stones and a hole in the world. The island gate sits on the
// central hill; its twin stands on the road below Blackstone Keep. Walking
// into either one puts you down in front of the other.
//
// There is no realm field in the protocol and no second scene: the two places
// are 1800 units apart in the same world, which is past the fog wall and past
// the camera's far plane, so they simply can't see each other. Everyone stays
// in the same room, in the same block grid, on the same chat.

const TRIGGER_R = 2.3
const COOLDOWN = 1.4 // seconds of immunity after a crossing, so you don't bounce
// How far in front of the destination gate you land. Has to clear the chase
// camera's own 9 units of setback, or you arrive with the gate you just came
// out of filling the screen instead of the view you came to see.
const EXIT_STEP = 13

export interface Gate {
  name: string
  x: number
  z: number
  y: number
  // Where you land and which way you face when you arrive here.
  exitZ: number
  exitRy: number
}

const ISLAND: Gate = {
  name: 'THE ISLAND',
  x: 0,
  z: 0,
  y: 0,
  exitZ: -EXIT_STEP,
  exitRy: Math.PI, // step out looking south, down the hill
}

const SHADOW: Gate = {
  name: 'BLACKSTONE KEEP',
  x: REALM_X,
  z: REALM_Z - 78, // far enough down the road that the whole keep clears the wall
  y: REALM_GROUND,
  exitZ: EXIT_STEP,
  exitRy: 0, // step out facing the castle
}

// A 64px swirl: concentric arcs of violet on black, spun and scrolled at
// runtime. Same rule as the block textures — canvas only, nearest filtered.
function makeSwirlTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#12021f'
  ctx.fillRect(0, 0, 64, 64)
  const bands = ['#3d0a63', '#5c1492', '#7a1fc4', '#a83ce8', '#d977ff']
  for (let i = 0; i < bands.length; i++) {
    ctx.strokeStyle = bands[i]
    ctx.lineWidth = 3
    ctx.beginPath()
    // Arcs of shrinking radius, each swept a bit further round: a spiral
    // without doing spiral maths.
    ctx.arc(32, 32, 28 - i * 5, i * 1.1, i * 1.1 + 4.2)
    ctx.stroke()
  }
  ctx.fillStyle = '#ffd9ff'
  ctx.fillRect(30, 30, 4, 4)
  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.center.set(0.5, 0.5)
  return texture
}

interface Built {
  gate: Gate
  swirl: THREE.Mesh
  texture: THREE.CanvasTexture
  light: THREE.PointLight
  motes: THREE.Mesh[]
}

export class Portals {
  private built: Built[] = []
  private cooldown = 0
  private t = 0

  constructor(scene: THREE.Scene) {
    ISLAND.y = heightAt(ISLAND.x, ISLAND.z)
    this.built.push(this.build(scene, ISLAND), this.build(scene, SHADOW))
  }

  private build(scene: THREE.Scene, gate: Gate): Built {
    const group = new THREE.Group()
    group.position.set(gate.x, gate.y, gate.z)
    const obsidian = new THREE.MeshLambertMaterial({ color: 0x1b1226, flatShading: true })
    const rune = new THREE.MeshLambertMaterial({
      color: 0x2a0b45,
      emissive: 0x9a3ce0,
      flatShading: true,
    })

    const dais = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.9, 0.7, 8), obsidian)
    dais.position.y = -0.2
    const step = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.6, 0.4, 8), obsidian)
    step.position.y = 0.3
    group.add(dais, step)

    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 8.4, 1.2), obsidian)
      pillar.position.set(side * 2.7, 4.4, 0)
      group.add(pillar)
      for (let i = 0; i < 3; i++) {
        const glyph = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 1.35), rune)
        glyph.position.set(side * 2.7, 2 + i * 2.1, 0)
        group.add(glyph)
      }
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(7.2, 1.3, 1.6), obsidian)
    lintel.position.y = 9.1
    const capstone = new THREE.Mesh(new THREE.ConeGeometry(1.5, 2, 4), rune)
    capstone.position.y = 10.6
    group.add(lintel, capstone)

    const texture = makeSwirlTexture()
    const swirl = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 7.6),
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
      }),
    )
    swirl.position.y = 4.5
    group.add(swirl)

    // A shaft of light so you can find the gate from across the map. Fog is
    // off on it deliberately — that's the whole point of a beacon.
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.4, 170, 6, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xb457ff,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      }),
    )
    beam.position.y = 86
    group.add(beam)

    const light = new THREE.PointLight(0xa64bff, 3.2, 26, 1.6)
    light.position.y = 4.5
    group.add(light)

    const motes: THREE.Mesh[] = []
    const moteMat = new THREE.MeshBasicMaterial({ color: 0xd9a3ff })
    for (let i = 0; i < 10; i++) {
      const mote = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.18), moteMat)
      mote.userData.phase = (i / 10) * Math.PI * 2
      group.add(mote)
      motes.push(mote)
    }

    scene.add(group)
    return { gate, swirl, texture, light, motes }
  }

  // Advance the animation and report a crossing. Returns the gate you came
  // out of, or null.
  update(dt: number, pos: THREE.Vector3): Gate | null {
    this.t += dt
    this.cooldown = Math.max(0, this.cooldown - dt)
    for (const b of this.built) {
      b.texture.rotation += dt * 0.55
      b.texture.offset.y -= dt * 0.22
      const pulse = 0.78 + 0.14 * Math.sin(this.t * 3.1)
      ;(b.swirl.material as THREE.MeshBasicMaterial).opacity = pulse
      b.light.intensity = 2.4 + 1.2 * Math.sin(this.t * 2.3)
      for (const mote of b.motes) {
        const phase = (mote.userData.phase as number) + this.t * 0.8
        const rise = ((this.t * 1.3 + (mote.userData.phase as number)) % 6.3) / 6.3
        mote.position.set(Math.cos(phase) * 2.9, 0.4 + rise * 8.6, Math.sin(phase) * 1.1)
      }
    }
    if (this.cooldown > 0) return null

    for (let i = 0; i < this.built.length; i++) {
      const { gate } = this.built[i]
      const dx = pos.x - gate.x
      const dz = pos.z - gate.z
      if (dx * dx + dz * dz > TRIGGER_R * TRIGGER_R) continue
      if (Math.abs(pos.y - gate.y) > 5) continue
      this.cooldown = COOLDOWN
      return this.built[1 - i].gate
    }
    return null
  }

  // Arriving without walking through a gate (respawning out of the lava, say)
  // still needs the bounce guard.
  hold(): void {
    this.cooldown = COOLDOWN
  }
}
