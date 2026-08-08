import * as THREE from 'three'
import { createWorld, heightAt } from './world'
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
import { setWeapon, setRide, setHat, startSlash, popHead, SLASH_DURATION } from './character'
import { sfx } from './audio'
import { Sky, SUN_AIM_DOT } from './sky'
import { Critters } from './critters'
import { Treasure } from './treasure'
import { Cheats, type CheatName } from './cheats'
import { Hud } from './hud'
import { Killboard } from './killboard'

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
// In the scene graph so camera children (the first-person view model) render.
scene.add(camera)
const sky = new Sky(scene)
createWorld(scene)

const player = new Player(scene, color, name)
const remotes = new Remotes(scene)
const settings = initSettings()
const touch = new TouchControls()
const hud = new Hud()
const killboard = new Killboard()
const treasure = new Treasure()

// Sounds fade with distance from the local player.
function distVol(pos: THREE.Vector3, range = 70): number {
  return Math.max(0, 1 - player.group.position.distanceTo(pos) / range)
}

const net = new Net()
net.onWelcome = (w) => {
  remotes.clear()
  w.players.forEach((p) => remotes.upsert(p))
  // Catch up on world damage. Silent: no debris bursts, and reconnect
  // replays dedupe to a no-op inside addCraters.
  destruction.applyRemote(w.craters, true)
  // Treasure somebody already dug up, and the damage already done.
  w.found.forEach((i) => treasure.markClaimed(i))
  killboard.setScores(w.scores)
}
net.onState = (p) => remotes.upsert(p)
net.onLeave = (id) => remotes.remove(id)
net.connect()

let weapon: 'none' | 'gun' | 'sword' | 'shovel' = 'none'
let ride: 'none' | 'wheelchair' = 'none'
let hat = 'none'

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
    hat,
  })
}, 66)

const effects = new Effects(scene)
const destruction = new Destruction(effects, net)
const critters = new Critters(scene, effects)
const cheats = new Cheats(effects)

// --- easter eggs -----------------------------------------------------------

// Loot: the finder puts the hat on (synced via PlayerState), everyone hears
// about it, and the room remembers the cache is gone.
function claimTreasure(index: number, byName: string, mine: boolean): void {
  const cache = treasure.cache(index)
  if (!cache) return
  treasure.markClaimed(index)
  const at = new THREE.Vector3(cache.x, Math.max(heightAt(cache.x, cache.z), 0) + 0.6, cache.z)
  effects.spawnDebris(at, 0xffd54a, 16, 7)
  sfx.fanfare(mine ? 1 : distVol(at, 70))
  hud.feed(`${byName} dug up ${cache.label.toLowerCase()}`)
  if (!mine) return
  hud.banner(`YOU FOUND ${cache.label}`, 3200)
  hat = cache.hat
  setHat(player.group, hat)
  net.sendEgg('dig', index)
}

// The duck. The culprit wears it as a hat from now on.
function killDuck(byName: string, mine: boolean): void {
  const at = critters.duckPosition?.clone()
  if (!at) return
  critters.killDuck()
  sfx.quack(mine ? 1 : distVol(at, 60))
  sfx.pop(mine ? 1 : distVol(at, 60))
  hud.feed(`★ ${byName} MURDERED THE DUCK ★`)
  if (!mine) return
  hud.banner('YOU MONSTER', 3000)
  hat = 'duck'
  setHat(player.group, hat)
  net.sendEgg('duck')
}

function annoyNessie(byName: string, mine: boolean): void {
  critters.diveNessie()
  sfx.roar(0.8)
  hud.feed(`${byName} hit something enormous out at sea`)
  if (!mine) return
  hud.banner('IT DIVED', 2600)
  net.sendEgg('nessie')
}

// Nothing can physically reach the sun, so a hit is judged on aim: you have
// to be in first person, pointing straight at it. It sulks for 45 seconds.
function strikeSun(byName: string, mine: boolean): void {
  if (sky.isAngry) return
  setTimeout(() => {
    sky.strike()
    sfx.sunhit()
    hud.banner(mine ? 'YOU SHOT THE SUN' : `${byName} SHOT THE SUN`, 3400)
    hud.feed('the sun has taken this personally')
  }, 1100)
  if (mine) net.sendEgg('sun')
}

function applyCheat(cheat: CheatName, who: string): void {
  const { on, banner } = cheats.toggle(cheat)
  sfx.cheat(on)
  hud.banner(banner, 2600)
  hud.feed(`${who} typed "${cheat}"`)
}

net.onEgg = (e) => {
  if (e.k === 'dig' && typeof e.n === 'number') claimTreasure(e.n, e.name, false)
  else if (e.k === 'duck') killDuck(e.name, false)
  else if (e.k === 'nessie') annoyNessie(e.name, false)
  else if (e.k === 'sun') strikeSun(e.name, false)
}

net.onScores = (scores) => killboard.setScores(scores)

effects.onOwnExplosion = (center) => {
  destruction.rocketCrater(center)
  // Wildlife caught in your own blast. Only the shooter mints these, same
  // rule as craters — every client simulates the rocket, so letting all of
  // them decide would fire the event N times.
  const duck = critters.duckPosition
  if (duck && duck.distanceTo(center) < 6) killDuck(name, true)
  if (critters.nessieHitBy(center, 9)) annoyNessie(name, true)
}
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
net.onKill = (victim, _killer, killerName, victimName) => {
  hud.feed(`${killerName} sliced ${victimName}`)
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
    fp.kick()
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
    // Rockets expire long before they'd reach the sun, so the sun is hit on
    // aim alone — which means only first person can ever line it up.
    if (dir.dot(sky.dir) > SUN_AIM_DOT) strikeSun(name, true)
  } else if (weapon === 'sword' && now - lastAttack > 500) {
    lastAttack = now
    sfx.slash()
    fp.swing()
    startSlash(player.group)
    net.sendSlash()
    // Check for a hit at the midpoint of the swing.
    setTimeout(() => {
      let hit = false
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
          hud.feed(`${name} sliced ${remotes.nameOf(id)}`)
          hit = true
          break
        }
      }
      // Players first — the duck only eats the blade if nobody else did.
      const duck = critters.duckPosition
      if (!hit && duck && duck.distanceTo(player.group.position) < 2.6) killDuck(name, true)
    }, SLASH_DURATION * 500)
  } else if (weapon === 'shovel' && now - lastAttack > 600) {
    lastAttack = now
    sfx.slash(0.5)
    fp.swing()
    startSlash(player.group)
    net.sendSlash()
    // Scoop at the bottom of the swing: the aimed ground point in first
    // person (fall back to in-front when pointing at the sky), else just
    // ahead of the feet.
    setTimeout(() => {
      const aimed = fp.isActive ? fp.aimedDigPoint() : null
      const ry = player.group.rotation.y
      const dx = aimed ? aimed.x : player.group.position.x + Math.sin(ry) * 1.6
      const dz = aimed ? aimed.z : player.group.position.z + Math.cos(ry) * 1.6
      destruction.dig(dx, dz)
      const found = treasure.tryDig(dx, dz)
      if (found !== null) claimTreasure(found, name, true)
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
  // Cheat codes ride the chat channel — everyone in the room already gets
  // the text, so both ends parse it and toggle together. No new message type.
  net.sendChat(text)
  const cheat = cheats.parse(text)
  if (cheat) {
    applyCheat(cheat, name)
    return
  }
  sfx.chat()
  bubbles.show(player.group, text)
  chat.addMessage(name, text)
}
net.onChat = (id, senderName, text) => {
  const cheat = cheats.parse(text)
  if (cheat) {
    applyCheat(cheat, senderName)
    return
  }
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
  if (e.code === 'Tab' && !chat.isOpen) {
    // Held, FPS-style. preventDefault or the browser moves focus off canvas.
    e.preventDefault()
    killboard.setHats(allHats())
    killboard.show()
  }
})
window.addEventListener('keyup', (e) => {
  keys.delete(e.code)
  if (e.code === 'Tab') killboard.hide()
})

// Everyone's headwear, so the killboard can badge the crown-wearer.
function allHats(): Map<string, string> {
  const hats = remotes.hats()
  if (net.id) hats.set(net.id, hat)
  return hats
}

const gameCamera = new GameCamera(camera)
const fp = new FirstPersonAim(player, renderer.domElement, camera)

// Debug handle so agents (and curious friends) can poke the game from the
// console: game.player, game.remotes, game.net.
;(window as unknown as Record<string, unknown>).game = {
  player,
  remotes,
  net,
  fp,
  sky,
  critters,
  treasure,
  cheats,
}

const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05)

  gameCamera.addYaw(touch.consumeYaw())
  fp.setActive(settings.firstPerson && weapon !== 'none' && !touch.active, weapon)
  fp.update(dt)

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
  sky.update(dt)
  critters.update(dt, player.group.position)
  cheats.update()
  hud.detector(treasure.update(dt, player.group.position, weapon === 'shovel' && !player.dead))
  gameCamera.update(dt, keys, player, settings, fp)

  renderer.render(scene, camera)
})
