import * as THREE from 'three'

// Character skins: every genre of fiction mashed together. Each skin dresses
// the base blocky character by recoloring its part materials and bolting
// accessory boxes onto the head/body (so they ride the crouch/animation
// offsets for free). Purely cosmetic for now — attributes someday. Synced via
// the `skin` field in PlayerState; unknown ids fall back to the base look.

export const SKINS: { id: string; label: string }[] = [
  { id: 'none', label: 'regular guy' },
  { id: 'cowboy', label: 'cowboy' },
  { id: 'astronaut', label: 'astronaut' },
  { id: 'wizard', label: 'wizard lord' },
  { id: 'knight', label: 'knight' },
  { id: 'pirate', label: 'pirate' },
  { id: 'robot', label: 'robot' },
  { id: 'ninja', label: 'ninja' },
  { id: 'vampire', label: 'vampire' },
  { id: 'caveman', label: 'caveman' },
  { id: 'alien', label: 'alien' },
]

export const SKIN_IDS = SKINS.map((s) => s.id)

interface Rig {
  body: THREE.Mesh
  head: THREE.Mesh
  legL: THREE.Mesh
  legR: THREE.Mesh
  armL: THREE.Mesh
  armR: THREE.Mesh
}

const paint = (mesh: THREE.Mesh, color: number): void => {
  ;(mesh.material as THREE.MeshLambertMaterial).color.set(color)
}

// Accessory box: sized, colored, positioned, parented. Returns the mesh so
// builders can tack on a rotation.
function bx(
  parent: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  color: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }))
  m.position.set(x, y, z)
  parent.add(m)
  return m
}

function cyl(
  parent: THREE.Object3D,
  rTop: number,
  rBot: number,
  h: number,
  color: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(rTop, rBot, h, 8),
    new THREE.MeshLambertMaterial({ color, flatShading: true }),
  )
  m.position.set(x, y, z)
  parent.add(m)
  return m
}

// Builders get the rig plus two fresh accessory groups already parented to
// the head and body meshes (local space: head center / body center).
type Builder = (rig: Rig, head: THREE.Group, body: THREE.Group) => void

const BUILDERS: Record<string, Builder> = {
  cowboy: (rig, head, body) => {
    paint(rig.body, 0x7a4f2b) // leather vest
    paint(rig.armL, 0x8a5f38)
    paint(rig.legL, 0x3d4f73) // jeans
    bx(head, 0.95, 0.06, 0.95, 0x6b4a2b, 0, 0.34, 0) // brim
    bx(head, 0.45, 0.28, 0.45, 0x6b4a2b, 0, 0.5, 0) // crown
    bx(body, 0.86, 0.13, 0.56, 0xc23b3b, 0, 0.48, 0) // bandana
  },
  astronaut: (rig, head, body) => {
    paint(rig.body, 0xe8e8ee)
    paint(rig.armL, 0xe8e8ee)
    paint(rig.legL, 0xe8e8ee)
    bx(head, 0.74, 0.74, 0.74, 0xe8e8ee, 0, 0, 0) // helmet
    bx(head, 0.5, 0.26, 0.06, 0x1a2430, 0, 0.05, 0.37) // visor
    bx(body, 0.6, 0.75, 0.22, 0xc8ccd4, 0, 0.05, -0.38) // life support pack
    bx(body, 0.36, 0.22, 0.06, 0x565c66, 0, 0.15, 0.26) // chest panel
    bx(body, 0.08, 0.08, 0.05, 0xc23b3b, -0.08, 0.15, 0.29)
    bx(body, 0.08, 0.08, 0.05, 0x4f9e3f, 0.08, 0.15, 0.29)
  },
  wizard: (rig, head) => {
    paint(rig.body, 0x5a3b8a) // robes
    paint(rig.armL, 0x5a3b8a)
    paint(rig.legL, 0x46306e)
    cyl(head, 0.5, 0.5, 0.05, 0x4a2f78, 0, 0.33, 0) // hat brim
    cyl(head, 0.03, 0.34, 0.75, 0x4a2f78, 0, 0.72, 0) // pointy hat
    bx(head, 0.1, 0.1, 0.05, 0xe8d44a, 0, 0.55, 0.24) // star
    bx(head, 0.44, 0.34, 0.1, 0xd8d8d8, 0, -0.38, 0.28) // beard
  },
  knight: (rig, head) => {
    paint(rig.body, 0x9aa0a8) // plate armor
    paint(rig.armL, 0x9aa0a8)
    paint(rig.legL, 0x7a8089)
    bx(head, 0.72, 0.72, 0.72, 0xb0b6bf, 0, 0, 0) // great helm
    bx(head, 0.5, 0.07, 0.06, 0x14161a, 0, 0.07, 0.37) // eye slit
    bx(head, 0.08, 0.26, 0.55, 0xc23b3b, 0, 0.48, 0) // plume
  },
  pirate: (rig, head) => {
    paint(rig.body, 0x8a2430) // captain's coat
    paint(rig.armL, 0x8a2430)
    paint(rig.legL, 0x2a2a30)
    bx(head, 0.9, 0.07, 0.9, 0x1e1e22, 0, 0.33, 0) // tricorn brim
    bx(head, 0.42, 0.22, 0.42, 0x1e1e22, 0, 0.46, 0)
    bx(head, 0.72, 0.22, 0.07, 0x1e1e22, 0, 0.44, 0.4) // upturned front
    bx(head, 0.2, 0.09, 0.04, 0xd8c44a, 0, 0.44, 0.44) // gold badge
    bx(head, 0.18, 0.18, 0.05, 0x14161a, 0.14, 0.05, 0.32) // eyepatch
    bx(head, 0.64, 0.05, 0.05, 0x14161a, 0, 0.16, 0.3) // strap
  },
  robot: (rig, head, body) => {
    paint(rig.head, 0x9aa2ad)
    paint(rig.body, 0x8f96a3)
    paint(rig.armL, 0x8f96a3)
    paint(rig.legL, 0x5a616e)
    bx(head, 0.52, 0.16, 0.05, 0x18324a, 0, 0.05, 0.315) // visor over the eyes
    cyl(head, 0.02, 0.02, 0.25, 0x565c66, 0, 0.42, 0) // antenna
    bx(head, 0.09, 0.09, 0.09, 0xc23b3b, 0, 0.56, 0)
    bx(head, 0.08, 0.12, 0.12, 0x565c66, -0.34, 0, 0) // ear bolts
    bx(head, 0.08, 0.12, 0.12, 0x565c66, 0.34, 0, 0)
    bx(body, 0.4, 0.3, 0.06, 0x565c66, 0, 0.05, 0.26) // chest unit
    bx(body, 0.1, 0.1, 0.05, 0xe8d44a, 0, 0.05, 0.3)
  },
  ninja: (rig, head) => {
    paint(rig.body, 0x24262c)
    paint(rig.armL, 0x24262c)
    paint(rig.legL, 0x24262c)
    bx(head, 0.68, 0.32, 0.68, 0x24262c, 0, 0.26, 0) // hood
    bx(head, 0.66, 0.3, 0.66, 0x24262c, 0, -0.18, 0) // mask (eyes stay out)
    bx(head, 0.7, 0.09, 0.7, 0xc23b3b, 0, 0.15, 0) // headband
    bx(head, 0.09, 0.3, 0.05, 0xc23b3b, 0.12, -0.02, -0.36) // band tails
    bx(head, 0.09, 0.3, 0.05, 0xc23b3b, -0.12, -0.02, -0.36)
  },
  vampire: (rig, head, body) => {
    paint(rig.head, 0xd9d9e2) // deathly pale
    paint(rig.body, 0x1a1a20)
    paint(rig.armL, 0x1a1a20)
    paint(rig.legL, 0x1a1a20)
    bx(head, 0.64, 0.16, 0.64, 0x111116, 0, 0.26, 0) // slicked hair
    bx(head, 0.16, 0.12, 0.05, 0x111116, 0, 0.16, 0.29) // widow's peak
    bx(head, 0.045, 0.09, 0.03, 0xffffff, -0.08, -0.2, 0.32) // fangs
    bx(head, 0.045, 0.09, 0.03, 0xffffff, 0.08, -0.2, 0.32)
    bx(body, 0.95, 1.25, 0.06, 0x1c0f14, 0, -0.15, -0.31) // cape
    bx(body, 0.9, 0.28, 0.1, 0x5a1420, 0, 0.48, -0.24) // high collar
    bx(body, 0.1, 0.12, 0.05, 0xd8c44a, 0, 0.3, 0.27) // medallion
  },
  caveman: (rig, head, body) => {
    paint(rig.body, 0x7a5230) // fur wrap
    paint(rig.armL, 0xe0b088) // bare arms
    paint(rig.legL, 0xe0b088) // bare legs
    bx(body, 0.86, 0.28, 0.56, 0x6b4526, 0, -0.5, 0) // fur skirt
    bx(body, 0.3, 0.2, 0.56, 0x6b4526, -0.25, 0.45, 0) // one-shoulder fur
    bx(head, 0.7, 0.26, 0.7, 0x4a3020, 0, 0.28, 0) // wild hair
    bx(head, 0.45, 0.06, 0.06, 0xe8e2d0, 0.2, 0.36, 0).rotation.y = 0.7 // bone
  },
  alien: (rig, head, body) => {
    paint(rig.head, 0x6fc24a)
    paint(rig.body, 0xb8bec8) // silver jumpsuit
    paint(rig.armL, 0xb8bec8)
    paint(rig.legL, 0x8f96a3)
    bx(head, 0.18, 0.24, 0.04, 0x0c0c10, -0.14, 0.07, 0.325) // big black eyes
    bx(head, 0.18, 0.24, 0.04, 0x0c0c10, 0.14, 0.07, 0.325)
    cyl(head, 0.02, 0.02, 0.22, 0x4a9636, -0.16, 0.4, 0) // antennae
    cyl(head, 0.02, 0.02, 0.22, 0x4a9636, 0.16, 0.4, 0)
    bx(head, 0.08, 0.08, 0.08, 0x6fc24a, -0.16, 0.52, 0)
    bx(head, 0.08, 0.08, 0.08, 0x6fc24a, 0.16, 0.52, 0)
    bx(body, 0.84, 0.12, 0.54, 0x565c66, 0, -0.1, 0) // utility belt
  },
}

// Dress a character (local or remote) in a skin. Resets to the base look
// first, so switching skins — or back to 'none' — never stacks outfits.
// Arm and leg materials are shared L/R, so painting the left paints both.
export function applySkin(group: THREE.Group, skin: string): void {
  const rig = group.userData.rig as Rig
  const baseColor = (group.userData.baseColor as string) ?? '#e23b3b'
  for (const parent of [rig.head, rig.body]) {
    const old = parent.getObjectByName('skinparts')
    if (old) parent.remove(old)
  }
  const bodyMat = new THREE.MeshLambertMaterial({ color: baseColor })
  rig.body.material = bodyMat
  const armMat = new THREE.MeshLambertMaterial({ color: baseColor })
  rig.armL.material = armMat
  rig.armR.material = armMat
  const legMat = new THREE.MeshLambertMaterial({ color: 0x33333a })
  rig.legL.material = legMat
  rig.legR.material = legMat
  rig.head.material = new THREE.MeshLambertMaterial({ color: 0xe0b088 })

  const build = BUILDERS[skin]
  if (build) {
    const headParts = new THREE.Group()
    headParts.name = 'skinparts'
    rig.head.add(headParts)
    const bodyParts = new THREE.Group()
    bodyParts.name = 'skinparts'
    rig.body.add(bodyParts)
    build(rig, headParts, bodyParts)
  }
}
