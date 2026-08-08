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
import { Arrows } from './arrows'
import { Destruction } from './destruction'
import { DayNight } from './daynight'
import { Building } from './building'
import { initBlocks, blockAtPoint, type BlockSpec } from './blocks'
import { initBuildHud } from './buildhud'
import { FirstPersonAim } from './firstperson'
import { Health } from './health'
import { setWeapon, setRide, startSlash, startJabber, popHead, SLASH_DURATION } from './character'
import { loadProfile, saveProfile } from './profile'
import { sfx } from './audio'
import { Voice } from './voice'
import { music } from './music'

// Render at N64-ish resolution, then upscale with nearest-neighbor (CSS).
const VIEW_W = 320
const VIEW_H = 240

// Who you are survives reloads now: token, name, color, and loadout all come
// from the browser-storage profile (minted on your very first visit).
const profile = loadProfile()
const name = profile.name
const color = profile.color

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
createWorld(scene)
initBlocks(scene)

const player = new Player(scene, color, name)
const remotes = new Remotes(scene)
const settings = initSettings()
const touch = new TouchControls()
const health = new Health()
player.onRespawn = () => health.revive()

// Sounds fade with distance from the local player.
function distVol(pos: THREE.Vector3, range = 70): number {
  return Math.max(0, 1 - player.group.position.distanceTo(pos) / range)
}

const net = new Net()
const voice = new Voice(net)
net.onWelcome = (players, craters, blocks) => {
  remotes.clear()
  voice.reset() // reconnects mint a new id; old voice links are orphaned
  players.forEach((p) => {
    remotes.upsert(p)
    voice.peerJoined(p.id)
  })
  // Catch up on world damage. Silent: no debris bursts, and reconnect
  // replays dedupe to a no-op inside addCraters.
  destruction.applyRemote(craters, true)
  // Blocks get a full reset instead: some may have died while we were away.
  building.replay(blocks)
}
net.onState = (p) => {
  const isNew = !remotes.getGroup(p.id)
  remotes.upsert(p)
  if (isNew) voice.peerJoined(p.id)
}
net.onLeave = (id) => {
  remotes.remove(id)
  voice.peerLeft(id)
}
net.connect()

type Weapon = 'none' | 'gun' | 'sword' | 'shovel' | 'bow' | 'builder'
type Ride = 'none' | 'wheelchair' | 'ramsey'
// Loadout picks up where you left off last session (profile validates them).
let weapon = profile.weapon as Weapon
let ride = profile.ride as Ride
let material = profile.material // index into MATERIALS, picked with 1-4 while building
setWeapon(player.group, weapon)
setRide(player.group, ride)
player.ride = ride

function saveLoadout(): void {
  profile.weapon = weapon
  profile.ride = ride
  profile.material = material
  saveProfile(profile)
}

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
    talk: Math.round(voice.level * 100) / 100,
  })
}, 66)

const effects = new Effects(scene)
const arrows = new Arrows(scene)
arrows.onHitMe = (vel) => player.applyImpulse(vel.x * 0.12, 2.5, vel.z * 0.12)
arrows.onStick = (pos) => sfx.arrowStick(Math.max(0.25, distVol(pos, 60)))
net.onArrow = (id, origin, dir, power) => {
  const from = new THREE.Vector3(...origin)
  sfx.bowShot(power * Math.max(0.2, distVol(from)))
  arrows.spawn(id, from, new THREE.Vector3(...dir), power)
}
const destruction = new Destruction(effects, net)
const building = new Building(effects, net)
building.volumeAt = (pos) => distVol(pos, 50)
const buildHud = initBuildHud()
buildHud.setMaterial(material)
buildHud.setVisible(weapon === 'builder')
player.onSplash = (x, z) => effects.spawnSplash(x, z)
remotes.onSplash = (x, z) => {
  effects.spawnSplash(x, z)
  sfx.splash(distVol(new THREE.Vector3(x, 0, z), 50))
}
// Rockets detonate on built blocks, and our own blasts chew through them.
effects.solidAt = (p) => blockAtPoint(p.x, p.y, p.z) !== undefined
effects.onOwnExplosion = (center) => {
  destruction.rocketCrater(center)
  building.blastDamage(center)
}
net.onBlockPlace = (gx, gy, gz, m) => building.applyRemotePlace(gx, gy, gz, m)
net.onBlockHit = (gx, gy, gz, dmg) => building.applyRemoteHit(gx, gy, gz, dmg)
net.onCrater = (c) => {
  // Dig-sized craters get a scoop sound; rocket craters already boomed.
  if (c.r < 3) sfx.dig(distVol(new THREE.Vector3(c.x, player.group.position.y, c.z), 50))
  destruction.applyRemote([c])
}
effects.onBlast = (center) => {
  const BLAST_RADIUS = 7
  const BLAST_DAMAGE = 75 // dead center; a rocket jump off the rim is cheap
  sfx.explosion(distVol(center, 90))
  const d = player.group.position.distanceTo(center)
  if (d >= BLAST_RADIUS) return
  const k = 1 - d / BLAST_RADIUS
  const dir = player.group.position.clone().sub(center)
  dir.y = 0
  if (dir.lengthSq() < 0.01) dir.set(0, 0, 1)
  dir.normalize()
  player.applyImpulse(dir.x * 20 * k, 7 + 9 * k, dir.z * 20 * k)
  // Own blast included: rocket jumps should hurt.
  health.damage(BLAST_DAMAGE * k)
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
net.onHit = (_attacker, dmg) => health.damage(dmg)
// Losing the last of your health is your own announcement to make: the head
// pops here, and everyone else hears about it through `kill`.
health.onDeath = () => {
  if (net.id) net.sendKill(net.id)
  dieLocally()
}
function dieLocally(): void {
  const headPos = popHead(player.group)
  if (headPos) effects.spawnHeadPop(headPos)
  sfx.pop()
  sfx.death()
  player.die()
}
net.onKill = (victim) => {
  if (victim === net.id) {
    health.kill()
    dieLocally()
  } else {
    const group = remotes.getGroup(victim)
    sfx.pop(group ? distVol(group.position) : 0.7)
    remotes.decapitate(victim, effects)
  }
}

// Bow: hold to draw, release to loose. Power scales with hold time.
const BOW_DRAW_MS = 1100
let bowDrawStart = -1
function releaseBow(): void {
  if (bowDrawStart < 0) return
  const power = Math.max(0.2, Math.min(1, (performance.now() - bowDrawStart) / BOW_DRAW_MS))
  bowDrawStart = -1
  const ry = player.group.rotation.y
  // First person looses along the crosshair; third person lobs gently up
  // so the arc reads at mid range.
  const dir = fp.isActive
    ? fp.aimDir(new THREE.Vector3())
    : new THREE.Vector3(Math.sin(ry), 0.1, Math.cos(ry)).normalize()
  const origin = player.group.position
    .clone()
    .add(new THREE.Vector3(dir.x * 0.6, 1.6, dir.z * 0.6))
  arrows.spawn('me', origin, dir, power)
  net.sendArrow(origin, dir, power)
  sfx.bowShot(power)
}

// The built block a melee swing would connect with: the column just ahead,
// (there's no pitch aim in third person, so a swing just sweeps the volume
// in front of you). Both axes are swept rather than sampled once, because
// cells are 1.5 wide and the grid is fixed in absolute space: one fixed
// reach can land in the column beside the one the builder fills, and a
// ground-level block is half-sunk into the hillside, so its top sits below
// the chest height you'd naively probe.
const MELEE_REACH = [1.1, 1.7, 2.3]
const MELEE_HEIGHTS = [0.2, 1.2, 2.2] // above the feet: sunk block, chest, head
function meleeBlockTarget(): BlockSpec | undefined {
  const p = player.group.position
  const ry = player.group.rotation.y
  const sin = Math.sin(ry)
  const cos = Math.cos(ry)
  for (const dist of MELEE_REACH) {
    const tx = p.x + sin * dist
    const tz = p.z + cos * dist
    for (const h of MELEE_HEIGHTS) {
      const hit = blockAtPoint(tx, p.y + h, tz)
      if (hit) return hit
    }
  }
  return undefined
}

let lastAttack = 0
const SWORD_DAMAGE = 55 // two clean swings takes a head off
function attack(): void {
  if (player.dead) return
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
  } else if (weapon === 'sword' && now - lastAttack > 500) {
    lastAttack = now
    sfx.slash()
    fp.swing()
    startSlash(player.group)
    net.sendSlash()
    // Check for a hit at the midpoint of the swing. Players first — a block
    // behind a victim never eats the killing blow.
    setTimeout(() => {
      for (const { id, pos } of remotes.targets()) {
        const to = pos.clone().sub(player.group.position)
        if (to.length() > 2.4) continue
        const facing = Math.atan2(
          Math.sin(Math.atan2(to.x, to.z) - player.group.rotation.y),
          Math.cos(Math.atan2(to.x, to.z) - player.group.rotation.y),
        )
        if (Math.abs(facing) < 1.2) {
          // Just the damage — the victim decides whether that was fatal and
          // announces it, so the head pops when their `kill` comes back.
          net.sendHit(id, SWORD_DAMAGE)
          sfx.hitmark()
          return
        }
      }
      const block = meleeBlockTarget()
      if (block) building.hit(block.gx, block.gy, block.gz, 1)
    }, SLASH_DURATION * 500)
  } else if (weapon === 'shovel' && now - lastAttack > 600) {
    lastAttack = now
    sfx.slash(0.5)
    fp.swing()
    startSlash(player.group)
    net.sendSlash()
    // Scoop at the bottom of the swing: a built block in front takes the
    // hit (a shovel pries harder than a katana slashes), otherwise dig —
    // the aimed ground point in first person, else just ahead of the feet.
    setTimeout(() => {
      const block = meleeBlockTarget()
      if (block) {
        building.hit(block.gx, block.gy, block.gz, 2)
        return
      }
      const aimed = fp.isActive ? fp.aimedDigPoint() : null
      const ry = player.group.rotation.y
      destruction.dig(
        aimed ? aimed.x : player.group.position.x + Math.sin(ry) * 1.6,
        aimed ? aimed.z : player.group.position.z + Math.cos(ry) * 1.6,
      )
    }, SLASH_DURATION * 500)
  } else if (weapon === 'builder' && now - lastAttack > 250) {
    lastAttack = now
    sfx.slash(0.35)
    fp.swing()
    startSlash(player.group)
    net.sendSlash()
    // Place immediately — snappy building beats swing-synced building. The
    // target is the crosshair's ground point in first person, else the
    // column just ahead; either way the column stacks upward.
    const aimed = fp.isActive ? fp.aimedDigPoint() : null
    building.place(player.group.position, player.group.rotation.y, material, aimed)
  }
}
window.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement
  if (touch.active || chat.isOpen) return
  if (target !== document.body && target.tagName !== 'CANVAS') return
  // In first person the first click grabs the mouse; later clicks attack.
  if (fp.claimClickForLock()) return
  if (weapon === 'bow') {
    bowDrawStart = performance.now()
    sfx.bowDraw()
    return
  }
  attack()
})
window.addEventListener('mouseup', () => {
  if (weapon === 'bow') releaseBow()
  else bowDrawStart = -1
})
if (touch.active) {
  const fire = document.createElement('div')
  fire.id = 'touch-fire'
  fire.textContent = 'B'
  fire.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    attack()
  })
  const mic = document.createElement('div')
  mic.id = 'mic-open'
  mic.textContent = '🎤'
  mic.style.opacity = '0.4'
  mic.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    void voice.toggle().then((on) => {
      mic.style.opacity = on ? '1' : '0.4'
      sfx.equip(on)
    })
  })
  document.body.append(fire, mic)
}

const chat = new Chat()
const bubbles = new Bubbles(camera, renderer.domElement)
// Longer messages get a longer mouth-flap while the bubble is up.
const jabberFor = (text: string): number => Math.min(4000, 900 + text.length * 55)
chat.onSend = (text) => {
  sfx.chat()
  net.sendChat(text)
  bubbles.show(player.group, text)
  startJabber(player.group, jabberFor(text))
  chat.addMessage(name, text)
}
net.onChat = (id, senderName, text) => {
  sfx.chat()
  const group = remotes.getGroup(id)
  if (group) {
    bubbles.show(group, text)
    startJabber(group, jabberFor(text))
  }
  chat.addMessage(senderName, text)
}

const status = document.getElementById('status')!
setInterval(() => {
  const others = remotes.count
  const mute = sfx.muted ? ' · 🔇 (M)' : ''
  const mic = voice.enabled ? ' · 🎤 live (V)' : ''
  status.textContent = net.connected
    ? `${name} · ${others} other ${others === 1 ? 'player' : 'players'} here${mute}${mic}`
    : `${name} · connecting...${mute}${mic}`
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
    buildHud.setVisible(false)
    saveLoadout()
  }
  if (e.code === 'KeyH') {
    weapon = weapon === 'sword' ? 'none' : 'sword'
    setWeapon(player.group, weapon)
    sfx.equip(weapon !== 'none')
    buildHud.setVisible(false)
    saveLoadout()
  }
  if (e.code === 'KeyF') {
    weapon = weapon === 'shovel' ? 'none' : 'shovel'
    setWeapon(player.group, weapon)
    sfx.equip(weapon !== 'none')
    buildHud.setVisible(false)
    saveLoadout()
  }
  if (e.code === 'KeyB') {
    weapon = weapon === 'bow' ? 'none' : 'bow'
    bowDrawStart = -1
    setWeapon(player.group, weapon)
    sfx.equip(weapon !== 'none')
    buildHud.setVisible(false)
    saveLoadout()
  }
  if (e.code === 'KeyT') {
    weapon = weapon === 'builder' ? 'none' : 'builder'
    setWeapon(player.group, weapon)
    sfx.equip(weapon !== 'none')
    buildHud.setVisible(weapon === 'builder')
    saveLoadout()
  }
  if (weapon === 'builder' && /^Digit[1-4]$/.test(e.code)) {
    material = Number(e.code.slice(5)) - 1
    buildHud.setMaterial(material)
    saveLoadout()
  }
  if (e.code === 'KeyR') {
    ride = ride === 'wheelchair' ? 'none' : 'wheelchair'
    setRide(player.group, ride)
    player.ride = ride
    sfx.equip(ride !== 'none')
    saveLoadout()
  }
  if (e.code === 'KeyY') {
    ride = ride === 'ramsey' ? 'none' : 'ramsey'
    setRide(player.group, ride)
    player.ride = ride
    sfx.equip(ride !== 'none')
    if (ride === 'ramsey') sfx.ramseyMount()
    saveLoadout()
  }
  if (e.code === 'KeyM') sfx.toggleMute()
  if (e.code === 'KeyV' && !e.repeat) void voice.toggle().then((on) => sfx.equip(on))
})
window.addEventListener('keyup', (e) => keys.delete(e.code))

const gameCamera = new GameCamera(camera)
const fp = new FirstPersonAim(player, renderer.domElement, camera, color)
const daynight = new DayNight(scene)

// The day/night clock is shared: the room's clock arrives in welcome (and on
// every scrub by anyone), and our own scrubs/toggles broadcast back.
net.onClock = (hours, running) => {
  settings.timeOfDay = hours
  settings.clockRun = running
  daynight.setClock(hours, running)
}
settings.onClockChange = (fromToggle) => {
  // A pause/resume freezes the CURRENT moment — take it from the anchor, not
  // the settings mirror, which goes stale in rAF-throttled background tabs.
  if (fromToggle) settings.timeOfDay = daynight.now()
  daynight.setClock(settings.timeOfDay, settings.clockRun)
  net.sendClock(settings.timeOfDay, settings.clockRun)
}

// Debug handle so agents (and curious friends) can poke the game from the
// console: game.player, game.remotes, game.net.
;(window as unknown as Record<string, unknown>).game = { player, remotes, net, fp, settings, daynight, voice, arrows, health, effects, music, building }

const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05)

  gameCamera.addYaw(touch.consumeYaw())
  music.setEnabled(settings.music && !sfx.muted)
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
  health.update(dt)
  voice.update(dt)
  player.group.userData.talk = voice.level // our own mouth flaps too
  voice.updateVolumes(player.group.position, (id) => remotes.getGroup(id)?.position)
  fp.setDraw(
    weapon === 'bow' && bowDrawStart >= 0
      ? Math.min(1, (performance.now() - bowDrawStart) / BOW_DRAW_MS)
      : 0,
  )
  bubbles.update()
  effects.update(dt, [...remotes.targets(), { id: 'me', pos: player.group.position }])
  arrows.update(dt, [...remotes.stickTargets(), { id: 'me', group: player.group }])
  remotes.update(dt)
  gameCamera.update(dt, keys, player, settings, fp)
  daynight.update(settings, camera.position)

  renderer.render(scene, camera)
})
