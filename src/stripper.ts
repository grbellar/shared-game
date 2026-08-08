import * as THREE from 'three'
import { type Bubbles } from './bubbles'
import { animateCharacter, createCharacter, makeNameTag, startJabber, type Rig } from './character'
import { heightAt } from './world'

// Scandalous Sandy is intentionally local-only. She is a harmless cosmetic
// NPC, and each client lets her trail whichever player is nearest on screen.
// That keeps her responsive without adding another multiplayer authority.

const WALK_SPEED = 0.9
const STOP_DISTANCE = 3.2
const CHAT_DISTANCE = 5.2
const CHAT_COOLDOWN = 12
const RETARGET_TIME = 0.75

export class Stripper {
  readonly group: THREE.Group
  private walkPhase = 0
  private retargetIn = 0
  private chatIn = 3
  private target: THREE.Vector3 | null = null
  private delta = new THREE.Vector3()

  constructor(
    scene: THREE.Scene,
    private bubbles: Bubbles,
  ) {
    this.group = buildSandy()
    this.group.position.set(8, heightAt(8, 6), 6)
    scene.add(this.group)
  }

  update(dt: number, people: THREE.Vector3[]): void {
    this.retargetIn -= dt
    if (this.retargetIn <= 0) {
      this.retargetIn = RETARGET_TIME
      this.target = this.nearest(people)
    }

    let moving = 0
    let distance = Infinity
    if (this.target) {
      this.delta.copy(this.target).sub(this.group.position)
      this.delta.y = 0
      distance = this.delta.length()
      if (distance > STOP_DISTANCE) {
        const step = Math.min(WALK_SPEED * dt, distance - STOP_DISTANCE)
        this.delta.multiplyScalar(1 / Math.max(distance, 0.0001))
        const nx = this.group.position.x + this.delta.x * step
        const nz = this.group.position.z + this.delta.z * step
        const ground = heightAt(nx, nz)
        // Sandy wears heels, not flippers. She waits at the shoreline.
        if (ground > -0.75) {
          this.group.position.set(nx, ground, nz)
          this.group.rotation.y = Math.atan2(this.delta.x, this.delta.z)
          moving = 1
          this.walkPhase += dt * 6
        }
      } else if (distance > 0.1) {
        this.group.rotation.y = Math.atan2(this.delta.x, this.delta.z)
      }
    }

    this.chatIn -= dt
    if (distance < CHAT_DISTANCE && this.chatIn <= 0) {
      this.chatIn = CHAT_COOLDOWN
      this.bubbles.show(this.group, 'Hey, sugar… feeling lonely?')
      startJabber(this.group, 2200)
    }

    animateCharacter(this.group, dt, this.walkPhase, moving)
    scandalousStrut(this.group, moving)
  }

  private nearest(people: THREE.Vector3[]): THREE.Vector3 | null {
    let nearest: THREE.Vector3 | null = null
    let best = Infinity
    for (const person of people) {
      const dx = person.x - this.group.position.x
      const dz = person.z - this.group.position.z
      const d = dx * dx + dz * dz
      if (d < best) {
        best = d
        nearest = person
      }
    }
    return nearest
  }
}

function buildSandy(): THREE.Group {
  const group = createCharacter('#f5a0bd', 'Scandalous Sandy')
  const rig = group.userData.rig as Rig
  const skin = new THREE.MeshLambertMaterial({ color: 0xd99a78, flatShading: true })
  const pink = new THREE.MeshLambertMaterial({ color: 0xff218c, flatShading: true })
  const black = new THREE.MeshLambertMaterial({ color: 0x21121f, flatShading: true })
  const blonde = new THREE.MeshLambertMaterial({ color: 0xffe36e, flatShading: true })
  const boa = new THREE.MeshLambertMaterial({ color: 0xff7fce, flatShading: true })

  rig.body.material = skin
  rig.head.material = skin
  rig.armL.material = skin
  rig.armR.material = skin
  rig.legL.material = black
  rig.legR.material = black

  const top = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.38, 0.56), pink)
  top.position.y = 1.38
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.55, 0.42, 4), pink)
  skirt.rotation.y = Math.PI / 4
  skirt.position.y = 0.78
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.1, 0.58), black)
  belt.position.y = 0.96

  // Big blocky platinum hair, with a high side ponytail for a readable
  // silhouette at the game's 320x240 render resolution.
  const hairBack = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.74, 0.26), blonde)
  hairBack.position.set(0, 1.91, -0.27)
  const fringe = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.2, 0.64), blonde)
  fringe.position.set(0, 2.22, 0)
  const pony = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.9, 5), blonde)
  pony.position.set(0.42, 2.18, -0.16)
  pony.rotation.z = -0.55

  // A feather boa made from chunky tufts. Geometry beats a texture here and
  // gives it the silly N64 costume-store look the rest of the game uses.
  for (let i = 0; i < 9; i++) {
    const a = -1.25 + (i / 8) * 2.5
    const tuft = new THREE.Mesh(new THREE.OctahedronGeometry(0.18, 0), boa)
    tuft.position.set(Math.sin(a) * 0.62, 1.6 - Math.cos(a) * 0.22, 0.18 + Math.cos(a) * 0.28)
    tuft.scale.set(1.2, 0.8, 0.8)
    group.add(tuft)
  }

  // Replace the ordinary tag with a wider one so the full stage name fits.
  const oldTag = group.getObjectByName('nametag')
  if (oldTag) group.remove(oldTag)
  const tag = makeNameTag('Scandalous Sandy')
  tag.scale.x = 4.6
  group.add(top, skirt, belt, hairBack, fringe, pony, tag)
  group.userData.sandy = { skirt }
  return group
}

function scandalousStrut(group: THREE.Group, moving: number): void {
  const rig = group.userData.rig as Rig
  const t = performance.now() / 1000
  const sass = Math.sin(t * (moving ? 6 : 2.5))
  rig.body.rotation.z = sass * (moving ? 0.1 : 0.04)
  rig.head.rotation.z = -rig.body.rotation.z * 0.7
  if (!moving) {
    rig.armL.rotation.z = -0.45
    rig.armR.rotation.z = 0.45
    rig.legL.rotation.z = 0.08
    rig.legR.rotation.z = -0.08
  }
}
