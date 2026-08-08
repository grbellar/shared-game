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
  return group
}

interface Rig {
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
  const k = Math.min(1, 10 * dt)
  anim.crouch += ((pose === 'crouch' ? 1 : 0) - anim.crouch) * k
  anim.swim += ((pose === 'swim' ? 1 : 0) - anim.swim) * k
  const { crouch, swim } = anim

  // Squat: body and head drop, legs squash so the feet stay planted.
  rig.body.position.y = 1.1 - 0.3 * crouch
  rig.head.position.y = 1.95 - 0.5 * crouch
  rig.legL.position.y = rig.legR.position.y = 0.6 - 0.3 * crouch
  rig.legL.scale.y = rig.legR.scale.y = 1 - 0.5 * crouch
  rig.armL.position.y = rig.armR.position.y = 1.6 - 0.3 * crouch

  // Legs: stride on land (shorter while crouched), flutter kick in water.
  const stride = Math.sin(walkPhase) * 0.8 * moving * (1 - 0.55 * crouch)
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
