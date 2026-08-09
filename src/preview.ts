// Live item previews for the radial wheels: the real in-game mesh, lit and
// turning in a tiny offscreen buffer, blitted into a per-wedge canvas that CSS
// upscales with nearest-neighbour. Same art direction as everything else —
// 64px of render, no image assets, no new geometry invented for the UI.
//
// One WebGL context is shared by every tile: each preview owns a scene and a
// camera, renders into the shared buffer, and copies the result out. Rendering
// only happens while a wheel is open (see `draw`), so a closed wheel costs
// nothing.

import * as THREE from 'three'
import {
  animateCharacter,
  buildBazooka,
  buildBow,
  buildBuilder,
  buildFirework,
  buildKatana,
  buildM2,
  buildShovel,
  buildSniper,
  createCharacter,
  disposeSubtree,
  setEmote,
  setRide,
  untrackCharacter,
} from './character'
import { emoteById } from './emotes'

const TILE = 64 // render buffer, in pixels — the chunky pixels are the look

let gl: THREE.WebGLRenderer | null = null

function sharedRenderer(): THREE.WebGLRenderer {
  if (!gl) {
    // preserveDrawingBuffer so drawImage can copy the frame out; on a 64px
    // buffer the cost of that is nothing.
    gl = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true })
    gl.setPixelRatio(1)
    gl.setSize(TILE, TILE, false)
    gl.setClearAlpha(0)
  }
  return gl
}

export class Preview {
  readonly canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100)
  private pivot = new THREE.Group()
  private framed = false
  private t = 0

  constructor(
    subject: THREE.Object3D,
    private spin: number, // radians per second of turntable
    private tilt: number, // starting yaw, for things that read best head-on
    private tick: (dt: number, t: number) => void = () => {},
    // Framing is measured once, on the first frame. A still object needs
    // almost none of this; anything that moves after that (a dancing doll, a
    // pair of wings) needs room to move into.
    private pad = 1.04,
  ) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = this.canvas.height = TILE
    this.ctx = this.canvas.getContext('2d')!
    this.pivot.add(subject)
    this.scene.add(this.pivot)
    // Lambert materials need light, and a thumbnail has no sky or ground
    // bouncing into it — so it gets a key, a fill from the other side, and a
    // hemisphere on top. Without the fill, a katana is a black stick.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x50556a, 1.3))
    const key = new THREE.DirectionalLight(0xfff0d8, 1.8)
    key.position.set(0.6, 1.2, 0.9)
    const fill = new THREE.DirectionalLight(0xc8d8ff, 0.9)
    fill.position.set(-0.8, 0.2, -0.6)
    this.scene.add(key, fill)
  }

  // Render one frame. Called by the wheel while it's open, at display rate.
  draw(dt: number): void {
    this.t += dt
    this.tick(dt, this.t)
    if (!this.framed) this.frame()
    this.pivot.rotation.y = this.tilt + this.t * this.spin
    const renderer = sharedRenderer()
    renderer.render(this.scene, this.camera)
    this.ctx.clearRect(0, 0, TILE, TILE)
    this.ctx.drawImage(renderer.domElement, 0, 0)
  }

  // Sit the subject on the pivot's origin and back the camera off far enough
  // to hold it. Deferred to the first draw so anything the tick poses (a
  // character's limbs, the X-wing's foils) is already in its resting shape.
  private frame(): void {
    this.framed = true
    const subject = this.pivot.children[0]
    const box = new THREE.Box3().setFromObject(subject)
    if (box.isEmpty()) return
    const center = box.getCenter(new THREE.Vector3())
    subject.position.sub(center)
    // Framed off the bounding sphere, so the turntable can't swing a rifle's
    // muzzle out of shot halfway round. Padding stays small: at 64px, every
    // pixel spent on margin is a pixel not spent on the thing.
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius
    const dist = (radius * this.pad) / Math.sin((this.camera.fov * Math.PI) / 360)
    this.camera.position.set(dist * 0.3, dist * 0.28, dist * 0.9)
    this.camera.lookAt(0, 0, 0)
  }

  dispose(): void {
    disposeSubtree(this.pivot)
  }
}

// A blocky stand-in wearing the player's own colour. The name tag is dead
// weight in a thumbnail (and a canvas texture per tile), so it goes; and the
// doll stays out of the character registry so cheats.ts never restyles it.
function doll(color: string): THREE.Group {
  const group = createCharacter(color, '')
  untrackCharacter(group)
  for (const child of [...group.children]) {
    if ((child as THREE.Sprite).isSprite) {
      disposeSubtree(child)
      group.remove(child)
    }
  }
  return group
}

// Poses the doll every frame so emotes play and wheels turn.
function animated(group: THREE.Group, moving: number): (dt: number, t: number) => void {
  let walk = 0
  return (dt) => {
    walk += dt * 6 * moving
    animateCharacter(group, dt, walk, moving)
  }
}

const HAND_MESH: Record<string, () => THREE.Object3D> = {
  gun: buildBazooka,
  sniper: buildSniper,
  m2: buildM2,
  sword: buildKatana,
  shovel: buildShovel,
  bow: buildBow,
  builder: buildBuilder,
  firework: buildFirework,
}

// What's in your hand: the weapon itself on a turntable, big enough to read.
// Empty hands are the one wedge with nothing to show, so they get the doll.
export function handPreview(weapon: string, color: string): Preview {
  const build = HAND_MESH[weapon]
  if (!build) {
    const group = doll(color)
    return new Preview(group, 0, 0.5, animated(group, 0), 1.15)
  }
  return new Preview(build(), 0.9, 0)
}

// How you get around: the doll sitting in it, wheels and limbs turning, so a
// wheelchair looks like a wheelchair and not a pile of tyres.
export function ridePreview(ride: string, color: string): Preview {
  const group = doll(color)
  setRide(group, ride)
  // Airborne, so the X-wing shows its S-foils open — the only shape anyone
  // recognises it by (see animateCharacter).
  if (ride === 'xwing') {
    group.userData.airborne = true
    group.userData.throttle = 0.6
  }
  return new Preview(group, 0.55, 0, animated(group, ride === 'none' ? 0 : 1), 1.15)
}

// An emote is a pose, so the preview is the doll actually playing it, looping
// for as long as the wheel is open.
export function emotePreview(emote: string, color: string): Preview {
  const group = doll(color)
  const pose = animated(group, 0)
  const seconds = emoteById(emote)?.seconds ?? 3
  let elapsed = seconds // start expired, so the first frame kicks it off
  return new Preview(
    group,
    0,
    0.45,
    (dt, t) => {
      elapsed += dt
      if (elapsed >= seconds) {
        elapsed = 0
        setEmote(group, emote)
      }
      pose(dt, t)
    },
    // Emotes throw arms and legs well outside a standing silhouette.
    1.35,
  )
}
