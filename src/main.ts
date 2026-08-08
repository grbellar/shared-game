import * as THREE from 'three'
import { createWorld } from './world'
import { Player } from './player'
import { Net } from './net'
import { Remotes } from './remotes'
import { TouchControls } from './touch'

// Render at N64-ish resolution, then upscale with nearest-neighbor (CSS).
const VIEW_W = 320
const VIEW_H = 240

const NAMES = ['Goober', 'Turnip', 'Moose', 'Bandit', 'Noodle', 'Crouton', 'Gremlin', 'Pebble', 'Sprout', 'Wizard']
const COLORS = ['#e23b3b', '#3b6fe2', '#2fa84f', '#e2a53b', '#9b4fd4', '#e26fb0', '#33c2c2', '#c2e23b']

const name = `${NAMES[Math.floor(Math.random() * NAMES.length)]}${Math.floor(Math.random() * 90) + 10}`
const color = COLORS[Math.floor(Math.random() * COLORS.length)]

const renderer = new THREE.WebGLRenderer({ antialias: false })
renderer.setSize(VIEW_W, VIEW_H, false)
document.body.appendChild(renderer.domElement)

function fitCanvas(): void {
  const scale = Math.min(window.innerWidth / VIEW_W, window.innerHeight / VIEW_H)
  renderer.domElement.style.width = `${VIEW_W * scale}px`
  renderer.domElement.style.height = `${VIEW_H * scale}px`
}
window.addEventListener('resize', fitCanvas)
fitCanvas()

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(70, VIEW_W / VIEW_H, 0.1, 500)
createWorld(scene)

const player = new Player(scene, color, name)
const remotes = new Remotes(scene)

const net = new Net()
net.onWelcome = (players) => {
  remotes.clear()
  players.forEach((p) => remotes.upsert(p))
}
net.onState = (p) => remotes.upsert(p)
net.onLeave = (id) => remotes.remove(id)
net.connect()

setInterval(() => {
  net.sendState({
    x: player.group.position.x,
    y: player.group.position.y,
    z: player.group.position.z,
    ry: player.group.rotation.y,
    color,
    name,
  })
}, 66)

const status = document.getElementById('status')!
setInterval(() => {
  const others = remotes.count
  status.textContent = net.connected
    ? `${name} · ${others} other ${others === 1 ? 'player' : 'players'} here`
    : `${name} · connecting...`
}, 500)

const keys = new Set<string>()
window.addEventListener('keydown', (e) => keys.add(e.code))
window.addEventListener('keyup', (e) => keys.delete(e.code))
const touch = new TouchControls()

let camYaw = 0
const CAM_OFFSET = new THREE.Vector3()
const CAM_TARGET = new THREE.Vector3()
camera.position.set(0, 12, 14)

const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05)

  if (keys.has('KeyQ')) camYaw += 2.2 * dt
  if (keys.has('KeyE')) camYaw -= 2.2 * dt
  camYaw += touch.consumeYaw()

  player.update(
    dt,
    {
      f: (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) + touch.moveF,
      s: (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) + touch.moveS,
      jump: keys.has('Space') || touch.jumpHeld,
    },
    camYaw,
  )
  remotes.update(dt)

  CAM_OFFSET.set(Math.sin(camYaw) * 9, 6, Math.cos(camYaw) * 9)
  CAM_TARGET.copy(player.group.position).add(CAM_OFFSET)
  camera.position.lerp(CAM_TARGET, Math.min(1, 8 * dt))
  CAM_TARGET.copy(player.group.position)
  CAM_TARGET.y += 2
  camera.lookAt(CAM_TARGET)

  renderer.render(scene, camera)
})
