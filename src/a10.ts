import * as THREE from 'three'

// The A-10 Warthog: a flying gun with a plane attached. Like the X-wing next
// door (xwing.ts) it is a *ride* — the flight model is shared, the seated
// pilot and position stream carry the whole flight over the wire, and the
// engine glow is derived from how fast the thing is actually moving. This
// module is only the shape.
//
// It's also Droid's plane: a10strike.ts spawns a second one of these with a
// Meckie in the canopy to fly fire missions (see the `cas` message).

const HULL = 0x7f8578 // low-viz compass-gray green
const PANEL = 0x62685e
const GLASS = 0x22303d
const GUNMETAL = 0x2c2f34
const MOUTH = 0xb83a32 // the shark grin
const TOOTH = 0xf2efe4

// Where the GAU-8 speaks from, in ship-local space — just under the nose.
// main.ts fires the ride's gun from here, a10strike.ts hangs tracers off it.
export const A10_MUZZLE = new THREE.Vector3(0, 0.85, 4.2)

// Built facing +Z like every ride in character.ts, sized so the pilot's
// torso sits in the fuselage and their head in the canopy (the character
// group's origin is at their feet). Exhaust discs ride in userData.glow for
// poseA10; the wheels in userData.wheels so taxiing spins them.
export function buildA10(): THREE.Group {
  const hog = new THREE.Group()
  hog.name = 'ride'
  const hull = new THREE.MeshLambertMaterial({ color: HULL, flatShading: true })
  const panel = new THREE.MeshLambertMaterial({ color: PANEL, flatShading: true })
  const metal = new THREE.MeshLambertMaterial({ color: GUNMETAL, flatShading: true })
  const glass = new THREE.MeshLambertMaterial({ color: GLASS, flatShading: true })
  const mouth = new THREE.MeshLambertMaterial({ color: MOUTH, flatShading: true })
  const tooth = new THREE.MeshLambertMaterial({ color: TOOTH, flatShading: true })
  const along = (geo: THREE.CylinderGeometry) => geo.rotateX(Math.PI / 2) // +Y -> +Z

  // Fuselage: a straight slab — the Hog is a flying bathtub, not a dart.
  const fuselage = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 5.2), hull)
  fuselage.position.set(0, 1.1, -0.3)
  const nose = new THREE.Mesh(along(new THREE.CylinderGeometry(0.34, 0.64, 1.9, 6)), hull)
  nose.position.set(0, 1.02, 3.2)
  hog.add(fuselage, nose)

  // The gun. It pokes out under the chin, seven barrels faked as one fat one
  // with a ring of muzzle.
  const gun = new THREE.Mesh(along(new THREE.CylinderGeometry(0.13, 0.13, 1.1, 6)), metal)
  gun.position.set(0, 0.85, 3.75)
  const muzzle = new THREE.Mesh(along(new THREE.CylinderGeometry(0.17, 0.13, 0.25, 6)), metal)
  muzzle.position.set(0, 0.85, 4.25)
  hog.add(gun, muzzle)

  // Nose art: the grin. A red mouth band with a row of hanging teeth, and a
  // pair of angry eyes up top. Silly beats realistic.
  const grin = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.3, 0.6), mouth)
  grin.position.set(0, 0.72, 2.85)
  hog.add(grin)
  for (const tx of [-0.36, -0.18, 0, 0.18, 0.36]) {
    const fang = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 4), tooth)
    fang.rotation.x = Math.PI // point down
    fang.position.set(tx, 0.8, 3.16)
    hog.add(fang)
  }
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.14, 0.06), tooth)
    eye.position.set(side * 0.28, 1.38, 3.05)
    eye.rotation.z = side * -0.35 // slanted inward: cross about everything
    hog.add(eye)
  }

  // Canopy over the pilot's head (y≈1.95), same bubble trick as the X-wing.
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.7, 1.45), glass)
  canopy.position.set(0, 2.0, 0.55)
  const canopyFront = new THREE.Mesh(along(new THREE.CylinderGeometry(0.1, 0.4, 0.75, 4)), glass)
  canopyFront.position.set(0, 1.95, 1.55)
  canopyFront.rotation.z = Math.PI / 4
  hog.add(canopy, canopyFront)

  // One long straight wing, low and wide, with the Hog's drooped tips.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(7.0, 0.14, 1.55), hull)
  wing.position.set(0, 0.98, 0.35)
  hog.add(wing)
  for (const side of [-1, 1]) {
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.12, 1.4), panel)
    tip.position.set(side * 3.8, 0.86, 0.35)
    tip.rotation.z = side * 0.55
    hog.add(tip)
  }

  // The signature engines: two fat turbofans on stalks over the tail.
  const glow: THREE.Mesh[] = []
  for (const side of [-1, 1]) {
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.9), panel)
    pylon.position.set(side * 0.78, 1.75, -1.9)
    const nacelle = new THREE.Mesh(along(new THREE.CylinderGeometry(0.44, 0.44, 1.8, 8)), hull)
    nacelle.position.set(side * 0.78, 2.1, -1.9)
    const intake = new THREE.Mesh(along(new THREE.CylinderGeometry(0.36, 0.46, 0.35, 8)), metal)
    intake.position.set(side * 0.78, 2.1, -0.95)
    // Emissive so it reads lit at 320x240; poseA10 pumps it with throttle.
    const exhaust = new THREE.Mesh(
      along(new THREE.CylinderGeometry(0.28, 0.38, 0.4, 8)),
      new THREE.MeshLambertMaterial({ color: 0xffa040, emissive: 0xff5a14, flatShading: true }),
    )
    exhaust.position.set(side * 0.78, 2.1, -2.95)
    glow.push(exhaust)
    hog.add(pylon, nacelle, intake, exhaust)
  }

  // Twin tails on the ends of the stabilizer.
  const hstab = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.12, 1.0), hull)
  hstab.position.set(0, 1.35, -3.05)
  hog.add(hstab)
  for (const side of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.05, 0.95), hull)
    fin.position.set(side * 1.3, 1.9, -3.05)
    hog.add(fin)
  }

  // Fixed-out gear so a parked Hog stands on something: two wing pods and a
  // nose strut. The wheel cylinders are baked axle-along-X, so spinning
  // rotation.x rolls them (see animateCharacter).
  const wheels: THREE.Mesh[] = []
  const axle = (geo: THREE.CylinderGeometry) => geo.rotateZ(Math.PI / 2) // +Y -> +X
  for (const side of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.55, 0.95), panel)
    pod.position.set(side * 1.5, 0.62, 0.35)
    const wheel = new THREE.Mesh(axle(new THREE.CylinderGeometry(0.26, 0.26, 0.22, 8)), metal)
    wheel.position.set(side * 1.5, 0.26, 0.35)
    wheels.push(wheel)
    hog.add(pod, wheel)
  }
  const strut = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.6, 0.12), metal)
  strut.position.set(0.2, 0.5, 2.3) // offset right of the gun, like the real one
  const noseWheel = new THREE.Mesh(axle(new THREE.CylinderGeometry(0.2, 0.2, 0.18, 8)), metal)
  noseWheel.position.set(0.2, 0.2, 2.3)
  wheels.push(noseWheel)
  hog.add(strut, noseWheel)

  hog.userData.glow = glow
  hog.userData.wheels = wheels
  return hog
}

// Pump the exhausts. No S-foils here — the only thing an A-10 does with its
// wings is keep them. Driven from animateCharacter for local and remote
// planes alike, off the derived throttle rather than a message.
export function poseA10(hog: THREE.Group, glowLevel: number): void {
  const glow = hog.userData.glow as THREE.Mesh[] | undefined
  if (!glow) return
  const s = 0.5 + 1.3 * glowLevel
  for (const disc of glow) {
    disc.scale.set(1, 1, s)
    const mat = disc.material as THREE.MeshLambertMaterial
    mat.emissiveIntensity = 0.4 + 1.6 * glowLevel
  }
}
