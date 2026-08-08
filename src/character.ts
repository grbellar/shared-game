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
  limbs.armR.rotation.x = swing * 0.7
}

function makeNameTag(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.font = 'bold 30px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 6
  ctx.strokeStyle = 'rgba(0,0,0,0.8)'
  ctx.strokeText(name, 128, 32)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(name, 128, 32)
  const texture = new THREE.CanvasTexture(canvas)
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  )
  sprite.scale.set(2.4, 0.6, 1)
  sprite.position.y = 2.7
  return sprite
}
