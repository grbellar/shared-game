import * as THREE from 'three'
import { BLOCK, MATERIALS, cellCenter } from './blocks'

// The builder's aiming feedback: a translucent cube in the cell a left-click
// would fill, and a cage around the block a right-click would knock out.
// Purely local — nothing here is ever synced, and it never touches the block
// store. main.ts feeds it a target every frame.

export interface GhostView {
  // The cell a placement would land in, and whether that placement is legal
  // (null = nothing to preview: wrong tool, dead, or aiming off the grid).
  place: { gx: number; gy: number; gz: number; valid: boolean } | null
  // The block a break would take out, if there is one.
  break: { gx: number; gy: number; gz: number } | null
  m: number
}

const BAD = 0xff3b30

export class BlockGhost {
  private fill: THREE.Mesh
  private edges: THREE.LineSegments
  private cage: THREE.LineSegments
  private fillMat: THREE.MeshBasicMaterial
  private edgeMat: THREE.LineBasicMaterial
  private cageMat: THREE.LineBasicMaterial
  private t = 0

  constructor(scene: THREE.Scene) {
    // Fill sits a hair inside the cell so it never z-fights the neighbour it
    // is stacked against; the outline sits a hair outside so it always reads.
    const box = new THREE.BoxGeometry(BLOCK * 0.96, BLOCK * 0.96, BLOCK * 0.96)
    this.fillMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    })
    this.fill = new THREE.Mesh(box, this.fillMat)
    this.fill.renderOrder = 2

    const outline = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(BLOCK * 1.02, BLOCK * 1.02, BLOCK * 1.02),
    )
    this.edgeMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9 })
    this.edges = new THREE.LineSegments(outline, this.edgeMat)
    this.edges.renderOrder = 3

    const cageGeo = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(BLOCK * 1.06, BLOCK * 1.06, BLOCK * 1.06),
    )
    this.cageMat = new THREE.LineBasicMaterial({
      color: 0xff9c2a,
      transparent: true,
      opacity: 0.85,
    })
    this.cage = new THREE.LineSegments(cageGeo, this.cageMat)
    this.cage.renderOrder = 3

    for (const o of [this.fill, this.edges, this.cage]) {
      o.visible = false
      scene.add(o)
    }
  }

  update(view: GhostView | null, dt: number): void {
    this.t += dt
    // Slow breathe so the ghost never gets mistaken for a real block at
    // 320x240, where a static translucent cube reads as solid.
    const pulse = 0.78 + 0.22 * Math.sin(this.t * 4)

    const place = view?.place ?? null
    this.fill.visible = place !== null
    this.edges.visible = place !== null
    if (place) {
      const center = cellCenter(place.gx, place.gy, place.gz)
      this.fill.position.copy(center)
      this.edges.position.copy(center)
      const tint = place.valid ? MATERIALS[view!.m].debris : BAD
      this.fillMat.color.setHex(tint)
      this.fillMat.opacity = place.valid ? 0.3 * pulse : 0.18 * pulse
      this.edgeMat.color.setHex(place.valid ? 0xffffff : BAD)
      this.edgeMat.opacity = place.valid ? 0.9 * pulse : pulse
    }

    const target = view?.break ?? null
    this.cage.visible = target !== null
    if (target) {
      this.cage.position.copy(cellCenter(target.gx, target.gy, target.gz))
      this.cageMat.opacity = 0.55 + 0.35 * pulse
    }
  }
}
