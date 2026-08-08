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
  // Gun arm is held straight out in front; otherwise it swings.
  limbs.armR.rotation.x = group.userData.gun ? -Math.PI / 2 : swing * 0.7
}

// Attach or remove the bazooka: a big tube resting on the right shoulder,
// pointing forward (+Z). Synced over the network via the `gun` flag in
// PlayerState. The raised right arm (see animateCharacter) holds it up.
export function setGun(group: THREE.Group, has: boolean): void {
  const existing = group.getObjectByName('gun')
  group.userData.gun = has
  if (has && !existing) {
    const gun = new THREE.Group()
    gun.name = 'gun'
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
    group.add(gun)
  } else if (!has && existing) {
    group.remove(existing)
  }
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
