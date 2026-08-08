import * as THREE from 'three'

export type Pose = 'stand' | 'crouch' | 'swim'

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

  group.add(body, head, legL, legR, armL, armR)
  group.add(makeNameTag(name))
  group.userData.rig = { body, head, legL, legR, armL, armR, mouth }
  group.userData.anim = { crouch: 0, swim: 0, mouth: 0 }
  return group
}

interface Rig {
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
  const anim = group.userData.anim as { crouch: number; swim: number; mouth: number }
  const ride = group.userData.ride as string | undefined
  const riding = ride === 'wheelchair' || ride === 'ramsey'
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
  if (weapon === 'gun' || weapon === 'bow') {
    // Held steady out front, following the shoulder down through a squat.
    const held = group.getObjectByName('weapon')
    if (held) held.position.y = (weapon === 'gun' ? 1.8 : 1.5) - 0.3 * crouch
    rig.armR.rotation.x = Math.PI / 2
    rig.armR.rotation.z = 0
  } else if (weapon === 'sword' || weapon === 'shovel' || weapon === 'builder') {
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

// Equip 'gun' (shoulder bazooka), 'sword' (katana in the right hand),
// 'shovel' or 'builder' (also right hand), or 'none'. Synced over the
// network via the `weapon` field in PlayerState.
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
  } else if (weapon === 'bow') {
    const bow = buildBow()
    // The bow is built facing -Z (camera-space for the first-person view);
    // the character faces +Z, so spin it around and hold it out front.
    bow.rotation.y = Math.PI
    bow.position.set(0.3, 1.5, 0.35)
    group.add(bow)
  } else if (weapon === 'builder') {
    armR.add(buildBuilder())
  }
}

// Mount or dismount a ride: 'wheelchair' or 'ramsey' (a guy you ride like
// a horse). Synced via the `ride` field in PlayerState. The character sits
// on it (see animateCharacter).
export function setRide(group: THREE.Group, ride: string): void {
  const existing = group.getObjectByName('ride')
  if (existing) existing.parent!.remove(existing)
  group.userData.ride = ride
  delete group.userData.rideWheels
  delete group.userData.rideLimbs
  if (ride === 'wheelchair') {
    const chair = buildWheelchair()
    group.add(chair)
    group.userData.rideWheels = chair.userData.wheels
  } else if (ride === 'ramsey') {
    const ramsey = buildRamsey()
    group.add(ramsey)
    group.userData.rideLimbs = ramsey.userData.limbs
  }
}

// Ramsey: a loyal guy on all fours you ride like a horse. White tee, jeans,
// and his signature flat-top army cap. His back lines up with the rider's
// seat; limbs pivot at the shoulder/hip so he can bound (see animateCharacter).
function buildRamsey(): THREE.Group {
  const ramsey = new THREE.Group()
  ramsey.name = 'ride'
  const tee = new THREE.MeshLambertMaterial({ color: 0xcfc9b8 })
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

// Ramsey's brown flat-top army cap: oval crown, stubby brim, and a tiny
// canvas-drawn KANGOL label on the front. Built in head-local space.
function buildArmyCap(): THREE.Group {
  const cap = new THREE.Group()
  const cloth = new THREE.MeshLambertMaterial({ color: 0x6b5747, flatShading: true })
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
