import * as THREE from 'three'
import { createWorld } from './world'
import { Player } from './player'
import { Net } from './net'
import { Remotes } from './remotes'
import { TouchControls } from './touch'
import { Chat } from './chat'
import { Bubbles } from './bubbles'
import { Effects } from './effects'
import { setWeapon, setRide, startSlash, popHead, SLASH_DURATION } from './character'

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
const touch = new TouchControls()

const net = new Net()
net.onWelcome = (players) => {
  remotes.clear()
  players.forEach((p) => remotes.upsert(p))
}
net.onState = (p) => remotes.upsert(p)
net.onLeave = (id) => remotes.remove(id)
net.connect()

let weapon: 'none' | 'gun' | 'sword' = 'none'
let ride: 'none' | 'wheelchair' = 'none'

setInterval(() => {
  net.sendState({
    x: player.group.position.x,
    y: player.group.position.y,
    z: player.group.position.z,
    ry: player.group.rotation.y,
    color,
    name,
    pose: player.pose,
    weapon,
    ride,
  })
}, 66)

const effects = new Effects(scene)
effects.onBlast = (center) => {
  const BLAST_RADIUS = 7
  const d = player.group.position.distanceTo(center)
  if (d >= BLAST_RADIUS) return
  const k = 1 - d / BLAST_RADIUS
  const dir = player.group.position.clone().sub(center)
  dir.y = 0
  if (dir.lengthSq() < 0.01) dir.set(0, 0, 1)
  dir.normalize()
  player.applyImpulse(dir.x * 20 * k, 7 + 9 * k, dir.z * 20 * k)
}
net.onFire = (id, origin, dir) => {
  effects.spawnRocket(
    id,
    new THREE.Vector3(...origin),
    new THREE.Vector3(...dir),
  )
}
net.onSlash = (id) => remotes.slash(id)
net.onKill = (victim) => {
  if (victim === net.id) {
    const headPos = popHead(player.group)
    if (headPos) effects.spawnHeadPop(headPos)
    player.die()
  } else {
    remotes.decapitate(victim, effects)
  }
}

let lastAttack = 0
function attack(): void {
  const now = performance.now()
  if (weapon === 'gun' && now - lastAttack > 800) {
    lastAttack = now
    const ry = player.group.rotation.y
    const dir = new THREE.Vector3(Math.sin(ry), 0.06, Math.cos(ry)).normalize()
    const origin = player.group.position
      .clone()
      .add(new THREE.Vector3(dir.x * 1.1, 1.8, dir.z * 1.1))
    effects.spawnRocket('me', origin, dir)
    net.sendFire(origin, dir)
  } else if (weapon === 'sword' && now - lastAttack > 500) {
    lastAttack = now
    startSlash(player.group)
    net.sendSlash()
    // Check for a hit at the midpoint of the swing.
    setTimeout(() => {
      for (const { id, pos } of remotes.targets()) {
        const to = pos.clone().sub(player.group.position)
        if (to.length() > 2.4) continue
        const facing = Math.atan2(
          Math.sin(Math.atan2(to.x, to.z) - player.group.rotation.y),
          Math.cos(Math.atan2(to.x, to.z) - player.group.rotation.y),
        )
        if (Math.abs(facing) < 1.2) {
          net.sendKill(id)
          remotes.decapitate(id, effects)
          break
        }
      }
    }, SLASH_DURATION * 500)
  }
}
window.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement
  if (touch.active || chat.isOpen) return
  if (target !== document.body && target.tagName !== 'CANVAS') return
  attack()
})
if (touch.active) {
  const fire = document.createElement('div')
  fire.id = 'touch-fire'
  fire.textContent = 'B'
  fire.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    attack()
  })
  document.body.append(fire)
}

const chat = new Chat()
const bubbles = new Bubbles(camera, renderer.domElement)
chat.onSend = (text) => {
  net.sendChat(text)
  bubbles.show(player.group, text)
  chat.addMessage(name, text)
}
net.onChat = (id, senderName, text) => {
  const group = remotes.getGroup(id)
  if (group) bubbles.show(group, text)
  chat.addMessage(senderName, text)
}

const status = document.getElementById('status')!
setInterval(() => {
  const others = remotes.count
  status.textContent = net.connected
    ? `${name} · ${others} other ${others === 1 ? 'player' : 'players'} here`
    : `${name} · connecting...`
}, 500)

const keys = new Set<string>()
window.addEventListener('keydown', (e) => {
  keys.add(e.code)
  if (e.code === 'Enter' && !chat.isOpen) {
    e.preventDefault()
    chat.open()
  }
  if (e.code === 'KeyG') {
    weapon = weapon === 'gun' ? 'none' : 'gun'
    setWeapon(player.group, weapon)
  }
  if (e.code === 'KeyH') {
    weapon = weapon === 'sword' ? 'none' : 'sword'
    setWeapon(player.group, weapon)
  }
  if (e.code === 'KeyR') {
    ride = ride === 'wheelchair' ? 'none' : 'wheelchair'
    setRide(player.group, ride)
    player.riding = ride === 'wheelchair'
  }
})
window.addEventListener('keyup', (e) => keys.delete(e.code))

let camYaw = 0
const CAM_OFFSET = new THREE.Vector3()
const CAM_TARGET = new THREE.Vector3()
camera.position.set(0, 12, 14)

// Debug handle so agents (and curious friends) can poke the game from the
// console: game.player, game.remotes, game.net.
;(window as unknown as Record<string, unknown>).game = { player, remotes, net }

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
      crouch: keys.has('KeyC'),
      sprint: keys.has('ShiftLeft') || keys.has('ShiftRight'),
    },
    camYaw,
  )
  bubbles.update()
  effects.update(dt, [...remotes.targets(), { id: 'me', pos: player.group.position }])
  remotes.update(dt)

  CAM_OFFSET.set(Math.sin(camYaw) * 9, 6, Math.cos(camYaw) * 9)
  CAM_TARGET.copy(player.group.position).add(CAM_OFFSET)
  camera.position.lerp(CAM_TARGET, Math.min(1, 8 * dt))
  CAM_TARGET.copy(player.group.position)
  CAM_TARGET.y += 2
  camera.lookAt(CAM_TARGET)

  renderer.render(scene, camera)
})
