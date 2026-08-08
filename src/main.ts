import * as THREE from 'three'
import { createWorld } from './world'
import { Player } from './player'
import { Net } from './net'
import { Remotes } from './remotes'
import { GameCamera } from './camera'
import { initSettings } from './settings'
import { TouchControls } from './touch'
import { Chat } from './chat'
import { Bubbles } from './bubbles'
import { Effects } from './effects'
import { Destruction } from './destruction'
import { FirstPersonAim } from './firstperson'
import { setWeapon, setRide, startSlash, popHead, SLASH_DURATION } from './character'
import { sfx } from './audio'

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
const settings = initSettings()
const touch = new TouchControls()

// Sounds fade with distance from the local player.
function distVol(pos: THREE.Vector3, range = 70): number {
  return Math.max(0, 1 - player.group.position.distanceTo(pos) / range)
}

const net = new Net()
net.onWelcome = (players, craters) => {
  remotes.clear()
  players.forEach((p) => remotes.upsert(p))
  // Catch up on world damage. Silent: no debris bursts, and reconnect
  // replays dedupe to a no-op inside addCraters.
  destruction.applyRemote(craters, true)
}
net.onState = (p) => remotes.upsert(p)
net.onLeave = (id) => remotes.remove(id)
net.connect()

let weapon: 'none' | 'gun' | 'sword' | 'shovel' = 'none'
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
const destruction = new Destruction(effects, net)
effects.onOwnExplosion = (center) => destruction.rocketCrater(center)
net.onCrater = (c) => {
  // Dig-sized craters get a scoop sound; rocket craters already boomed.
  if (c.r < 3) sfx.dig(distVol(new THREE.Vector3(c.x, player.group.position.y, c.z), 50))
  destruction.applyRemote([c])
}
effects.onBlast = (center) => {
  const BLAST_RADIUS = 7
  sfx.explosion(distVol(center, 90))
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
  const from = new THREE.Vector3(...origin)
  sfx.rocket(distVol(from))
  effects.spawnRocket(id, from, new THREE.Vector3(...dir))
}
net.onSlash = (id) => {
  const group = remotes.getGroup(id)
  sfx.slash(group ? distVol(group.position) : 0.7)
  remotes.slash(id)
}
net.onKill = (victim) => {
  if (victim === net.id) {
    const headPos = popHead(player.group)
    if (headPos) effects.spawnHeadPop(headPos)
    sfx.pop()
    sfx.death()
    player.die()
  } else {
    const group = remotes.getGroup(victim)
    sfx.pop(group ? distVol(group.position) : 0.7)
    remotes.decapitate(victim, effects)
  }
}

let lastAttack = 0
function attack(): void {
  const now = performance.now()
  if (weapon === 'gun' && now - lastAttack > 800) {
    lastAttack = now
    sfx.rocket()
    const ry = player.group.rotation.y
    // Third person lobs slightly upward; first person fires along the crosshair.
    const dir = fp.isActive
      ? fp.aimDir(new THREE.Vector3())
      : new THREE.Vector3(Math.sin(ry), 0.06, Math.cos(ry)).normalize()
    const origin = player.group.position
      .clone()
      .add(new THREE.Vector3(dir.x * 1.1, 1.8, dir.z * 1.1))
    effects.spawnRocket('me', origin, dir)
    net.sendFire(origin, dir)
  } else if (weapon === 'sword' && now - lastAttack > 500) {
    lastAttack = now
    sfx.slash()
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
  } else if (weapon === 'shovel' && now - lastAttack > 600) {
    lastAttack = now
    sfx.slash(0.5)
    startSlash(player.group)
    net.sendSlash()
    // Scoop at the bottom of the swing: the aimed ground point in first
    // person (fall back to in-front when pointing at the sky), else just
    // ahead of the feet.
    setTimeout(() => {
      const aimed = fp.isActive ? fp.aimedDigPoint() : null
      const ry = player.group.rotation.y
      destruction.dig(
        aimed ? aimed.x : player.group.position.x + Math.sin(ry) * 1.6,
        aimed ? aimed.z : player.group.position.z + Math.cos(ry) * 1.6,
      )
    }, SLASH_DURATION * 500)
  }
}
window.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement
  if (touch.active || chat.isOpen) return
  if (target !== document.body && target.tagName !== 'CANVAS') return
  // In first person the first click grabs the mouse; later clicks attack.
  if (fp.claimClickForLock()) return
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
  sfx.chat()
  net.sendChat(text)
  bubbles.show(player.group, text)
  chat.addMessage(name, text)
}
net.onChat = (id, senderName, text) => {
  sfx.chat()
  const group = remotes.getGroup(id)
  if (group) bubbles.show(group, text)
  chat.addMessage(senderName, text)
}

const status = document.getElementById('status')!
setInterval(() => {
  const others = remotes.count
  const mute = sfx.muted ? ' · 🔇 (M)' : ''
  status.textContent = net.connected
    ? `${name} · ${others} other ${others === 1 ? 'player' : 'players'} here${mute}`
    : `${name} · connecting...${mute}`
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
    sfx.equip(weapon !== 'none')
  }
  if (e.code === 'KeyH') {
    weapon = weapon === 'sword' ? 'none' : 'sword'
    setWeapon(player.group, weapon)
    sfx.equip(weapon !== 'none')
  }
  if (e.code === 'KeyF') {
    weapon = weapon === 'shovel' ? 'none' : 'shovel'
    setWeapon(player.group, weapon)
    sfx.equip(weapon !== 'none')
  }
  if (e.code === 'KeyR') {
    ride = ride === 'wheelchair' ? 'none' : 'wheelchair'
    setRide(player.group, ride)
    player.riding = ride === 'wheelchair'
    sfx.equip(ride !== 'none')
  }
  if (e.code === 'KeyM') sfx.toggleMute()
})
window.addEventListener('keyup', (e) => keys.delete(e.code))

const gameCamera = new GameCamera(camera)
const fp = new FirstPersonAim(player, renderer.domElement)

// Debug handle so agents (and curious friends) can poke the game from the
// console: game.player, game.remotes, game.net.
;(window as unknown as Record<string, unknown>).game = { player, remotes, net, fp }

const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05)

  gameCamera.addYaw(touch.consumeYaw())
  fp.setActive(settings.firstPerson && weapon !== 'none' && !touch.active)

  player.update(
    dt,
    {
      f: (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) + touch.moveF,
      s: (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) + touch.moveS,
      jump: keys.has('Space') || touch.jumpHeld,
      crouch: keys.has('KeyC'),
      sprint: keys.has('ShiftLeft') || keys.has('ShiftRight'),
      strafe: fp.isActive,
    },
    gameCamera.yaw,
  )
  bubbles.update()
  effects.update(dt, [...remotes.targets(), { id: 'me', pos: player.group.position }])
  remotes.update(dt)
  gameCamera.update(dt, keys, player, settings, fp)

  renderer.render(scene, camera)
})
