import * as THREE from 'three'

// Blocky N64-style character. Front of the character faces +Z.
// Limbs are stashed in userData so animateCharacter can swing them.
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
  const legL = new THREE.Mesh(legGeo, darkMat)
  const legR = new THREE.Mesh(legGeo, darkMat)
  legL.position.set(-0.22, 0.3, 0)
  legR.position.set(0.22, 0.3, 0)

  const armGeo = new THREE.BoxGeometry(0.22, 0.7, 0.22)
  const armL = new THREE.Mesh(armGeo, bodyMat)
  const armR = new THREE.Mesh(armGeo, bodyMat)
  armL.position.set(-0.55, 1.25, 0)
  armR.position.set(0.55, 1.25, 0)

  group.add(body, head, legL, legR, armL, armR)
  group.add(makeNameTag(name))
  group.userData.limbs = { legL, legR, armL, armR }
  return group
}

export function animateCharacter(group: THREE.Group, walkPhase: number, moving: number): void {
  const limbs = group.userData.limbs as {
    legL: THREE.Mesh
    legR: THREE.Mesh
    armL: THREE.Mesh
    armR: THREE.Mesh
  }
  const swing = Math.sin(walkPhase) * 0.8 * moving
  limbs.legL.rotation.x = swing
  limbs.legR.rotation.x = -swing
  limbs.armL.rotation.x = -swing * 0.7

  const weapon = group.userData.weapon as string | undefined
  if (weapon === 'gun') {
    // Bazooka arm is held straight out in front.
    limbs.armR.rotation.x = -Math.PI / 2
  } else if (weapon === 'sword') {
    const t = (performance.now() - (group.userData.attackStart ?? 0)) / 1000
    if (t < SLASH_DURATION) {
      // Overhead chop: wind up behind the head, slice down past the knees.
      limbs.armR.rotation.x = -2.8 + (t / SLASH_DURATION) * 3.6
    } else {
      limbs.armR.rotation.x = -0.25 + swing * 0.3
    }
  } else {
    limbs.armR.rotation.x = swing * 0.7
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

// Equip 'gun' (shoulder bazooka), 'sword' (katana in the right hand), or
// 'none'. Synced over the network via the `weapon` field in PlayerState.
export function setWeapon(group: THREE.Group, weapon: string): void {
  const existing = group.getObjectByName('weapon')
  if (existing) existing.parent!.remove(existing)
  group.userData.weapon = weapon
  if (weapon === 'gun') {
    group.add(buildBazooka())
  } else if (weapon === 'sword') {
    const armR = (group.userData.limbs as { armR: THREE.Mesh }).armR
    armR.add(buildKatana())
  }
}

// Big tube resting on the right shoulder, pointing forward (+Z). The raised
// right arm (see animateCharacter) holds it up.
function buildBazooka(): THREE.Group {
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
function buildKatana(): THREE.Group {
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
