import * as THREE from 'three'
import { createWorld, heightAt } from './world'
import { Player } from './player'
import { Net } from './net'
import { Remotes } from './remotes'
import { GameCamera } from './camera'
import { initSettings, setSetting } from './settings'
import { Webcam } from './webcam'
import { FaceBar } from './facebar'
import { TouchControls } from './touch'
import { Chat } from './chat'
import { Bubbles } from './bubbles'
import { Effects } from './effects'
import { Arrows } from './arrows'
import { Destruction } from './destruction'
import { DayNight } from './daynight'
import { Building } from './building'
import { createRealm, inRealm } from './realm'
import { buildCastle } from './castle'
import { Portals, type Gate } from './portal'
import * as blocks from './blocks'
import { initBlocks, blockAtPoint, type BlockSpec } from './blocks'
import { initBuildHud } from './buildhud'
import { BlockGhost } from './blockghost'
import { Fireworks, SHELLS } from './fireworks'
import { FirstPersonAim } from './firstperson'
import { Minimap } from './minimap'
import { Health } from './health'
import { Shark } from './shark'
import { Cats } from './cats'
import { EmoteController } from './emotes'
import { EmoteWheel } from './emotewheel'
import { ItemWheel } from './itemwheel'
import {
  setWeapon,
  setRide,
  setName,
  setFace,
  setEmote,
  startSlash,
  startJabber,
  popHead,
  SLASH_DURATION,
} from './character'
import { loadProfile, saveProfile } from './profile'
import { SKINS, applySkin } from './skins'
import { sfx } from './audio'
import { Voice } from './voice'
import { music } from './music'

// Render at N64-ish resolution, then upscale with nearest-neighbor (CSS).
const VIEW_W = 320
const VIEW_H = 240

// Who you are survives reloads now: token, name, color, and loadout all come
// from the browser-storage profile (minted on your very first visit).
const profile = loadProfile()
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
createRealm(scene)
// The castle is a world block seeder, not a snapshot: initBlocks builds it
// now and rebuilds it on every welcome, before the room's damage replays.
initBlocks(scene, buildCastle)
const portals = new Portals(scene)

const player = new Player(scene, color, profile.name)
const remotes = new Remotes(scene)
// Your skin: picked in the settings panel, worn immediately, remembered in
// the profile, and broadcast in state so everyone sees your outfit.
let skin = profile.skin
applySkin(player.group, skin)
// Rename yourself any time (settings panel). The new name saves to the
// profile, redraws your tag, and reaches everyone else through the regular
// state broadcast — remotes redraw on the next tick.
function renameCharacter(raw: string): string {
  const next = raw.trim().slice(0, 24)
  if (next && next !== profile.name) {
    profile.name = next
    saveProfile(profile)
    setName(player.group, next)
  }
  return profile.name
}
const webcam = new Webcam()
const faceBar = new FaceBar()
webcam.onFrame = (dataUrl) => {
  setFace(player.group, dataUrl)
  faceBar.set('me', dataUrl, profile.name)
  net.sendFace(dataUrl)
}
const settings = initSettings(
  {
    current: skin,
    options: SKINS,
    onChange: (id) => {
      skin = id
      applySkin(player.group, skin)
      profile.skin = skin
      saveProfile(profile)
      sfx.equip(true)
    },
  },
  { current: profile.name, onChange: renameCharacter },
  (key, value) => {
    if (key === 'webcamBar') {
      // Display-only: the strip shows whoever is broadcasting, whether or not
      // your own camera is on.
      faceBar.setEnabled(value)
    } else if (key === 'webcamFace') {
      if (value) {
        // Prompts for the camera. Denied (or no camera) flips the switch back.
        void webcam.start().then((ok) => {
          if (!ok) setSetting('webcamFace', false)
        })
      } else {
        webcam.stop()
        setFace(player.group, null)
        faceBar.remove('me')
        net.sendFace('')
      }
    }
  },
)
faceBar.setEnabled(settings.webcamBar)
// Camera was on last session: restart it. Denied (or camera gone) flips the
// switch back off, same as toggling it by hand.
if (settings.webcamFace) {
  void webcam.start().then((ok) => {
    if (!ok) setSetting('webcamFace', false)
  })
}
const touch = new TouchControls()
const health = new Health()
player.onRespawn = () => health.revive()
const cats = new Cats(scene, touch.active)

// Sounds fade with distance from the local player.
function distVol(pos: THREE.Vector3, range = 70): number {
  return Math.max(0, 1 - player.group.position.distanceTo(pos) / range)
}

const net = new Net()
const voice = new Voice(net)
net.onWelcome = (players, craters, blocks, worldDamage, faces) => {
  remotes.clear()
  voice.reset() // reconnects mint a new id; old voice links are orphaned
  players.forEach((p) => {
    remotes.upsert(p)
    voice.peerJoined(p.id)
  })
  // Our own face reappears for everyone else on the next captured frame.
  // Remote ids are minted fresh on reconnect, so the strip starts over too —
  // our own tile survives, since it's keyed 'me' and refreshed by the capture
  // loop rather than the network.
  faceBar.clear()
  faces.forEach((f) => {
    remotes.setFace(f.id, f.d)
    faceBar.set(f.id, f.d, remotes.nameOf(f.id))
  })
  // Catch up on world damage. Silent: no debris bursts, and reconnect
  // replays dedupe to a no-op inside addCraters.
  destruction.applyRemote(craters, true)
  // Blocks get a full reset instead: some may have died while we were away.
  // The castle regenerates pristine inside this call, then takes the room's
  // accumulated damage back on top.
  building.replay(blocks, worldDamage)
}
net.onState = (p) => {
  const isNew = !remotes.getGroup(p.id)
  remotes.upsert(p)
  if (isNew) voice.peerJoined(p.id)
}
net.onLeave = (id) => {
  remotes.remove(id)
  faceBar.remove(id)
  voice.peerLeft(id)
}
net.onFace = (id, dataUrl) => {
  remotes.setFace(id, dataUrl)
  if (dataUrl) faceBar.set(id, dataUrl, remotes.nameOf(id))
  else faceBar.remove(id)
}
net.connect()

type Weapon = 'none' | 'gun' | 'sword' | 'shovel' | 'bow' | 'builder' | 'firework'
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

// Emotes: the wheel picks one, the controller times it out, and the id rides
// along in the state we already broadcast so remotes replay the pose.
const emotes = new EmoteController()
emotes.onChange = (id) => {
  setEmote(player.group, id)
  if (id !== 'none') sfx.emote(id)
}
const emoteWheel = new EmoteWheel(touch.active)
emoteWheel.onPick = (id) => emotes.play(id)
remotes.onEmote = (id, emote) => {
  const group = remotes.getGroup(id)
  sfx.emote(emote, group ? distVol(group.position, 60) : 0.6)
}

setInterval(() => {
  net.sendState({
    x: player.group.position.x,
    y: player.group.position.y,
    z: player.group.position.z,
    ry: player.group.rotation.y,
    color,
    name: profile.name,
    pose: player.pose,
    weapon,
    ride,
    skin,
    talk: Math.round(voice.level * 100) / 100,
    emote: emotes.current,
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
const shark = new Shark(scene, net, effects, remotes, health)
const building = new Building(effects, net)
building.volumeAt = (pos) => distVol(pos, 50)
const buildHud = initBuildHud()
buildHud.setMaterial(material)
const blockGhost = new BlockGhost(scene)
// Everything that only makes sense with the builder out: the material chips
// and (on touch, which has no right button) the break key.
function setBuildUi(v: boolean): void {
  buildHud.setVisible(v)
  const breakBtn = document.getElementById('touch-break')
  if (breakBtn) breakBtn.style.display = v ? 'flex' : 'none'
}
setBuildUi(weapon === 'builder')

// Everything equip goes through these two, whether it came from a hotkey or
// a wheel wedge — so the sound, the build HUD, and the saved loadout can
// never drift apart.
function equipWeapon(next: Weapon): void {
  weapon = next
  bowDrawStart = -1
  setWeapon(player.group, weapon)
  sfx.equip(weapon !== 'none')
  setBuildUi(weapon === 'builder')
  saveLoadout()
}
function equipRide(next: Ride): void {
  ride = next
  setRide(player.group, ride)
  player.ride = ride
  sfx.equip(ride !== 'none')
  if (ride === 'ramsey') sfx.ramseyMount()
  saveLoadout()
}

// Item wheels: hold E and sweep for what's in your hand, hold Q for how you
// get around. Tap instead to pin the wheel open and click. The single-key
// toggles below still work for muscle memory.
new ItemWheel(
  'KeyE',
  'hand',
  [
    { id: 'none', icon: '✋', label: 'empty' },
    { id: 'gun', icon: '🚀', label: 'G bazooka' },
    { id: 'sword', icon: '🗡️', label: 'H katana' },
    { id: 'shovel', icon: '⛏️', label: 'F shovel' },
    { id: 'bow', icon: '🏹', label: 'B bow' },
    { id: 'builder', icon: '🧱', label: 'T builder' },
    { id: 'firework', icon: '🎆', label: 'K firework' },
  ],
  () => weapon,
  (id) => equipWeapon(id as Weapon),
)
new ItemWheel(
  'KeyQ',
  'ride',
  [
    { id: 'none', icon: '🚶', label: 'on foot' },
    { id: 'wheelchair', icon: '🦽', label: 'R wheelchair' },
    { id: 'ramsey', icon: '🧍', label: 'Y ramsey' },
  ],
  () => ride,
  (id) => equipRide(id as Ride),
)
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
  // Same rule as craters: only the rocket's owner scores the hit, so one
  // blast can't be counted once per client in the room.
  shark.blast(center)
}
net.onBlockPlace = (gx, gy, gz, m) => building.applyRemotePlace(gx, gy, gz, m)
net.onBlockHit = (gx, gy, gz, dmg) => building.applyRemoteHit(gx, gy, gz, dmg)

const fireworks = new Fireworks(scene)
// Fireworks are loud and high up, so they carry much further than gunfire.
fireworks.onLaunch = (pos) => sfx.whistle(distVol(pos, 110))
fireworks.onBurst = (pos) => sfx.burst(distVol(pos, 200))
net.onFirework = (id, x, z, c) => fireworks.plant(id, x, z, c)
net.onFireworkLaunch = (id) => fireworks.launchAll(id)
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
cats.onPet = (index) => net.sendPet(index)
net.onPet = (index) => cats.pet(index)
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
  emotes.stop() // no waving mid-rocket
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
      if (shark.swing(player.group.position, player.group.rotation.y, 34)) return
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
      // A shovel to the nose counts too, and beats digging a hole in the sea.
      if (shark.swing(player.group.position, player.group.rotation.y, 24)) return
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
  } else if (weapon === 'firework' && now - lastAttack > 450) {
    lastAttack = now
    sfx.plant()
    fp.swing()
    startSlash(player.group)
    net.sendSlash()
    // Plant at the bottom of the swing, same reach rules as the shovel.
    setTimeout(() => {
      const aimed = fp.isActive ? fp.aimedDigPoint() : null
      const ry = player.group.rotation.y
      const x = aimed ? aimed.x : player.group.position.x + Math.sin(ry) * 1.6
      const z = aimed ? aimed.z : player.group.position.z + Math.cos(ry) * 1.6
      const shell = Math.floor(Math.random() * SHELLS.length)
      fireworks.plant('me', x, z, shell)
      net.sendFirework(x, z, shell)
    }, SLASH_DURATION * 500)
  }
}

// Where the builder is pointing this instant: the cell a click fills and the
// block it would knock out. The ghost draws it and both clicks act on it, so
// there's no second copy of the aiming math to drift.
function buildAim(): ReturnType<Building['aim']> {
  if (weapon !== 'builder' || player.dead) return null
  return building.aim(
    player.group.position,
    player.group.rotation.y,
    fp.isActive ? fp.aimedDigPoint() : null,
  )
}

// Right-click with the builder equipped: pop out the block the cage is around.
let lastBreak = 0
function breakBlock(): void {
  const now = performance.now()
  if (player.dead || now - lastBreak < 200) return
  lastBreak = now
  emotes.stop()
  fp.swing()
  startSlash(player.group)
  net.sendSlash()
  if (!building.breakAt(
    player.group.position,
    player.group.rotation.y,
    fp.isActive ? fp.aimedDigPoint() : null,
  )) {
    sfx.slash(0.25) // whiffed at empty air
  }
}

// Light every firework we've planted. They also self-launch when the fuse
// burns down, so touch players (no keyboard) still get the show.
function launchFireworks(): void {
  if (!fireworks.hasPlanted('me')) return
  fireworks.launchAll('me')
  net.sendFireworkLaunch()
}
window.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement
  if (touch.active || chat.isOpen || emoteWheel.isOpen) return
  if (target !== document.body && target.tagName !== 'CANVAS') return
  // In first person the first click grabs the mouse; later clicks attack.
  if (fp.claimClickForLock()) return
  // Right-click is the builder's eraser. Every other tool ignores it — it
  // used to fire whatever you were holding, which nobody meant to do.
  if (e.button !== 0) {
    if (e.button === 2 && weapon === 'builder') breakBlock()
    return
  }
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
// Right-click is reserved for in-game actions; the chat input keeps the
// browser menu so paste still works.
window.addEventListener('contextmenu', (e) => {
  if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault()
})
if (touch.active) {
  const fire = document.createElement('div')
  fire.id = 'touch-fire'
  fire.textContent = 'B'
  fire.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    attack()
  })
  // Touch has no right button, so the eraser gets its own key — shown only
  // while the builder is out (setBuildUi owns that).
  const dig = document.createElement('div')
  dig.id = 'touch-break'
  dig.textContent = '⛏'
  dig.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    breakBlock()
  })
  const mic = document.createElement('div')
  mic.id = 'mic-open'
  mic.textContent = '🎤'
  mic.style.opacity = '0.4'
  mic.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    void voice.toggle().then((on) => {
      setVoicePref(on)
      sfx.equip(on)
    })
  })
  document.body.append(fire, dig, mic)
  setBuildUi(weapon === 'builder') // the break key only exists now
}

// Voice chat is ON by default: the mic starts as soon as you join (browser
// permitting). V or the mic button mutes, and the choice sticks in the
// profile. An explicit toggle saves; a failed auto-start doesn't — so a
// one-time permission hiccup won't silently flip the default off.
function setVoicePref(on: boolean): void {
  profile.voice = on
  saveProfile(profile)
  const mic = document.getElementById('mic-open')
  if (mic) mic.style.opacity = on ? '1' : '0.4'
}
if (profile.voice) {
  void voice.toggle().then((on) => {
    if (on) {
      setVoicePref(true)
      return
    }
    // Blocked pre-gesture (autoplay policy) — retry once on the first click.
    window.addEventListener(
      'pointerdown',
      (e) => {
        if ((e.target as HTMLElement)?.id === 'mic-open') return // its own handler toggles
        if (profile.voice && !voice.enabled) void voice.toggle().then((ok) => ok && setVoicePref(true))
      },
      { once: true },
    )
  })
}

const chat = new Chat()
shark.onDeath = () => chat.addMessage('🦈', 'blub…')
const bubbles = new Bubbles(camera, renderer.domElement)
// Longer messages get a longer mouth-flap while the bubble is up.
const jabberFor = (text: string): number => Math.min(4000, 900 + text.length * 55)
chat.onSend = (text) => {
  sfx.chat()
  net.sendChat(text)
  bubbles.show(player.group, text)
  startJabber(player.group, jabberFor(text))
  chat.addMessage(profile.name, text)
  minimap.talkLocal()
}
net.onChat = (id, senderName, text) => {
  sfx.chat()
  const group = remotes.getGroup(id)
  if (group) {
    bubbles.show(group, text)
    startJabber(group, jabberFor(text))
  }
  chat.addMessage(senderName, text)
  minimap.talk(id)
}

const status = document.getElementById('status')!
setInterval(() => {
  const others = remotes.count
  const mute = sfx.muted ? ' · 🔇 (M)' : ''
  const mic = voice.enabled ? ' · 🎤 live (V)' : ''
  const where = shadow ? ' · 🌑 shadow realm' : ''
  status.textContent = net.connected
    ? `${profile.name} · ${others} other ${others === 1 ? 'player' : 'players'} here${where}${mute}${mic}`
    : `${profile.name} · connecting...${mute}${mic}`
}, 500)

const keys = new Set<string>()
const MASH_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'])
let mashCount = 0
window.addEventListener('keydown', (e) => {
  keys.add(e.code)
  // Being dragged off by the shark: mash to fight your way out. Held keys
  // don't count, so it has to be actual panic.
  if (shark.draggingMe && !e.repeat && MASH_KEYS.has(e.code) && ++mashCount >= 4) {
    mashCount = 0
    shark.struggle()
  }
  if (e.code === 'Enter' && !chat.isOpen) {
    e.preventDefault()
    chat.open()
  }
  if (e.code === 'KeyG') equipWeapon(weapon === 'gun' ? 'none' : 'gun')
  if (e.code === 'KeyH') equipWeapon(weapon === 'sword' ? 'none' : 'sword')
  if (e.code === 'KeyF') equipWeapon(weapon === 'shovel' ? 'none' : 'shovel')
  if (e.code === 'KeyB') equipWeapon(weapon === 'bow' ? 'none' : 'bow')
  if (e.code === 'KeyT') equipWeapon(weapon === 'builder' ? 'none' : 'builder')
  if (weapon === 'builder' && /^Digit[1-4]$/.test(e.code)) {
    material = Number(e.code.slice(5)) - 1
    buildHud.setMaterial(material)
    saveLoadout()
  }
  if (e.code === 'KeyK') equipWeapon(weapon === 'firework' ? 'none' : 'firework')
  if (e.code === 'KeyL') launchFireworks()
  if (e.code === 'KeyR') equipRide(ride === 'wheelchair' ? 'none' : 'wheelchair')
  if (e.code === 'KeyY') equipRide(ride === 'ramsey' ? 'none' : 'ramsey')
  if (e.code === 'KeyP') cats.petNearest()
  if (e.code === 'KeyM') sfx.toggleMute()
  if (e.code === 'KeyV' && !e.repeat)
    void voice.toggle().then((on) => {
      setVoicePref(on)
      sfx.equip(on)
    })
})
window.addEventListener('keyup', (e) => keys.delete(e.code))

const gameCamera = new GameCamera(camera)
const fp = new FirstPersonAim(player, renderer.domElement, camera, color)
const minimap = new Minimap(touch.active, color)
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

// Crossing over. Which world you're in is derived from your own position —
// no realm field in the protocol, no second scene — so walking through a
// gate, respawning out of the lava, and reconnecting all agree by
// construction. `shadow` drives the sky, the fog, the burn, and the banner.
const flash = document.getElementById('flash')!
const banner = document.getElementById('realm-banner')!
let shadow = inRealm(player.group.position.x, player.group.position.z)
let burnT = 0

// (Re)start a CSS animation: tear it off, force a reflow, put it back.
function replayAnim(el: HTMLElement, anim: string): void {
  el.style.animation = 'none'
  void el.offsetWidth
  el.style.animation = anim
}

function announce(title: string): void {
  banner.textContent = title
  replayAnim(flash, 'portal-flash 0.7s ease-out')
  replayAnim(banner, 'realm-banner 3.2s ease forwards')
}

function crossTo(gate: Gate): void {
  const ex = gate.x
  const ez = gate.z + gate.exitZ
  player.teleport(ex, heightAt(ex, ez), ez, gate.exitRy)
  gameCamera.snapTo(player)
  sfx.warp()
  announce(gate.name)
  // Let the keep introduce itself once the fog gives it up.
  if (inRealm(ex, ez)) setTimeout(() => sfx.toll(), 950)
}

// Debug handle so agents (and curious friends) can poke the game from the
// console: game.player, game.remotes, game.net. `draw()` forces a frame,
// which is the only way to see anything in a background tab (Chrome throttles
// requestAnimationFrame to 0fps there, so the canvas just goes stale).
;(window as unknown as Record<string, unknown>).game = {
  player,
  remotes,
  net,
  fp,
  settings,
  daynight,
  voice,
  arrows,
  health,
  shark,
  effects,
  music,
  building,
  blockGhost,
  cats,
  fireworks,
  webcam,
  emotes,
  portals,
  gameCamera,
  blocks,
  faceBar,
  scene,
  camera,
  draw: () => renderer.render(scene, camera),
}

const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05)

  gameCamera.addYaw(touch.consumeYaw())
  music.setEnabled(settings.music && !sfx.muted)
  fp.paused = emoteWheel.isOpen // the wheel borrows the mouse
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
  const gate = portals.update(dt, player.group.position)
  if (gate) crossTo(gate)
  const nowShadow = inRealm(player.group.position.x, player.group.position.z)
  if (nowShadow !== shadow) {
    shadow = nowShadow
    // Changed worlds without using a gate — respawned out of the lava, most
    // likely. Same fanfare, and hold the gates off so you don't fall
    // straight back through the one you land next to.
    if (!gate) {
      announce(nowShadow ? 'THE SHADOW REALM' : 'THE ISLAND')
      sfx.warp()
      portals.hold()
      gameCamera.snapTo(player)
    }
  }
  // The realm's sea is molten. player.ts floats you in it exactly like water,
  // which is the joke: the only difference is that it kills you.
  if (shadow && player.pose === 'swim' && !player.dead) {
    health.damage(52 * dt)
    burnT -= dt
    if (burnT <= 0) {
      burnT = 0.35
      sfx.sizzle()
    }
  } else {
    burnT = 0
  }

  health.update(dt)
  voice.update(dt)
  player.group.userData.talk = voice.level // our own mouth flaps too
  voice.updateVolumes(player.group.position, (id) => remotes.getGroup(id)?.position)
  fp.setDraw(
    weapon === 'bow' && bowDrawStart >= 0
      ? Math.min(1, (performance.now() - bowDrawStart) / BOW_DRAW_MS)
      : 0,
  )
  // Moving, jumping or dying drops you out of an emote.
  emotes.update(player.moving || player.dead || keys.has('Space') || touch.jumpHeld)
  bubbles.update()
  effects.update(dt, [...remotes.targets(), { id: 'me', pos: player.group.position }])
  arrows.update(dt, [...remotes.stickTargets(), { id: 'me', group: player.group }])
  fireworks.update(dt)
  remotes.update(dt)
  // After the player and remotes have moved: the shark chases current
  // positions, and when it has you it overrides where you ended up.
  shark.update(dt, player)
  if (!shark.draggingMe) mashCount = 0
  cats.update(dt, player.group.position)
  gameCamera.update(dt, keys, player, settings, fp)
  // After the player has settled: the ghost is aimed from where you actually
  // ended up this frame, so it never lags a step behind your feet.
  const aim = buildAim()
  blockGhost.update(
    aim && {
      place: { gx: aim.gx, gy: aim.gy, gz: aim.gz, valid: aim.valid },
      break: aim.breakGy === null ? null : { gx: aim.gx, gy: aim.breakGy, gz: aim.gz },
      m: material,
    },
    dt,
  )
  daynight.update(settings, camera.position, shadow ? 1 : 0)
  minimap.update(player, remotes, settings, voice.level)

  renderer.render(scene, camera)
})
