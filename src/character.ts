import * as THREE from 'three'
import { applyEmote, clearEmotePose } from './emotes'
import { buildXWing, poseXWing } from './xwing'

export type Pose = 'stand' | 'crouch' | 'swim'

// Every live character (local + remotes), so cheats.ts can restyle everyone
// at once without threading a registration callback through main.ts.
const registry = new Set<THREE.Group>()

export function forEachCharacter(fn: (group: THREE.Group) => void): void {
  registry.forEach(fn)
}

export function characterCount(): number {
  return registry.size
}

// Free everything a subtree holds on the GPU: geometries, materials (arrays
// included), and any texture in material.map. Disposing a resource something
// else still shares is safe in three.js — it just re-uploads on next use.
export function disposeSubtree(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (!mat) return
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      ;(m as THREE.MeshLambertMaterial).map?.dispose()
      m.dispose()
    }
  })
}

// Drop a character from the registry when it leaves the scene, and free what
// it holds on the GPU — the nametag sprite's canvas texture rides along in
// the traverse, and the webcam face texture hides in userData when the
// camera is off.
export function releaseCharacter(group: THREE.Group): void {
  registry.delete(group)
  disposeSubtree(group)
  const face = group.userData.face as { texture: THREE.Texture; mat: THREE.Material } | undefined
  face?.texture.dispose()
  face?.mat.dispose()
}

// Blocky N64-style character. Front of the character faces +Z.
// Limbs pivot at the hip/shoulder and are stashed in userData so
// animateCharacter can pose them.
export function createCharacter(color: string, name: string): THREE.Group {
  const group = new THREE.Group()
  const bodyMat = new THREE.MeshLambertMaterial({ color })
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x33333a })
  const skinMat = new THREE.MeshLambertMaterial({ color: 0xe0b088 })

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 0.5), bodyMat)
  body.position.y = 1.1

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), skinMat)
  head.name = 'head'
  head.position.y = 1.95
  head.rotation.order = 'YXZ' // turn, then tilt — a head, not a gimbal
  const eyeGeo = new THREE.BoxGeometry(0.09, 0.12, 0.05)
  const eyeMat = new THREE.MeshLambertMaterial({ color: 0x111111 })
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat)
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat)
  eyeL.name = eyeR.name = 'eye'
  eyeL.position.set(-0.14, 0.05, 0.31)
  eyeR.position.set(0.14, 0.05, 0.31)
  // Mouth: a dark slot that animateCharacter scales open while the player
  // talks (voice level synced in state) or jabbers out a chat message.
  const mouth = new THREE.Mesh(
    new THREE.BoxGeometry(0.26, 0.14, 0.05),
    new THREE.MeshLambertMaterial({ color: 0x5a1f1f }),
  )
  mouth.position.set(0, -0.16, 0.3)
  mouth.scale.y = 0.22
  head.add(eyeL, eyeR, mouth)

  const legGeo = new THREE.BoxGeometry(0.3, 0.6, 0.3)
  legGeo.translate(0, -0.3, 0) // pivot at the hip
  const legL = new THREE.Mesh(legGeo, darkMat)
  const legR = new THREE.Mesh(legGeo, darkMat)
  legL.position.set(-0.22, 0.6, 0)
  legR.position.set(0.22, 0.6, 0)

  const armGeo = new THREE.BoxGeometry(0.22, 0.7, 0.22)
  armGeo.translate(0, -0.35, 0) // pivot at the shoulder
  const armL = new THREE.Mesh(armGeo, bodyMat)
  const armR = new THREE.Mesh(armGeo, bodyMat)
  armL.position.set(-0.55, 1.6, 0)
  armR.position.set(0.55, 1.6, 0)

  // Yaw first, then pitch, so an emote's forward tilt (see emotes.ts) stays
  // forward no matter which way the character is facing.
  group.rotation.order = 'YXZ'
  group.add(body, head, legL, legR, armL, armR)
  group.add(makeNameTag(name))
  group.userData.rig = { body, head, legL, legR, armL, armR, mouth }
  group.userData.anim = { crouch: 0, swim: 0, mouth: 0, foils: 0 }
  group.userData.look = { pitch: 0, yaw: 0, tPitch: 0, tYaw: 0 }
  group.userData.baseColor = color // skins.ts resets to this when undressing
  registry.add(group)
  return group
}

// How far the head can crane before the body has to do the work.
const HEAD_PITCH_LIMIT = 1.2
const HEAD_YAW_LIMIT = 1.0

interface Look {
  pitch: number
  yaw: number
  tPitch: number
  tYaw: number
}

// Aim the head where the player is looking. `pitch` is up-positive radians;
// `yaw` is an offset from the body's facing (the body handles big turns, the
// head covers the rest). Clamped here, so values off the wire are safe.
export function setLook(group: THREE.Group, pitch: number, yaw: number): void {
  const look = group.userData.look as Look | undefined
  if (!look) return
  look.tPitch = clampAngle(pitch, HEAD_PITCH_LIMIT)
  // Wrap first: a yaw offset of 350° is really -10°.
  look.tYaw = clampAngle(Math.atan2(Math.sin(yaw), Math.cos(yaw)), HEAD_YAW_LIMIT)
}

// Current (eased) head aim — main.ts puts this on the wire.
export function getLook(group: THREE.Group): { pitch: number; yaw: number } {
  const look = group.userData.look as Look | undefined
  return { pitch: look?.pitch ?? 0, yaw: look?.yaw ?? 0 }
}

function clampAngle(v: number, limit: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(-limit, Math.min(limit, v))
}

export interface Rig {
  body: THREE.Mesh
  head: THREE.Mesh
  legL: THREE.Mesh
  legR: THREE.Mesh
  armL: THREE.Mesh
  armR: THREE.Mesh
  mouth: THREE.Mesh
}

export function animateCharacter(
  group: THREE.Group,
  dt: number,
  walkPhase: number,
  moving: number,
  pose: Pose = 'stand',
): void {
  const rig = group.userData.rig as Rig
  const anim = group.userData.anim as {
    crouch: number
    swim: number
    mouth: number
    foils: number
  }
  const ride = group.userData.ride as string | undefined
  const riding =
    ride === 'wheelchair' || ride === 'ramsey' || ride === 'plane' || ride === 'xwing'
  const k = Math.min(1, 10 * dt)
  anim.crouch += ((pose === 'crouch' && !riding ? 1 : 0) - anim.crouch) * k
  anim.swim += ((pose === 'swim' && !riding ? 1 : 0) - anim.swim) * k
  const { crouch, swim } = anim

  // Ease the head toward where the player is looking (see setLook) so network
  // jitter and mouse flicks don't snap the neck. The pose itself is applied
  // below, after the emote block — clearEmotePose wipes head rotation.
  const look = group.userData.look as Look
  const lk = Math.min(1, 14 * dt)
  look.pitch += (look.tPitch - look.pitch) * lk
  look.yaw += (look.tYaw - look.yaw) * lk

  // Squat: body and head drop, legs squash so the feet stay planted.
  rig.body.position.y = 1.1 - 0.3 * crouch
  rig.head.position.y = 1.95 - 0.5 * crouch
  rig.legL.position.y = rig.legR.position.y = 0.6 - 0.3 * crouch
  rig.legL.scale.y = rig.legR.scale.y = 1 - 0.5 * crouch
  rig.armL.position.y = rig.armR.position.y = 1.6 - 0.3 * crouch

  const stride = Math.sin(walkPhase) * 0.8 * moving * (1 - 0.55 * crouch)
  if (ride === 'wheelchair') {
    // Sitting: legs out to the footrest, hands down on the push rims.
    rig.legL.rotation.x = -1.35
    rig.legR.rotation.x = -1.35
    rig.legL.rotation.z = 0
    rig.legR.rotation.z = 0
    rig.armL.rotation.x = -0.6
    rig.armR.rotation.x = -0.6
    rig.armL.rotation.z = 0
    rig.armR.rotation.z = 0
    const wheels = group.userData.rideWheels as THREE.Group[] | undefined
    if (wheels) for (const wheel of wheels) wheel.rotation.x = walkPhase * 1.5
  } else if (ride === 'plane') {
    // In the cockpit: legs down the footwell, both hands forward on the stick.
    rig.legL.rotation.x = -1.35
    rig.legR.rotation.x = -1.35
    rig.legL.rotation.z = 0
    rig.legR.rotation.z = 0
    rig.armL.rotation.x = -1.05
    rig.armR.rotation.x = -1.05
    rig.armL.rotation.z = 0.2
    rig.armR.rotation.z = -0.2
    // The prop never stops (the engine idles), and opens up with the throttle.
    const prop = group.userData.rideProp as THREE.Object3D | undefined
    if (prop) prop.rotation.z += dt * (14 + 55 * moving)
    const wheels = group.userData.rideWheels as THREE.Group[] | undefined
    if (wheels) for (const wheel of wheels) wheel.rotation.x = walkPhase * 1.5
  } else if (ride === 'ramsey') {
    // Straddling Ramsey's back: legs forward and spread down his sides,
    // hands gripping his shoulders.
    rig.legL.rotation.x = -0.9
    rig.legR.rotation.x = -0.9
    rig.legL.rotation.z = 0.45
    rig.legR.rotation.z = -0.45
    rig.armL.rotation.x = -0.8
    rig.armR.rotation.x = -0.8
    rig.armL.rotation.z = 0.15
    rig.armR.rotation.z = -0.15
    // Ramsey bounds like a dog: front limbs together, hind limbs opposite.
    const limbs = group.userData.rideLimbs as
      | { frontL: THREE.Mesh; frontR: THREE.Mesh; hindL: THREE.Mesh; hindR: THREE.Mesh }
      | undefined
    if (limbs) {
      const bound = Math.sin(walkPhase) * 0.7 * moving
      limbs.frontL.rotation.x = bound
      limbs.frontR.rotation.x = bound
      limbs.hindL.rotation.x = -bound
      limbs.hindR.rotation.x = -bound
    }
  } else if (ride === 'xwing') {
    // Down in the cockpit: knees up under the console, hands on the stick.
    rig.legL.rotation.x = -1.5
    rig.legR.rotation.x = -1.5
    rig.legL.rotation.z = 0.12
    rig.legR.rotation.z = -0.12
    rig.armL.rotation.x = -1.35
    rig.armR.rotation.x = -1.35
    rig.armL.rotation.z = 0.2
    rig.armR.rotation.z = -0.2
    // S-foils and exhausts. `airborne` is set by whoever owns this character
    // — main.ts for us, remotes.ts for everyone else, both working it out
    // from the ground under the ship rather than from a message. The ease is
    // what makes the wings *unfold* instead of snapping open.
    const ship = group.userData.rideShip as THREE.Group | undefined
    const up = (group.userData.airborne as boolean | undefined) ? 1 : 0
    anim.foils += (up - anim.foils) * Math.min(1, 2.6 * dt)
    if (ship) {
      const heat = (group.userData.throttle as number | undefined) ?? (up ? 0.5 : 0)
      poseXWing(ship, anim.foils, anim.foils * (0.25 + 0.75 * heat))
    }
  } else {
    // Legs: stride on land (shorter while crouched), flutter kick in water.
    const kick = Math.sin(walkPhase * 2.6) * (0.35 + 0.25 * moving)
    rig.legL.rotation.x = stride * (1 - swim) + kick * swim
    rig.legR.rotation.x = -stride * (1 - swim) - kick * swim
    rig.legL.rotation.z = 0
    rig.legR.rotation.z = 0

    // Arms: swing opposite the legs on land, windmill a front crawl in water.
    // Wrapped to one turn so blending in/out of swim doesn't pinwheel forever.
    const stroke = -(walkPhase % (Math.PI * 2))
    rig.armL.rotation.x = -stride * 0.7 * (1 - swim) + stroke * swim
    rig.armR.rotation.x = stride * 0.7 * (1 - swim) + (stroke + Math.PI) * swim
    // Flare the arms out a touch when squatting or paddling.
    rig.armL.rotation.z = -(0.4 * crouch + 0.25 * swim)
    rig.armR.rotation.z = 0.4 * crouch + 0.25 * swim
  }

  // Mouth: opens with the synced voice level (userData.talk) and flaps
  // through the tail of a text chat message (userData.jabberUntil). Fast
  // attack, so a shout lands on the right frame; closed is a thin line.
  const now = performance.now()
  let open = (group.userData.talk as number | undefined) ?? 0
  const jabberUntil = (group.userData.jabberUntil as number | undefined) ?? 0
  if (now < jabberUntil) {
    const fade = Math.min(1, (jabberUntil - now) / 600)
    open = Math.max(open, (0.3 + 0.7 * Math.abs(Math.sin(now / 70))) * fade)
  }
  anim.mouth += (Math.min(1, open) - anim.mouth) * Math.min(1, 20 * dt)
  rig.mouth.scale.y = 0.22 + 1.3 * anim.mouth
  rig.mouth.position.y = -0.16 - 0.06 * anim.mouth // jaw drops as it opens

  // Weapon overrides for the right arm.
  const weapon = group.userData.weapon as string | undefined
  if (weapon === 'gun' || weapon === 'sniper' || weapon === 'm2' || weapon === 'bow') {
    // Held steady out front, following the shoulder down through a squat.
    const held = group.getObjectByName('weapon')
    if (held) {
      const mount = (held.userData.mountY as number) ?? (weapon === 'gun' ? 1.8 : 1.5)
      held.position.y = mount - 0.3 * crouch
    }
    rig.armR.rotation.x = Math.PI / 2
    rig.armR.rotation.z = 0
    // Sniper: the off hand comes up to cradle the fore-end.
    if (weapon === 'sniper') {
      rig.armL.rotation.x = -1.15
      rig.armL.rotation.z = -0.35
    }
  } else if (
    weapon === 'sword' ||
    weapon === 'shovel' ||
    weapon === 'builder' ||
    weapon === 'firework'
  ) {
    const t = (performance.now() - ((group.userData.attackStart as number) ?? 0)) / 1000
    if (t < SLASH_DURATION) {
      // Overhead chop: wind up behind the head, slice down past the knees.
      // Doubles as the shovel's dig scoop and the firework's plant.
      rig.armR.rotation.x = -2.8 + (t / SLASH_DURATION) * 3.6
      rig.armR.rotation.z = 0
    } else if (!riding) {
      rig.armR.rotation.x = -0.25 + stride * 0.3
      rig.armR.rotation.z = 0
    }
  }

  // Emotes pose last so they win over the walk cycle and the weapon arm.
  // They tilt the whole group forward, so clearEmotePose zeroes the group's
  // pitch — which is also where a flying X-wing keeps its nose attitude.
  // Hold onto it and put it back below, or a remote fighter's dive is wiped
  // every frame, one line after remotes.ts interpolated it in.
  const flightPitch = ride === 'xwing' ? group.rotation.x : 0
  clearEmotePose(group, rig)
  const emote = group.userData.emote as string | undefined
  if (emote) {
    const t = (performance.now() - ((group.userData.emoteStart as number) ?? 0)) / 1000
    applyEmote(group, rig, emote, t, riding)
  } else {
    // Head aim goes on after clearEmotePose so it isn't wiped, and yields to
    // an emote's canned head pose while one is playing. The lift keeps the
    // tilted cube's bottom corner out of the shoulders.
    rig.head.rotation.x = -look.pitch // front is +Z, so negative X tips the face up
    rig.head.rotation.y = look.yaw
    rig.head.position.y += 0.07 * Math.abs(look.pitch)
  }
  if (ride === 'xwing') group.rotation.x = flightPitch
}

// Start (or clear, with 'none') an emote on a character. Synced via the
// `emote` field in PlayerState; each client runs its own animation clock.
export function setEmote(group: THREE.Group, emote: string): void {
  group.userData.emote = emote === 'none' ? undefined : emote
  group.userData.emoteStart = performance.now()
}

export const SLASH_DURATION = 0.3

export function startSlash(group: THREE.Group): void {
  group.userData.attackStart = performance.now()
}

// Flap the mouth for a while — used when a text chat message goes out, so
// characters visibly "say" what lands in their speech bubble.
export function startJabber(group: THREE.Group, durationMs = 1800): void {
  group.userData.jabberUntil = performance.now() + durationMs
}

// Hide the head for the death window and return where it was (world space)
// so effects can send a copy flying. Returns null if already headless.
export function popHead(group: THREE.Group): THREE.Vector3 | null {
  const head = group.getObjectByName('head')
  if (!head || !head.visible) return null
  head.visible = false
  setTimeout(() => (head.visible = true), 2600)
  return group.position.clone().add(new THREE.Vector3(0, 1.95, 0))
}

const FACE_PX = 64

interface FaceStore {
  ctx: CanvasRenderingContext2D
  texture: THREE.CanvasTexture
  mat: THREE.MeshLambertMaterial
  skin: THREE.Material
  blocky: THREE.Object3D[] // the painted-on eyes and mouth
  img: HTMLImageElement
  url: string | null // last frame shown, so refreshFace can re-assert it
}

// Paint a webcam frame (a JPEG data URL from webcam.ts) on the front of the
// head, or pass null to go back to the blocky face. Synced over the network
// via `face` messages, not PlayerState — frames are far too big to ride along
// at the state rate.
export function setFace(group: THREE.Group, dataUrl: string | null): void {
  const head = group.getObjectByName('head') as THREE.Mesh | undefined
  if (!head) return
  let store = group.userData.face as FaceStore | undefined

  if (!dataUrl) {
    if (!store || store.url === null) return
    head.material = store.skin
    for (const part of store.blocky) part.visible = true
    store.url = null
    return
  }

  if (!store) {
    // One canvas + texture per character, reused for every frame: repainting
    // is a texture upload, not a new GPU allocation every 200ms.
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = FACE_PX
    const texture = new THREE.CanvasTexture(canvas)
    texture.minFilter = THREE.NearestFilter
    texture.magFilter = THREE.NearestFilter
    texture.generateMipmaps = false
    const s: FaceStore = {
      ctx: canvas.getContext('2d')!,
      texture,
      mat: new THREE.MeshLambertMaterial({ map: texture }),
      skin: head.material as THREE.Material,
      url: null,
      blocky: [
        ...head.children.filter((c) => c.name === 'eye'),
        (group.userData.rig as { mouth?: THREE.Mesh }).mouth,
      ].filter(Boolean) as THREE.Object3D[],
      img: new Image(),
    }
    s.img.onload = () => {
      s.ctx.drawImage(s.img, 0, 0, FACE_PX, FACE_PX)
      s.texture.needsUpdate = true
    }
    store = s
    group.userData.face = s
  }

  // Re-read the head material every time: applySkin swaps in a fresh one, so
  // a stored reference goes stale the moment someone changes outfit.
  const current = head.material
  const skin = (Array.isArray(current) ? current[0] : current) as THREE.Material
  store.skin = skin
  // The character faces +Z, which is BoxGeometry's 5th material slot. The
  // other five stay skin so the head keeps its flat-shaded sides.
  head.material = [skin, skin, skin, skin, store.mat, skin]
  // Hide the stick-on eyes and mouth: they poke out past the front face and
  // would float in front of the real ones. animateCharacter keeps posing the
  // mouth underneath, so it animates again the moment the camera goes off.
  for (const part of store.blocky) part.visible = false
  store.url = dataUrl
  store.img.src = dataUrl
}

// Re-assert the webcam face after something rebuilt the head material —
// applySkin throws the old one away, which would otherwise drop the face
// until the next captured frame (and never, for a remote who stopped moving).
// No-op when the camera is off.
export function refreshFace(group: THREE.Group): void {
  const store = group.userData.face as FaceStore | undefined
  if (store?.url) setFace(group, store.url)
}

// Equip 'gun' (shoulder bazooka), 'sniper' (scoped rifle, also at the
// shoulder), 'sword' (katana in the right hand), 'shovel', 'builder' or
// 'firework' (also right hand), or 'none'. Synced over the network via the
// `weapon` field in PlayerState.
export function setWeapon(group: THREE.Group, weapon: string): void {
  const existing = group.getObjectByName('weapon')
  if (existing) {
    disposeSubtree(existing)
    existing.parent!.remove(existing)
  }
  group.userData.weapon = weapon
  const armR = (group.userData.rig as { armR: THREE.Mesh }).armR
  if (weapon === 'gun') {
    group.add(buildBazooka())
  } else if (weapon === 'm2') {
    group.add(buildM2())
  } else if (weapon === 'sniper') {
    group.add(buildSniper())
  } else if (weapon === 'sword') {
    armR.add(buildKatana())
  } else if (weapon === 'shovel') {
    armR.add(buildShovel())
  } else if (weapon === 'bow') {
    const bow = buildBow()
    // The bow is built facing -Z (camera-space for the first-person view);
    // the character faces +Z, so spin it around and hold it out front.
    bow.rotation.y = Math.PI
    bow.position.set(0.3, 1.5, 0.35)
    group.add(bow)
  } else if (weapon === 'builder') {
    armR.add(buildBuilder())
  } else if (weapon === 'firework') {
    armR.add(buildFirework())
  }
}

// Buried-treasure loot (and the duck's revenge). Synced via the `hat` field
// in PlayerState so everyone sees what you dug up. Parented to the head, so
// hats crouch, decapitate and big-head along with it — and survive a skin
// change, since applySkin only clears children named 'skinparts'.
export type Hat = 'none' | 'crown' | 'wizard' | 'cone' | 'tinfoil' | 'pirate' | 'bucket' | 'duck'

export function setHat(group: THREE.Group, hat: string): void {
  const head = (group.userData.rig as Rig | undefined)?.head
  if (!head) return
  const existing = head.getObjectByName('hat')
  if (existing) {
    disposeSubtree(existing)
    existing.parent!.remove(existing)
  }
  group.userData.hat = hat
  const built = buildHat(hat as Hat)
  if (built) head.add(built)
}

function buildHat(hat: Hat): THREE.Group | null {
  const group = new THREE.Group()
  group.name = 'hat'
  const mat = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true })

  if (hat === 'crown') {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.14, 8), mat(0xe8c14a))
    band.position.y = 0.37
    group.add(band)
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 4), mat(0xe8c14a))
      spike.position.set(Math.sin(a) * 0.24, 0.51, Math.cos(a) * 0.24)
      group.add(spike)
    }
  } else if (hat === 'wizard') {
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.04, 10), mat(0x4b2c8f))
    brim.position.y = 0.32
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.7, 7), mat(0x5c37ad))
    cone.position.y = 0.68
    const star = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), mat(0xffe066))
    star.position.set(0, 0.62, 0.22)
    star.rotation.set(0.6, 0.6, 0)
    group.add(brim, cone, star)
  } else if (hat === 'cone') {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.5), mat(0xe2621f))
    base.position.y = 0.33
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.55, 6), mat(0xe2621f))
    cone.position.y = 0.62
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.21, 0.09, 6), mat(0xf0f0f0))
    band.position.y = 0.58
    group.add(base, cone, band)
  } else if (hat === 'tinfoil') {
    const foil = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.44, 5), mat(0xc9ced6))
    foil.position.y = 0.5
    foil.rotation.set(0.14, 0.4, 0.1)
    const crumple = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.16), mat(0xdfe4ea))
    crumple.position.set(0.09, 0.66, -0.05)
    crumple.rotation.set(0.5, 0.3, 0.4)
    group.add(foil, crumple)
  } else if (hat === 'pirate') {
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.07, 0.44), mat(0x17181c))
    brim.position.y = 0.34
    const crown = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.22, 0.34), mat(0x17181c))
    crown.position.y = 0.46
    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.03), mat(0xf2f2f2))
    skull.position.set(0, 0.46, 0.18)
    group.add(brim, crown, skull)
  } else if (hat === 'bucket') {
    const pail = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.26, 0.46, 8), mat(0x8d949e))
    pail.position.y = 0.28
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.05, 8), mat(0x6f757e))
    rim.position.y = 0.06
    group.add(pail, rim)
  } else if (hat === 'duck') {
    // The duck you killed, riding your skull forever.
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.2, 0.36), mat(0xf7f4ea))
    body.position.y = 0.42
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.17, 0.17), mat(0xf7f4ea))
    head.position.set(0, 0.6, 0.11)
    const beak = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.13), mat(0xf0a02a))
    beak.position.set(0, 0.57, 0.24)
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.04), mat(0x111111))
    eye.position.set(0, 0.64, 0.18)
    group.add(body, head, beak, eye)
  } else {
    return null
  }
  return group
}

// Mount or dismount a ride: 'wheelchair', 'ramsey' (a guy you ride like a
// horse), 'plane' or 'xwing'. Synced via the `ride` field in PlayerState.
// The character sits on (or in) it — see animateCharacter.
export function setRide(group: THREE.Group, ride: string): void {
  const existing = group.getObjectByName('ride')
  if (existing) {
    disposeSubtree(existing)
    existing.parent!.remove(existing)
  }
  group.userData.ride = ride
  delete group.userData.rideWheels
  delete group.userData.rideLimbs
  delete group.userData.rideProp
  delete group.userData.rideShip
  if (ride === 'wheelchair') {
    const chair = buildWheelchair()
    group.add(chair)
    group.userData.rideWheels = chair.userData.wheels
  } else if (ride === 'ramsey') {
    const ramsey = buildRamsey()
    group.add(ramsey)
    group.userData.rideLimbs = ramsey.userData.limbs
  } else if (ride === 'plane') {
    const plane = buildPlane()
    group.add(plane)
    group.userData.rideWheels = plane.userData.wheels
    group.userData.rideProp = plane.userData.prop
  } else if (ride === 'xwing') {
    const ship = buildXWing()
    group.add(ship)
    group.userData.rideShip = ship
  }
  liftNameTag(group)
}

// Cherry-red open-cockpit prop plane, built around the seated rider (who
// faces +Z, so the nose and prop are out front at +Z). Low wing under the
// seat, tail boom out the back, fixed gear so it can taxi. The prop group
// spins about Z (see animateCharacter).
function buildPlane(): THREE.Group {
  const plane = new THREE.Group()
  plane.name = 'ride'
  const red = new THREE.MeshLambertMaterial({ color: 0xc23b3b, flatShading: true })
  const cream = new THREE.MeshLambertMaterial({ color: 0xe8dfc4, flatShading: true })
  const dark = new THREE.MeshLambertMaterial({ color: 0x22252a, flatShading: true })
  const rubber = new THREE.MeshLambertMaterial({ color: 0x3a3d44, flatShading: true })

  // Nose ahead of the footwell, engine cowl on the front of it.
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.75, 1.3), red)
  nose.position.set(0, 0.75, 1.25)
  const cowl = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.25), dark)
  cowl.position.set(0, 0.75, 2.0)
  // Cockpit tub: floor under the feet, walls beside the hips, seat back.
  const floor = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.1, 1.2), red)
  floor.position.set(0, 0.32, 0)
  const wallL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.55, 1.2), red)
  const wallR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.55, 1.2), red)
  wallL.position.set(-0.49, 0.72, 0)
  wallR.position.set(0.49, 0.72, 0)
  const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.75, 0.12), red)
  seatBack.position.set(0, 0.85, -0.62)
  // Tail boom tapering back to the empennage.
  const boom = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 1.7), red)
  boom.position.set(0, 0.8, -1.5)
  const stab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 0.55), cream)
  stab.position.set(0, 0.9, -2.25)
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.75, 0.55), cream)
  fin.position.set(0, 1.3, -2.3)
  // One low wing straddling the cockpit.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.12, 1.05), cream)
  wing.position.set(0, 0.45, 0.35)
  plane.add(nose, cowl, floor, wallL, wallR, seatBack, boom, stab, fin, wing)

  // Propeller: spinner cone plus two blades, hung off the cowl.
  const prop = new THREE.Group()
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.3, 6).rotateX(Math.PI / 2), dark)
  spinner.position.z = 0.18
  const bladeA = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.5, 0.06), dark)
  const bladeB = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.14, 0.06), dark)
  prop.add(spinner, bladeA, bladeB)
  prop.position.set(0, 0.75, 2.15)
  plane.add(prop)

  // Fixed gear: two mains under the wing, a little tail wheel.
  const wheels: THREE.Group[] = []
  for (const side of [-1, 1]) {
    const wheel = new THREE.Group()
    const tire = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 0.12, 8).rotateZ(Math.PI / 2),
      rubber,
    )
    wheel.add(tire)
    wheel.position.set(side * 0.75, 0.22, 0.7)
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.3, 0.07), dark)
    strut.position.set(side * 0.75, 0.4, 0.7)
    plane.add(wheel, strut)
    wheels.push(wheel)
  }
  const tailWheel = new THREE.Group()
  tailWheel.add(
    new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 8).rotateZ(Math.PI / 2), rubber),
  )
  tailWheel.position.set(0, 0.11, -2.1)
  plane.add(tailWheel)
  wheels.push(tailWheel)

  plane.userData.wheels = wheels
  plane.userData.prop = prop
  return plane
}

// Ramsey: a loyal guy on all fours you ride like a horse. Dark gray tee,
// jeans, and his signature black flat-top army cap. His back lines up with
// the rider's seat; limbs pivot at the shoulder/hip so he can bound (see
// animateCharacter).
function buildRamsey(): THREE.Group {
  const ramsey = new THREE.Group()
  ramsey.name = 'ride'
  const tee = new THREE.MeshLambertMaterial({ color: 0x4a4a50 })
  const jeans = new THREE.MeshLambertMaterial({ color: 0x3d4f73 })
  const skin = new THREE.MeshLambertMaterial({ color: 0xe0b088 })

  // Horizontal torso, back at seat height (the rider's hips sit at 0.6).
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 1.1), tee)
  torso.position.set(0, 0.4, -0.05)

  // Head up at the front, watching where he's galloping.
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.55), skin)
  head.position.set(0, 0.75, 0.6)
  const eyeGeo = new THREE.BoxGeometry(0.09, 0.12, 0.05)
  const eyeMat = new THREE.MeshLambertMaterial({ color: 0x111111 })
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat)
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat)
  eyeL.position.set(-0.13, 0.02, 0.29)
  eyeR.position.set(0.13, 0.02, 0.29)
  head.add(eyeL, eyeR)
  head.add(buildArmyCap())

  // Front limbs are arms (tee sleeves), hind limbs are jean legs. All pivot
  // at the top so the bound swings them from the shoulder/hip.
  const frontGeo = new THREE.BoxGeometry(0.2, 0.52, 0.2)
  frontGeo.translate(0, -0.26, 0)
  const frontL = new THREE.Mesh(frontGeo, tee)
  const frontR = new THREE.Mesh(frontGeo, tee)
  frontL.position.set(-0.24, 0.5, 0.42)
  frontR.position.set(0.24, 0.5, 0.42)
  const hindGeo = new THREE.BoxGeometry(0.26, 0.5, 0.26)
  hindGeo.translate(0, -0.25, 0)
  const hindL = new THREE.Mesh(hindGeo, jeans)
  const hindR = new THREE.Mesh(hindGeo, jeans)
  hindL.position.set(-0.22, 0.5, -0.5)
  hindR.position.set(0.22, 0.5, -0.5)

  ramsey.add(torso, head, frontL, frontR, hindL, hindR)
  ramsey.userData.limbs = { frontL, frontR, hindL, hindR }
  return ramsey
}

// Ramsey's black flat-top army cap: oval crown, stubby brim, and a tiny
// canvas-drawn KANGOL label on the front. Built in head-local space.
function buildArmyCap(): THREE.Group {
  const cap = new THREE.Group()
  const cloth = new THREE.MeshLambertMaterial({ color: 0x1e1e22, flatShading: true })
  // Crown flares slightly outward toward the flat top, military-cadet style.
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.36, 0.24, 10), cloth)
  crown.position.y = 0.38
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.26), cloth)
  brim.position.set(0, 0.29, 0.42)
  brim.rotation.x = 0.18

  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 16
  const ctx = canvas.getContext('2d')!
  ctx.font = 'bold 11px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#d8c9a8'
  ctx.fillText('KANGOL', 32, 9)
  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(0.34, 0.085),
    new THREE.MeshLambertMaterial({ map: texture, transparent: true }),
  )
  label.position.set(0, 0.33, 0.39)

  cap.add(crown, brim, label)
  return cap
}

// Classic chrome-frame wheelchair. Big rear wheels with box spokes so the
// spin reads at 320x240; the whole wheel group rotates about X to roll.
function buildWheelchair(): THREE.Group {
  const chair = new THREE.Group()
  chair.name = 'ride'
  const chrome = new THREE.MeshLambertMaterial({ color: 0xb8bec8, flatShading: true })
  const dark = new THREE.MeshLambertMaterial({ color: 0x22252a, flatShading: true })
  const rubber = new THREE.MeshLambertMaterial({ color: 0x3a3d44, flatShading: true })

  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.6), dark)
  seat.position.set(0, 0.56, 0)
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 0.08), dark)
  back.position.set(0, 0.95, -0.34)
  const footrest = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 0.25), chrome)
  footrest.position.set(0, 0.16, 0.62)
  chair.add(seat, back, footrest)

  const wheels: THREE.Group[] = []
  for (const side of [-1, 1]) {
    const wheel = new THREE.Group()
    const tire = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.55, 0.09, 10).rotateZ(Math.PI / 2),
      rubber,
    )
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 0.12, 8).rotateZ(Math.PI / 2),
      chrome,
    )
    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.44, 0.44, 0.04, 10).rotateZ(Math.PI / 2),
      chrome,
    )
    rim.position.x = side * 0.09
    const spokeA = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.95, 0.07), chrome)
    const spokeB = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.07, 0.95), chrome)
    wheel.add(tire, hub, rim, spokeA, spokeB)
    wheel.position.set(side * 0.56, 0.55, -0.08)
    chair.add(wheel)
    wheels.push(wheel)
  }
  for (const side of [-1, 1]) {
    const caster = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.14, 0.08, 8).rotateZ(Math.PI / 2),
      rubber,
    )
    caster.position.set(side * 0.34, 0.14, 0.5)
    chair.add(caster)
  }
  chair.userData.wheels = wheels
  return chair
}

// Big tube resting on the right shoulder, pointing forward (+Z). The raised
// right arm (see animateCharacter) holds it up.
// Exported for firstperson.ts, which shows a second copy as the view model.
// The M2: a slab of a heavy machine gun. Long barrel with a jacket, a fat
// receiver, spade grips, and a belt of rounds hanging out of the feed tray.
export function buildM2(): THREE.Group {
  const gun = new THREE.Group()
  gun.name = 'weapon'
  const gunmetal = new THREE.MeshLambertMaterial({ color: 0x33383f, flatShading: true })
  const dark = new THREE.MeshLambertMaterial({ color: 0x1b1e22, flatShading: true })
  const brass = new THREE.MeshLambertMaterial({ color: 0xb08d3a, flatShading: true })

  const along = (geo: THREE.CylinderGeometry) => geo.rotateX(Math.PI / 2) // +Y -> +Z
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.34, 1.3), gunmetal)
  const barrel = new THREE.Mesh(along(new THREE.CylinderGeometry(0.09, 0.09, 1.7, 8)), dark)
  barrel.position.z = 1.4
  // Perforated cooling jacket, faked with two rings — cheaper than holes and
  // it reads fine at 320x240.
  for (const z of [0.95, 1.6]) {
    const ring = new THREE.Mesh(along(new THREE.CylinderGeometry(0.14, 0.14, 0.18, 8)), gunmetal)
    ring.position.z = z
    gun.add(ring)
  }
  const muzzle = new THREE.Mesh(along(new THREE.CylinderGeometry(0.15, 0.11, 0.22, 8)), dark)
  muzzle.position.z = 2.28
  // Spade grips at the back.
  const grips = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.26, 0.1), dark)
  grips.position.z = -0.72
  // The belt, drooping out of the left of the feed tray.
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.4, 0.5), brass)
  belt.position.set(-0.2, -0.22, 0.1)
  belt.rotation.z = 0.3
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 0.06), dark)
  sight.position.set(0, 0.26, 0.5)

  gun.add(receiver, barrel, muzzle, grips, belt, sight)
  gun.position.set(0.4, 1.75, 0.15)
  gun.userData.mountY = 1.75
  return gun
}

export function buildBazooka(): THREE.Group {
  {
    const gun = new THREE.Group()
    gun.name = 'weapon'
    const olive = new THREE.MeshLambertMaterial({ color: 0x55603a, flatShading: true })
    const dark = new THREE.MeshLambertMaterial({ color: 0x22252a, flatShading: true })
    const red = new THREE.MeshLambertMaterial({ color: 0xc23b3b, flatShading: true })

    const along = (geo: THREE.CylinderGeometry) => geo.rotateX(Math.PI / 2) // +Y -> +Z
    const tube = new THREE.Mesh(along(new THREE.CylinderGeometry(0.2, 0.2, 2.2, 8)), olive)
    const muzzle = new THREE.Mesh(along(new THREE.CylinderGeometry(0.32, 0.22, 0.4, 8)), dark)
    muzzle.position.z = 1.25
    const exhaust = new THREE.Mesh(along(new THREE.CylinderGeometry(0.22, 0.3, 0.35, 8)), dark)
    exhaust.position.z = -1.2
    const band = new THREE.Mesh(along(new THREE.CylinderGeometry(0.22, 0.22, 0.16, 8)), red)
    band.position.z = 0.75
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.22), dark)
    sight.position.set(0, 0.28, 0.25)
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.1), dark)
    grip.position.set(0, -0.32, 0.35)

    gun.add(tube, muzzle, exhaust, band, sight, grip)
    gun.position.set(0.38, 1.8, 0.1)
    gun.userData.mountY = 1.8 // animateCharacter drops this through a squat
    return gun
  }
}

// Bolt-action rifle with a big chunky scope, carried at the right shoulder
// like the bazooka and pointing forward (+Z). Long and thin so the
// silhouette reads as "sniper" even at 320x240.
// Exported for firstperson.ts, which shows a second copy as the view model.
export function buildSniper(): THREE.Group {
  const rifle = new THREE.Group()
  rifle.name = 'weapon'
  const metal = new THREE.MeshLambertMaterial({ color: 0x3a3f47, flatShading: true })
  const black = new THREE.MeshLambertMaterial({ color: 0x1b1d21, flatShading: true })
  const wood = new THREE.MeshLambertMaterial({ color: 0x6b4a2a, flatShading: true })
  const glass = new THREE.MeshLambertMaterial({
    color: 0x2b4a55,
    emissive: 0x2f7f96,
    flatShading: true,
  })

  const along = (geo: THREE.CylinderGeometry) => geo.rotateX(Math.PI / 2) // +Y -> +Z

  const barrel = new THREE.Mesh(along(new THREE.CylinderGeometry(0.055, 0.05, 1.5, 6)), metal)
  barrel.position.z = 0.62
  const brake = new THREE.Mesh(along(new THREE.CylinderGeometry(0.085, 0.075, 0.18, 6)), black)
  brake.position.z = 1.42
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.2, 0.78), metal)
  receiver.position.z = -0.2
  const foreEnd = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.16, 0.62), wood)
  foreEnd.position.z = 0.35
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.24, 0.62), wood)
  stock.position.set(0, -0.03, -0.86)
  const comb = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.12, 0.34), wood)
  comb.position.set(0, 0.15, -0.66)
  const butt = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.32, 0.08), black)
  butt.position.set(0, -0.05, -1.19)
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.24, 0.18), black)
  mag.position.set(0, -0.19, -0.16)
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.22), black)
  guard.position.set(0, -0.16, -0.42)
  // Bolt handle out the right side — the bit the cycle animation flicks.
  const bolt = new THREE.Group()
  bolt.name = 'bolt'
  const boltArm = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.05, 0.05), metal)
  boltArm.position.x = 0.1
  const boltKnob = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), black)
  boltKnob.position.x = 0.21
  bolt.add(boltArm, boltKnob)
  bolt.position.set(0.06, 0.03, -0.36)

  // Scope: a fat tube on two ring mounts, with lenses at both ends.
  const scope = new THREE.Mesh(along(new THREE.CylinderGeometry(0.085, 0.085, 0.66, 8)), black)
  scope.position.set(0, 0.23, -0.06)
  const bell = new THREE.Mesh(along(new THREE.CylinderGeometry(0.11, 0.09, 0.16, 8)), black)
  bell.position.set(0, 0.23, 0.33)
  const lensFront = new THREE.Mesh(along(new THREE.CylinderGeometry(0.095, 0.095, 0.03, 8)), glass)
  lensFront.position.set(0, 0.23, 0.41)
  const lensRear = new THREE.Mesh(along(new THREE.CylinderGeometry(0.075, 0.075, 0.03, 8)), glass)
  lensRear.position.set(0, 0.23, -0.39)
  const mountA = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.07), metal)
  mountA.position.set(0, 0.14, 0.14)
  const mountB = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.07), metal)
  mountB.position.set(0, 0.14, -0.26)

  // Folded bipod under the fore-end.
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.36, 0.035), metal)
    leg.position.set(side * 0.06, -0.24, 0.5)
    leg.rotation.set(-0.35, 0, side * 0.3)
    rifle.add(leg)
  }

  rifle.add(
    barrel, brake, receiver, foreEnd, stock, comb, butt, mag, guard, bolt,
    scope, bell, lensFront, lensRear, mountA, mountB,
  )
  rifle.position.set(0.36, 1.72, 0.15)
  rifle.userData.mountY = 1.72
  return rifle
}

// Katana held in the right hand, blade extending past the hand (local -Y),
// so it hangs at the side and follows the arm during a slash.
export function buildKatana(): THREE.Group {
  const sword = new THREE.Group()
  sword.name = 'weapon'
  const dark = new THREE.MeshLambertMaterial({ color: 0x22252a, flatShading: true })
  const gold = new THREE.MeshLambertMaterial({ color: 0xb8973a, flatShading: true })
  const steel = new THREE.MeshLambertMaterial({ color: 0xd8dde4, flatShading: true })

  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.26, 0.07), dark)
  handle.position.y = -0.38
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.04, 0.17), gold)
  guard.position.y = -0.52
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.85, 0.12), steel)
  blade.position.y = -0.97
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.24, 0.1), steel)
  tip.position.set(0, -1.48, 0.025)
  tip.rotation.x = 0.22
  sword.add(handle, guard, blade, tip)
  return sword
}

// Garden shovel in the right hand, blade past the fist (local -Y) like the
// katana, so the same overhead chop reads as a dig.
export function buildShovel(): THREE.Group {
  const shovel = new THREE.Group()
  shovel.name = 'weapon'
  const wood = new THREE.MeshLambertMaterial({ color: 0x8a5a2b, flatShading: true })
  const steel = new THREE.MeshLambertMaterial({ color: 0x9aa0a8, flatShading: true })

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.09), wood)
  grip.position.y = -0.4
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.05, 0.07), wood)
  shaft.position.y = -0.95
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.06), steel)
  blade.position.set(0, -1.62, 0.03)
  blade.rotation.x = 0.16
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.06), steel)
  tip.position.set(0, -1.86, 0.07)
  tip.rotation.x = 0.16
  shovel.add(grip, shaft, blade, tip)
  return shovel
}

// Vertical bow facing -Z: limbs curve forward, string spans the tips. The
// nock point (middle string vertex) slides toward +Z as it's drawn —
// userData carries the string attribute and travel range so firstperson.ts
// can animate the pull.
export function buildBow(): THREE.Group {
  const bow = new THREE.Group()
  bow.name = 'weapon'
  const wood = new THREE.MeshLambertMaterial({ color: 0x7a4f26, flatShading: true })
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.3, 0.09), wood)
  const upper = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 0.06), wood)
  upper.position.set(0, 0.42, -0.09)
  upper.rotation.x = -0.3
  const lower = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 0.06), wood)
  lower.position.set(0, -0.42, -0.09)
  lower.rotation.x = 0.3
  const stringGeo = new THREE.BufferGeometry()
  stringGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0.7, -0.18, 0, 0, -0.18, 0, -0.7, -0.18], 3),
  )
  const string = new THREE.Line(stringGeo, new THREE.LineBasicMaterial({ color: 0xe8e4d8 }))
  bow.add(grip, upper, lower, string)
  bow.userData.stringPos = stringGeo.attributes.position
  bow.userData.nockRestZ = -0.18
  bow.userData.nockPullZ = 0.32
  return bow
}

// Chunky builder's mallet in the right hand, head past the fist (local -Y)
// like the katana, so the overhead chop doubles as a place-and-tamp whack.
export function buildBuilder(): THREE.Group {
  const mallet = new THREE.Group()
  mallet.name = 'weapon'
  const wood = new THREE.MeshLambertMaterial({ color: 0x8a5a2b, flatShading: true })
  const steel = new THREE.MeshLambertMaterial({ color: 0x9aa0a8, flatShading: true })
  const gold = new THREE.MeshLambertMaterial({ color: 0xb8973a, flatShading: true })

  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 0.08), wood)
  shaft.position.y = -0.9
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.12), gold)
  band.position.y = -1.38
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.26, 0.26), steel)
  head.position.y = -1.55
  mallet.add(shaft, band, head)
  return mallet
}

// An unlit firework carried by its stick, tube-end down past the fist
// (local -Y) like the shovel — so the same overhead chop reads as jamming it
// into the dirt.
export function buildFirework(): THREE.Group {
  const rocket = new THREE.Group()
  rocket.name = 'weapon'
  const wood = new THREE.MeshLambertMaterial({ color: 0x8a5a2b, flatShading: true })
  const paper = new THREE.MeshLambertMaterial({ color: 0xd93b3b, flatShading: true })
  const gold = new THREE.MeshLambertMaterial({ color: 0xffc93b, flatShading: true })
  const dark = new THREE.MeshLambertMaterial({ color: 0x2a2016, flatShading: true })

  const stick = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.0, 0.05), wood)
  stick.position.y = -0.85
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.62, 6), paper)
  tube.position.y = -1.62
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.175, 0.175, 0.11, 6), gold)
  band.position.y = -1.45
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.3, 6).rotateX(Math.PI), gold)
  nose.position.y = -2.08
  const fuse = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.2, 0.045), dark)
  fuse.position.set(0.16, -1.34, 0)
  fuse.rotation.z = 0.5

  rocket.add(stick, tube, band, nose, fuse)
  return rocket
}

// Exported for cats.ts, which hangs a smaller one over each cat.
export function makeNameTag(name: string): THREE.Sprite {
  // Low-res canvas + nearest filtering: the game renders at 320x240, so a big
  // smooth texture just gets minified into mush. Chunky pixels read better.
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 32
  const ctx = canvas.getContext('2d')!
  ctx.font = 'bold 18px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  const w = Math.min(124, ctx.measureText(name).width + 10)
  ctx.fillRect(64 - w / 2, 3, w, 26)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(name, 64, 17)
  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  )
  sprite.name = 'nametag'
  sprite.scale.set(3.4, 0.85, 1)
  sprite.position.y = 2.8
  return sprite
}

// Swap the floating name tag (players can rename themselves at any time).
export function setName(group: THREE.Group, name: string): void {
  const old = group.getObjectByName('nametag') as THREE.Sprite | undefined
  if (old) {
    old.material.map?.dispose()
    old.material.dispose()
    group.remove(old)
  }
  group.add(makeNameTag(name))
  liftNameTag(group)
}

// The tag floats above a person's head. An X-wing is a good deal taller than
// a person, and the sprite draws with depthTest off, so at head height it
// paints straight over the canopy. Lift it clear of the whole ship. Called
// from both setName and setRide, since either can happen first.
function liftNameTag(group: THREE.Group): void {
  const tag = group.getObjectByName('nametag')
  if (tag) tag.position.y = group.userData.ride === 'xwing' ? 3.7 : 2.8
}
