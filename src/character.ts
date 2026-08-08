import * as THREE from 'three'

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

// Drop a character from the registry when it leaves the scene.
export function releaseCharacter(group: THREE.Group): void {
  registry.delete(group)
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
  const eyeGeo = new THREE.BoxGeometry(0.09, 0.12, 0.05)
  const eyeMat = new THREE.MeshLambertMaterial({ color: 0x111111 })
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat)
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat)
  eyeL.position.set(-0.14, 0.05, 0.31)
  eyeR.position.set(0.14, 0.05, 0.31)
  head.add(eyeL, eyeR)

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

  group.add(body, head, legL, legR, armL, armR)
  group.add(makeNameTag(name))
  group.userData.rig = { body, head, legL, legR, armL, armR }
  group.userData.anim = { crouch: 0, swim: 0 }
  registry.add(group)
  return group
}

export interface Rig {
  body: THREE.Mesh
  head: THREE.Mesh
  legL: THREE.Mesh
  legR: THREE.Mesh
  armL: THREE.Mesh
  armR: THREE.Mesh
}

export function animateCharacter(
  group: THREE.Group,
  dt: number,
  walkPhase: number,
  moving: number,
  pose: Pose = 'stand',
): void {
  const rig = group.userData.rig as Rig
  const anim = group.userData.anim as { crouch: number; swim: number }
  const riding = group.userData.ride === 'wheelchair'
  const k = Math.min(1, 10 * dt)
  anim.crouch += ((pose === 'crouch' && !riding ? 1 : 0) - anim.crouch) * k
  anim.swim += ((pose === 'swim' && !riding ? 1 : 0) - anim.swim) * k
  const { crouch, swim } = anim

  // Squat: body and head drop, legs squash so the feet stay planted.
  rig.body.position.y = 1.1 - 0.3 * crouch
  rig.head.position.y = 1.95 - 0.5 * crouch
  rig.legL.position.y = rig.legR.position.y = 0.6 - 0.3 * crouch
  rig.legL.scale.y = rig.legR.scale.y = 1 - 0.5 * crouch
  rig.armL.position.y = rig.armR.position.y = 1.6 - 0.3 * crouch

  const stride = Math.sin(walkPhase) * 0.8 * moving * (1 - 0.55 * crouch)
  if (riding) {
    // Sitting: legs out to the footrest, hands down on the push rims.
    rig.legL.rotation.x = -1.35
    rig.legR.rotation.x = -1.35
    rig.armL.rotation.x = -0.6
    rig.armR.rotation.x = -0.6
    rig.armL.rotation.z = 0
    rig.armR.rotation.z = 0
    const wheels = group.userData.rideWheels as THREE.Group[] | undefined
    if (wheels) for (const wheel of wheels) wheel.rotation.x = walkPhase * 1.5
  } else {
    // Legs: stride on land (shorter while crouched), flutter kick in water.
    const kick = Math.sin(walkPhase * 2.6) * (0.35 + 0.25 * moving)
    rig.legL.rotation.x = stride * (1 - swim) + kick * swim
    rig.legR.rotation.x = -stride * (1 - swim) - kick * swim

    // Arms: swing opposite the legs on land, windmill a front crawl in water.
    // Wrapped to one turn so blending in/out of swim doesn't pinwheel forever.
    const stroke = -(walkPhase % (Math.PI * 2))
    rig.armL.rotation.x = -stride * 0.7 * (1 - swim) + stroke * swim
    rig.armR.rotation.x = stride * 0.7 * (1 - swim) + (stroke + Math.PI) * swim
    // Flare the arms out a touch when squatting or paddling.
    rig.armL.rotation.z = -(0.4 * crouch + 0.25 * swim)
    rig.armR.rotation.z = 0.4 * crouch + 0.25 * swim
  }

  // Weapon overrides for the right arm.
  const weapon = group.userData.weapon as string | undefined
  if (weapon === 'gun') {
    // Bazooka arm holds the tube steady out front, and the tube itself
    // follows the shoulder down through a squat.
    const gun = group.getObjectByName('weapon')
    if (gun) gun.position.y = 1.8 - 0.3 * crouch
    rig.armR.rotation.x = Math.PI / 2
    rig.armR.rotation.z = 0
  } else if (weapon === 'sword' || weapon === 'shovel') {
    const t = (performance.now() - ((group.userData.attackStart as number) ?? 0)) / 1000
    if (t < SLASH_DURATION) {
      // Overhead chop: wind up behind the head, slice down past the knees.
      // Doubles as the shovel's dig scoop.
      rig.armR.rotation.x = -2.8 + (t / SLASH_DURATION) * 3.6
      rig.armR.rotation.z = 0
    } else if (!riding) {
      rig.armR.rotation.x = -0.25 + stride * 0.3
      rig.armR.rotation.z = 0
    }
  }
}

export const SLASH_DURATION = 0.3

export function startSlash(group: THREE.Group): void {
  group.userData.attackStart = performance.now()
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

// Equip 'gun' (shoulder bazooka), 'sword' (katana in the right hand),
// 'shovel' (also right hand), or 'none'. Synced over the network via the
// `weapon` field in PlayerState.
export function setWeapon(group: THREE.Group, weapon: string): void {
  const existing = group.getObjectByName('weapon')
  if (existing) existing.parent!.remove(existing)
  group.userData.weapon = weapon
  const armR = (group.userData.rig as { armR: THREE.Mesh }).armR
  if (weapon === 'gun') {
    group.add(buildBazooka())
  } else if (weapon === 'sword') {
    armR.add(buildKatana())
  } else if (weapon === 'shovel') {
    armR.add(buildShovel())
  }
}

// Mount or dismount the wheelchair. Synced via the `ride` field in
// PlayerState. The character sits in it (see animateCharacter).
export function setRide(group: THREE.Group, ride: string): void {
  const existing = group.getObjectByName('ride')
  if (existing) existing.parent!.remove(existing)
  group.userData.ride = ride
  delete group.userData.rideWheels
  if (ride === 'wheelchair') {
    const chair = buildWheelchair()
    group.add(chair)
    group.userData.rideWheels = chair.userData.wheels
  }
}

// Buried-treasure loot (and the duck's revenge). Synced via the `hat` field
// in PlayerState so everyone sees what you dug up. Parented to the head, so
// hats crouch, decapitate and big-head along with it.
export type Hat = 'none' | 'crown' | 'wizard' | 'cone' | 'tinfoil' | 'pirate' | 'bucket' | 'duck'

export function setHat(group: THREE.Group, hat: string): void {
  const head = (group.userData.rig as Rig | undefined)?.head
  if (!head) return
  const existing = head.getObjectByName('hat')
  if (existing) existing.parent!.remove(existing)
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
    return gun
  }
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

function makeNameTag(name: string): THREE.Sprite {
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
  sprite.scale.set(3.4, 0.85, 1)
  sprite.position.y = 2.8
  return sprite
}
