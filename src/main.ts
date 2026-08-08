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
import { DayNight, SUN_AIM_DOT } from './daynight'
import { Building } from './building'
import { createRealm, inRealm } from './realm'
import { buildCastle } from './castle'
import { Portals, type Gate } from './portal'
import * as blocks from './blocks'
import { initBlocks, blockAtPoint, type BlockSpec } from './blocks'
import { initBuildHud } from './buildhud'
import { BlockGhost } from './blockghost'
import { Fireworks, SHELLS } from './fireworks'
import { FIFTY_RPM, FIFTY_BLOCK_DAMAGE, FIFTY_LETHAL, FIFTY_CRATER } from './fifty'
import { FirstPersonAim } from './firstperson'
import { Scope, ScopeInput, hitscan } from './sniper'
import { Minimap } from './minimap'
import { Health, MAX_HP } from './health'
import { Shark, SHARK_TARGET_ID } from './shark'
import { Mobs, MOB_TARGET_PREFIX } from './mobs'
import { Skeletons, SKEL_TARGET_PREFIX } from './skeletons'
import { Cats } from './cats'
import { Meckies } from './meckies'
import { Stripper } from './stripper'
import { EmoteController } from './emotes'
import { EmoteWheel } from './emotewheel'
import { ItemWheel } from './itemwheel'
import { GameMap } from './map'
import { RocketRide, DESTINATIONS, LAND_BLAST_RADIUS, LAND_BLAST_DAMAGE } from './rocket'
import {
  setWeapon,
  setRide,
  setName,
  setFace,
  setEmote,
  setLook,
  setHat,
  getLook,
  startSlash,
  startJabber,
  popHead,
  SLASH_DURATION,
} from './character'
import { Critters } from './critters'
import { Treasure } from './treasure'
import { Cheats, type CheatName } from './cheats'
import { Hud } from './hud'
import { Killboard } from './killboard'
import { loadProfile, saveProfile } from './profile'
import { SKINS, applySkin } from './skins'
import { sfx } from './audio'
import { Voice } from './voice'
import { music } from './music'
import { JumpScares } from './jumpscares'

// Render at N64-ish resolution, then upscale with nearest-neighbor (CSS).
const VIEW_W = 320
const VIEW_H = 240
const FOV = 70

// How far the head glances toward the third-person camera's heading.
const GLANCE = 0.9

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
const camera = new THREE.PerspectiveCamera(FOV, VIEW_W / VIEW_H, 0.1, 500)
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
new JumpScares(() => settings.jumpScares).start()
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
// Anything that hurts us and isn't a player — a bear, a skeleton, the lava —
// still brings the house down. Nobody to strike, but they shout about it.
health.onHurt = () => meckies.rally()
const cats = new Cats(scene, touch.active)
// The Meckies: residents you can pick up and carry somewhere else.
const meckies = new Meckies(scene, touch.active)
const hud = new Hud()
const killboard = new Killboard()
const treasure = new Treasure()

// Sounds fade with distance from the local player.
function distVol(pos: THREE.Vector3, range = 70): number {
  return Math.max(0, 1 - player.group.position.distanceTo(pos) / range)
}

const net = new Net()
const voice = new Voice(net)
net.onWelcome = (players, craters, blocks, worldDamage, faces, meck, scores, found) => {
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
  // Wherever the Meckies were left, including in somebody's arms.
  for (const [i, x, z, by] of meck) meckies.applyRemote(i, x, z, by)
  // Treasure somebody already dug up, and the damage already done.
  found.forEach((i) => treasure.markClaimed(i))
  killboard.setScores(scores)
}
net.onState = (p) => {
  const isNew = !remotes.getGroup(p.id)
  remotes.upsert(p)
  if (isNew) voice.peerJoined(p.id)
}
net.onLeave = (id) => {
  meckies.dropCarriedBy(id)
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

type Weapon =
  | 'none' | 'gun' | 'sniper' | 'm2' | 'sword' | 'shovel' | 'bow' | 'builder' | 'firework'
type Ride = 'none' | 'wheelchair' | 'ramsey' | 'plane'
// Loadout picks up where you left off last session (profile validates them).
let weapon = profile.weapon as Weapon
let ride = profile.ride as Ride
let material = profile.material // index into MATERIALS, picked with 1-4 while building
// Whatever you dug up last session is still on your head.
let hat = profile.hat
setWeapon(player.group, weapon)
setRide(player.group, ride)
setHat(player.group, hat)
player.ride = ride

function saveLoadout(): void {
  profile.weapon = weapon
  profile.ride = ride
  profile.material = material
  profile.hat = hat
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
  const look = getLook(player.group)
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
    hp: look.pitch,
    hy: look.yaw,
    hat,
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
const mobs = new Mobs(scene, net, effects, remotes, health)
// The castle garrison. Hosted by one client like the shark and the land mobs,
// and only ever a problem for people who went through the portal.
const skeletons = new Skeletons(scene, net, remotes, effects, health)
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
// Anything that ends a burst: swapping weapons, dying, losing focus, or an
// overlay eating the mouseup. A stuck `firing` means the gun never stops, and
// that is its own kind of hang.
function ceaseFire(): void {
  firing = false
}
window.addEventListener('blur', ceaseFire)

function equipWeapon(next: Weapon): void {
  ceaseFire()
  weapon = next
  bowDrawStart = -1
  // Putting the rifle away puts the scope away with it, latched or not.
  if (weapon !== 'sniper') scopeStow()
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
const handWheel = new ItemWheel(
  'KeyE',
  'hand',
  [
    { id: 'none', icon: '✋', label: 'empty' },
    { id: 'gun', icon: '🚀', label: 'G bazooka' },
    { id: 'sniper', icon: '🎯', label: 'N sniper' },
    { id: 'sword', icon: '🗡️', label: 'H katana' },
    { id: 'shovel', icon: '⛏️', label: 'F shovel' },
    { id: 'bow', icon: '🏹', label: 'B bow' },
    { id: 'builder', icon: '🧱', label: 'T builder' },
    { id: 'firework', icon: '🎆', label: 'K firework' },
    { id: 'm2', icon: '🔫', label: 'O fifty cal' },
  ],
  () => weapon,
  (id) => equipWeapon(id as Weapon),
)
const rideWheel = new ItemWheel(
  'KeyQ',
  'ride',
  [
    { id: 'none', icon: '🚶', label: 'on foot' },
    { id: 'wheelchair', icon: '🦽', label: 'R wheelchair' },
    { id: 'ramsey', icon: '🧍', label: 'Y ramsey' },
    { id: 'plane', icon: '✈️', label: 'U plane' },
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
  mobs.blast(center)
  skeletons.blast(center)
  // Wildlife caught in the blast, under the same one-owner rule.
  const duck = critters.duckPosition
  if (duck && duck.distanceTo(center) < 6) killDuck(profile.name, true)
  if (critters.nessieHitBy(center, 9)) annoyNessie(profile.name, true)
}

// --- easter eggs -----------------------------------------------------------

const critters = new Critters(scene, effects)
const cheats = new Cheats(effects)
// Are we pointing at the sun? Nothing we fire can physically reach it, so a
// hit is judged on aim alone — which means only first person can line it up,
// and only in daylight.
const SUN_AIM = new THREE.Vector3()
function aimedAtSun(dir: THREE.Vector3): boolean {
  return daynight.sunUp && dir.dot(daynight.sunDirection(SUN_AIM)) > SUN_AIM_DOT
}

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
  saveLoadout()
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
  saveLoadout()
  net.sendEgg('duck')
}

function annoyNessie(byName: string, mine: boolean): void {
  critters.diveNessie()
  sfx.bellow(0.8)
  hud.feed(`${byName} hit something enormous out at sea`)
  if (!mine) return
  hud.banner('IT DIVED', 2600)
  net.sendEgg('nessie')
}

// Nothing can physically reach the sun, so a hit is judged on aim: first
// person, pointing straight at it, in daylight. It sulks for 45 seconds.
function strikeSun(byName: string, mine: boolean): void {
  if (daynight.isAngry) return
  setTimeout(() => {
    daynight.strike()
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
net.onBlockPlace = (gx, gy, gz, m) => building.applyRemotePlace(gx, gy, gz, m)
net.onBlockHit = (gx, gy, gz, dmg) => building.applyRemoteHit(gx, gy, gz, dmg)

net.onFifty = (_id, from, to) => {
  const a = new THREE.Vector3(...from)
  effects.spawnTracer(a, new THREE.Vector3(...to))
  effects.spawnMuzzleFlash(a)
  sfx.fiftyShot(distVol(a, 140))
}
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
// Rocket travel and the map that aims it. Tab opens the map; clicking a
// friend or the island you're not on straps a rocket to your chair and throws
// you over there. See rocket.ts for why the flight itself sends nothing.
const rocket = new RocketRide(effects)
const map = new GameMap(touch.active)
rocket.livePos = (id) => remotes.getGroup(id)?.position
rocket.onLaunch = () => {
  emotes.stop()
  // The rocket goes on the chair, so you're in the chair. Never yanks anyone
  // off Ramsey — he gets to come along. Goes through equipRide so the ride
  // wheel's selection follows along too.
  if (ride === 'none') equipRide('wheelchair')
  emotes.play('rocketfly')
}
// The hero pose is the whole reason for the trip, so it gets a moment where
// movement can't cancel it — otherwise anyone still leaning on W (which is
// most people, four seconds into a flight) snaps out of it on the first frame
// and never sees the shot.
const HERO_HOLD_MS = 1400
let heroUntil = 0
rocket.onLand = (pos) => {
  emotes.play('hero')
  heroUntil = performance.now() + HERO_HOLD_MS
  effects.spawnImpact(pos)
  sfx.impact()
  net.sendLand(pos)
  // Same rule the rockets follow: the traveller alone mints the world damage,
  // so per-client divergence can never fork the terrain. No self-damage —
  // sticking the landing is the whole point.
  destruction.rocketCrater(pos)
  building.blastDamage(pos)
  shark.blast(pos)
}
net.onLand = (_id, at) => {
  const pos = new THREE.Vector3(...at)
  effects.spawnImpact(pos)
  sfx.impact(distVol(pos, 110))
  // Being someone's landing pad. Self-applied, exactly like blast knockback.
  const d = player.group.position.distanceTo(pos)
  if (d >= LAND_BLAST_RADIUS) return
  const k = 1 - d / LAND_BLAST_RADIUS
  const dir = player.group.position.clone().sub(pos)
  dir.y = 0
  if (dir.lengthSq() < 0.01) dir.set(0, 0, 1)
  dir.normalize()
  player.applyImpulse(dir.x * 22 * k, 8 + 10 * k, dir.z * 22 * k)
  health.damage(LAND_BLAST_DAMAGE * k)
}
map.data = () => ({
  me: {
    x: player.group.position.x,
    z: player.group.position.z,
    ry: player.group.rotation.y,
    color,
    name: profile.name,
  },
  friends: remotes.list(),
})
// The castle counts as a destination like anywhere else — the gate is still
// the scenic route, the rocket is the fast one.
map.onPickPlayer = (id) => {
  const group = remotes.getGroup(id)
  if (!group) return
  rocket.launch(player, { x: group.position.x, z: group.position.z, followId: id })
}
map.onPickDest = (index) => {
  const dest = DESTINATIONS[index]
  if (dest && rocket.launch(player, dest.spot())) chat.addMessage('🚀', `to ${dest.name}!`)
}
// Keyboard shortcut, no map required: J cycles to the next place that isn't
// this one — island, island, castle, round again.
function rocketToNextIsland(): void {
  const p = player.group.position
  const here = DESTINATIONS.findIndex((d) => d.here(p.x, p.z))
  const next = (here + 1) % DESTINATIONS.length
  map.onPickDest(next)
}

meckies.onMove = (i, x, z, by) => net.sendMeckie(i, x, z, by)
meckies.personName = () => profile.name
meckies.onWarCry = (group, text) => bubbles.show(group, text)
meckies.onSay = (name, text) => chat.addMessage(name, text)
// Struck through the ordinary `hit` path, so the rules still hold: attackers
// only ever send damage, and the victim is the one who decides it was fatal
// and announces their own death.
meckies.onStrike = (id) => net.sendHit(id, MAX_HP)
// 'me' on the wire means the sender, so resolve it to their id before it
// reaches the Meckies — to us they're just another carrier.
net.onMeckie = (id, i, x, z, by) => meckies.applyRemote(i, x, z, by === 'me' ? id : by)
cats.onPet = (index) => net.sendPet(index)
net.onPet = (index) => cats.pet(index)
net.onSnipe = (_id, from, to) => {
  const muzzle = new THREE.Vector3(...from)
  const impact = new THREE.Vector3(...to)
  // A rifle report carries most of the way across the island.
  sfx.sniperShot(distVol(muzzle, 200))
  sfx.boltCycle(distVol(muzzle, 40))
  effects.spawnMuzzleFlash(muzzle)
  effects.spawnTracer(muzzle, impact)
  effects.spawnDebris(impact, 0x6b4526, 3, 3)
}
net.onSlash = (id) => {
  const group = remotes.getGroup(id)
  sfx.slash(group ? distVol(group.position) : 0.7)
  remotes.slash(id)
}
// Who last hurt us, and when. The killboard needs a culprit, and under
// health.ts we're the only one who knows — everyone else just sent a `hit`
// and moved on. Stale credit expires, so a shark finishing you 20 seconds
// later doesn't get pinned on the last player who grazed you.
const CREDIT_WINDOW = 10000
let lastAttacker = ''
let lastAttackerAt = 0
net.onHit = (attacker, dmg) => {
  lastAttacker = attacker
  lastAttackerAt = performance.now()
  // avenge BEFORE the damage lands: health.damage fires onHurt, and whichever
  // fires first takes the per-resident cooldown. This one knows who did it and
  // can hit back, so it has to win the race.
  meckies.avenge(attacker)
  health.damage(dmg)
}
// Losing the last of your health is your own announcement to make: the head
// pops here, and everyone else hears about it through `kill`.
health.onDeath = () => {
  const fresh = performance.now() - lastAttackerAt < CREDIT_WINDOW
  if (net.id) net.sendKill(net.id, fresh ? lastAttacker : undefined)
  lastAttacker = ''
  dieLocally()
}
function dieLocally(): void {
  const headPos = popHead(player.group)
  if (headPos) effects.spawnHeadPop(headPos)
  sfx.pop()
  sfx.death()
  // Otherwise a latched scope springs back up the moment you respawn.
  scopeStow()
  player.die()
}
net.onKill = (victim, _killer, killerName, victimName) => {
  hud.feed(killerName ? `${killerName} finished ${victimName}` : `${victimName} died`)
  if (victim === net.id) {
    health.kill()
    dieLocally()
  } else {
    const group = remotes.getGroup(victim)
    sfx.pop(group ? distVol(group.position) : 0.7)
    remotes.decapitate(victim, effects)
  }
}
net.onScores = (scores) => killboard.setScores(scores)

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
// Bullets chew the ground, but a crater is expensive: world.addCraters walks
// every vertex of every terrain tile and recomputes its normals, and it also
// costs a network message the whole room has to replay. One per round at the
// fifty's rate of fire locks the game up. Gate them to roughly the shovel's
// cadence — sustained fire still digs, it just digs at a sane rate.
const BULLET_CRATER_MS = 500
let lastBulletCrater = 0
let bulletSpark = 0
// Trigger held down. Only the M2 uses it; everything else is click-per-shot.
let firing = false
const SWORD_DAMAGE = 55 // two clean swings takes a head off
const SNIPER_DAMAGE = 80 // brutal, but it's two hits and a slow bolt either way
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
    // Rockets expire long before they'd reach the sun, so the sun is hit on
    // aim alone — which means only first person can ever line it up, and
    // only while it's actually up there.
    if (aimedAtSun(dir)) strikeSun(profile.name, true)
  } else if (weapon === 'sniper' && now - lastAttack > 1400) {
    lastAttack = now
    sfx.sniperShot()
    sfx.boltCycle()
    fp.kick()
    fp.cycleBolt()
    // Ray from the eye in first person, so the crosshair never lies about
    // what it is pointing at; from the shoulder, dead level, in third.
    const ry = player.group.rotation.y
    const dir = fp.isActive
      ? fp.aimDir(new THREE.Vector3())
      : new THREE.Vector3(Math.sin(ry), 0, Math.cos(ry)).normalize()
    const origin = fp.isActive
      ? fp.eyePosition(new THREE.Vector3())
      : player.group.position.clone().add(new THREE.Vector3(0, 1.75, 0))
    // Players, the shark and the mobs all ride in one target list, so the
    // ray's own ordering decides who's in front — no second "did it also
    // hit a bear" pass that could double-count one round.
    const hit = hitscan(origin, dir, [
      ...remotes.targets(),
      ...shark.targets(),
      ...mobs.targets(),
      ...skeletons.targets(),
    ])
    // Start the tracer past the muzzle so it isn't drawn through your face.
    const muzzle = origin.clone().addScaledVector(dir, 1.4)
    effects.spawnMuzzleFlash(muzzle)
    effects.spawnTracer(muzzle, hit.point)
    net.sendSnipe(muzzle, hit.point)
    fp.punch(0.1)
    if (hit.id === SHARK_TARGET_ID) {
      shark.shot(SNIPER_DAMAGE)
      sfx.hitmark()
    } else if (hit.id?.startsWith(MOB_TARGET_PREFIX)) {
      mobs.shot(hit.id, SNIPER_DAMAGE)
      sfx.hitmark()
    } else if (hit.id?.startsWith(SKEL_TARGET_PREFIX)) {
      skeletons.shot(hit.id, SNIPER_DAMAGE)
      sfx.hitmark()
    } else if (hit.id) {
      // Same deal as the katana: send the damage, let the victim decide
      // whether that was fatal and announce it back as `kill`.
      net.sendHit(hit.id, SNIPER_DAMAGE)
      sfx.hitmark()
    } else if (hit.kind !== 'sky') {
      sfx.ricochet(distVol(hit.point, 70))
      effects.spawnDebris(hit.point, hit.kind === 'prop' ? 0x4a7a35 : 0x6b4526, 5, 4)
    } else if (aimedAtSun(dir)) {
      // A scoped rifle is a far more sensible way to shoot the sun than a
      // rocket, and the scope makes lining it up genuinely possible.
      strikeSun(profile.name, true)
    }
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
      if (skeletons.swing(player.group.position, player.group.rotation.y, 40)) {
        sfx.hitmark()
        return
      }
      if (shark.swing(player.group.position, player.group.rotation.y, 34)) return
      if (mobs.swing(player.group.position, player.group.rotation.y, 34)) return
      // The duck only eats the blade once nothing that fights back has.
      const duck = critters.duckPosition
      if (duck && duck.distanceTo(player.group.position) < 2.6) {
        killDuck(profile.name, true)
        return
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
      // A shovel to the skull first — a wall behind a skeleton shouldn't eat
      // the swing while something is actively trying to kill you.
      if (skeletons.swing(player.group.position, player.group.rotation.y, 26)) {
        sfx.hitmark()
        return
      }
      const block = meleeBlockTarget()
      if (block) {
        building.hit(block.gx, block.gy, block.gz, 2)
        return
      }
      // A shovel to the nose counts too, and beats digging a hole in the sea.
      if (shark.swing(player.group.position, player.group.rotation.y, 24)) return
      if (mobs.swing(player.group.position, player.group.rotation.y, 24)) return
      const aimed = fp.isActive ? fp.aimedDigPoint() : null
      const ry = player.group.rotation.y
      const dx = aimed ? aimed.x : player.group.position.x + Math.sin(ry) * 1.6
      const dz = aimed ? aimed.z : player.group.position.z + Math.cos(ry) * 1.6
      destruction.dig(dx, dz)
      const found = treasure.tryDig(dx, dz)
      if (found !== null) claimTreasure(found, profile.name, true)
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
  } else if (weapon === 'm2' && now - lastAttack > FIFTY_RPM) {
    lastAttack = now
    sfx.fiftyShot()
    fp.kick()
    const ry = player.group.rotation.y
    const dir = fp.isActive
      ? fp.aimDir(new THREE.Vector3())
      : new THREE.Vector3(Math.sin(ry), 0, Math.cos(ry)).normalize()
    const origin = fp.isActive
      ? fp.eyePosition(new THREE.Vector3())
      : player.group.position.clone().add(new THREE.Vector3(0, 1.75, 0))
    // One ray over everything, the sniper's, so the ordering decides what's
    // in front — plus blocks, which the fifty is meant to eat.
    const hit = hitscan(
      origin,
      dir,
      [...remotes.targets(), ...shark.targets(), ...mobs.targets(), ...skeletons.targets()],
      { blocks: true },
    )
    const muzzle = origin.clone().addScaledVector(dir, 1.4)
    effects.spawnMuzzleFlash(muzzle)
    effects.spawnTracer(muzzle, hit.point)
    net.sendFifty(muzzle, hit.point)
    // It kills anything it touches. Living things die outright; blocks come
    // apart whatever they're made of.
    if (hit.id === SHARK_TARGET_ID) {
      shark.shot(FIFTY_LETHAL)
      sfx.hitmark()
    } else if (hit.id?.startsWith(MOB_TARGET_PREFIX)) {
      mobs.shot(hit.id, FIFTY_LETHAL)
      sfx.hitmark()
    } else if (hit.id?.startsWith(SKEL_TARGET_PREFIX)) {
      skeletons.shot(hit.id, FIFTY_LETHAL)
      sfx.hitmark()
    } else if (hit.id) {
      // A player still gets to announce their own death — attackers only ever
      // send damage. MAX_HP from full health is one round, one kill.
      net.sendHit(hit.id, MAX_HP)
      sfx.hitmark()
    } else if (hit.block) {
      building.hit(hit.block.gx, hit.block.gy, hit.block.gz, FIFTY_BLOCK_DAMAGE)
    } else if (hit.kind !== 'sky') {
      if (
        now - lastBulletCrater > BULLET_CRATER_MS &&
        hit.point.y <= Math.max(heightAt(hit.point.x, hit.point.z), 0) + 0.3
      ) {
        lastBulletCrater = now
        destruction.bite(hit.point.x, hit.point.z, FIFTY_CRATER)
      }
      if (++bulletSpark % 3 === 0) {
        effects.spawnDebris(hit.point, hit.kind === 'prop' ? 0x4a7a35 : 0x6b4526, 3, 5)
      }
    }
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

// Raising the scope: right mouse (tap or hold) and Z both go through here.
// See ScopeInput for why a tap has to latch it. Works straight from third
// person — the game drops into first person for as long as it's up.
const scopeInput = new ScopeInput()
const scopeStow = (): void => scopeInput.stow()

// Light every firework we've planted. They also self-launch when the fuse
// burns down, so touch players (no keyboard) still get the show.
function launchFireworks(): void {
  if (!fireworks.hasPlanted('me')) return
  fireworks.launchAll('me')
  net.sendFireworkLaunch()
}
window.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement
  if (touch.active || chat.isOpen || emoteWheel.isOpen || map.isOpen) return
  if (target !== document.body && target.tagName !== 'CANVAS') return
  // The first click grabs the mouse (both camera modes); later clicks attack.
  if (fp.claimClickForLock()) return
  if (!document.pointerLockElement) {
    // Chrome enforces a short cooldown after Esc; a too-quick click rejects
    // and the one after lands. Keep the console quiet about it.
    const lock = renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined
    void lock?.catch(() => {})
    return
  }
  // Right-click is the builder's eraser and the sniper's scope. Every other
  // tool ignores it — it used to fire whatever you were holding, which
  // nobody meant to do.
  if (e.button !== 0) {
    if (e.button === 2 && weapon === 'builder') breakBlock()
    if (e.button === 2 && weapon === 'sniper') scopeInput.press(performance.now())
    return
  }
  if (weapon === 'bow') {
    bowDrawStart = performance.now()
    sfx.bowDraw()
    return
  }
  // The M2 is belt-fed: hold the button and it keeps going.
  if (weapon === 'm2') firing = true
  attack()
})
window.addEventListener('mouseup', (e) => {
  if (e.button === 2) scopeInput.release(performance.now())
  if (weapon === 'bow') releaseBow()
  else bowDrawStart = -1
  firing = false
})
// Lost focus mid-hold (alt-tab, dev tools) — don't get stuck scoped.
window.addEventListener('blur', scopeStow)
// Third-person mouse look: locked mouse movement orbits the camera — unless
// first person owns it (it turns the player instead) or a wheel is sweeping.
window.addEventListener('mousemove', (e) => {
  if (!document.pointerLockElement || fp.isActive) return
  if (emoteWheel.isOpen || handWheel.isOpen || rideWheel.isOpen || map.isOpen) return
  gameCamera.addLook(e.movementX, e.movementY)
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
mobs.onDeath = (name) =>
  chat.addMessage(name === 'bear' ? '🐻' : '😵', name === 'bear' ? 'the bear is down' : 'gary will return')
const bubbles = new Bubbles(camera, renderer.domElement)
mobs.onSay = (group, text) => bubbles.show(group, text)
const stripper = new Stripper(scene, bubbles)
// Longer messages get a longer mouth-flap while the bubble is up.
const jabberFor = (text: string): number => Math.min(4000, 900 + text.length * 55)
chat.onSend = (text) => {
  // Cheat codes ride the chat channel — everyone in the room already gets
  // the text, so both ends parse it and toggle together. No new message type.
  net.sendChat(text)
  const cheat = cheats.parse(text)
  if (cheat) {
    applyCheat(cheat, profile.name)
    return
  }
  sfx.chat()
  bubbles.show(player.group, text)
  startJabber(player.group, jabberFor(text))
  chat.addMessage(profile.name, text)
  minimap.talkLocal()
}
net.onChat = (id, senderName, text) => {
  const cheat = cheats.parse(text)
  if (cheat) {
    applyCheat(cheat, senderName)
    return
  }
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
  if (e.code === 'KeyN') equipWeapon(weapon === 'sniper' ? 'none' : 'sniper')
  if (e.code === 'KeyZ' && !e.repeat && weapon === 'sniper') scopeInput.toggle()
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
  if (e.code === 'KeyO') equipWeapon(weapon === 'm2' ? 'none' : 'm2')
  if (e.code === 'KeyL') launchFireworks()
  if (e.code === 'KeyR') equipRide(ride === 'wheelchair' ? 'none' : 'wheelchair')
  if (e.code === 'KeyY') equipRide(ride === 'ramsey' ? 'none' : 'ramsey')
  if (e.code === 'KeyU') equipRide(ride === 'plane' ? 'none' : 'plane')
  if (e.code === 'KeyJ') rocketToNextIsland()
  if (e.code === 'KeyU') meckies.toggleNearest()
  if (e.code === 'KeyP') cats.petNearest()
  if (e.code === 'KeyM') sfx.toggleMute()
  if (e.code === 'KeyV' && !e.repeat)
    void voice.toggle().then((on) => {
      setVoicePref(on)
      sfx.equip(on)
    })
  // Held, FPS-style. I for info, since Tab is the map and N is the sniper.
  if (e.code === 'KeyI' && !chat.isOpen) {
    killboard.setHats(allHats())
    killboard.show()
  }
})
window.addEventListener('keyup', (e) => {
  keys.delete(e.code)
  if (e.code === 'KeyI') killboard.hide()
})

// Everyone's headwear, so the killboard can badge the crown-wearer.
function allHats(): Map<string, string> {
  const hats = remotes.hats()
  if (net.id) hats.set(net.id, hat)
  return hats
}

const gameCamera = new GameCamera(camera)
const fp = new FirstPersonAim(player, renderer.domElement, camera, color)
const scope = new Scope(camera, FOV)
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
  mobs,
  effects,
  music,
  building,
  destruction,
  blockGhost,
  cats,
  meckies,
  stripper,
  critters,
  treasure,
  cheats,
  fireworks,
  webcam,
  emotes,
  portals,
  gameCamera,
  blocks,
  skeletons,
  faceBar,
  rocket,
  map,
  scene,
  camera,
  attack,
  scope,
  draw: () => renderer.render(scene, camera),
}

const clock = new THREE.Clock()
let remoteTrailT = 0
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05)

  gameCamera.addYaw(touch.consumeYaw())
  music.setEnabled(settings.music && !sfx.muted)
  // The score follows you through the portal.
  music.setScore(shadow ? 'shadow' : 'island')
  // Any overlay borrows the mouse — the wheels and the travel map alike.
  fp.paused = emoteWheel.isOpen || handWheel.isOpen || rideWheel.isOpen || map.isOpen
  // The scope only comes up when you're actually holding the rifle, on your
  // feet, and nothing else owns the mouse.
  scope.setActive(
    scopeInput.isUp && weapon === 'sniper' && !touch.active && !rocket.active && !player.dead && !fp.paused,
  )
  scope.update(dt)
  // No aiming down a scope while the rocket flies you; the chase cam sells it.
  // Scoping in forces first person for as long as the scope is up, even if
  // the player normally plays in third. The plane counts as a reason to be in
  // first person on its own — a cockpit view needs no weapon in hand.
  fp.setActive(
    (settings.firstPerson || scope.active) &&
      (weapon !== 'none' || ride === 'plane') &&
      !touch.active &&
      !rocket.active,
    weapon,
  )
  fp.setScoped(scope.active)
  fp.setSway(scope.swayX, scope.swayY)
  fp.aimScale = scope.zoom
  fp.update(dt)

  // Head tracks where we're looking: the mouse pitch in first person (the
  // body already owns the yaw there), and in third person a glance toward
  // whatever the orbit camera is pointing at — so Q/E peeks and touch drags
  // show up on the character instead of only moving the view. The sine
  // shapes the glance: biggest when the view is square to the body, unwound
  // to face-forward when the camera looks straight down the body's own
  // heading (nobody cranes their neck a full half-turn).
  const viewOffset = gameCamera.yaw + Math.PI - player.group.rotation.y
  setLook(
    player.group,
    fp.isActive ? fp.pitch : 0,
    fp.isActive ? 0 : GLANCE * Math.sin(viewOffset),
  )

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
  // Straight after player.update, which left our position alone while flying:
  // the arc writes it here, before anything else reads where we are — the
  // gates below included, so a rocket can't be teleported out mid-arc.
  rocket.update(dt, player)
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
  // Moving, jumping or dying drops you out of an emote — except while the
  // rocket owns you, and for a beat after it sets you down, where the pose is
  // the payoff rather than something you idly triggered. Dying still cancels.
  const posed = rocket.active || performance.now() < heroUntil
  emotes.update(
    player.dead || (!posed && (player.moving || keys.has('Space') || touch.jumpHeld)),
  )
  bubbles.update()
  map.update()
  // Everyone else's exhaust, off the pose that already rides in `state`.
  // Throttled to the same cadence rocket.ts uses for our own trail, so a
  // 144Hz screen doesn't smoke twice as hard as a 60Hz one.
  remoteTrailT -= dt
  if (remoteTrailT <= 0) {
    remoteTrailT = 0.04
    for (const pos of remotes.flying()) effects.spawnTrail(pos)
  }
  // Anything a rocket should burst against on contact. Enemies belong in here
  // as much as players do — left out, a rocket flies straight through a
  // skeleton and only kills it by cratering the floor underneath.
  effects.update(dt, [
    ...remotes.targets(),
    { id: 'me', pos: player.group.position },
    ...skeletons.targets(),
    ...mobs.targets(),
  ])
  arrows.update(dt, [
    ...remotes.stickTargets(),
    { id: 'me', group: player.group },
    ...skeletons.stickTargets(),
  ])
  if (firing && (weapon !== 'm2' || player.dead || chat.isOpen || map.isOpen)) ceaseFire()
  if (firing && weapon === 'm2') attack()
  fireworks.update(dt)
  remotes.update(dt)
  // After the player and remotes have moved: the shark chases current
  // positions, and when it has you it overrides where you ended up.
  shark.update(dt, player)
  mobs.update(dt, player)
  skeletons.update(dt, player)
  if (!shark.draggingMe) mashCount = 0
  cats.update(dt, player.group.position)
  meckies.update(dt, player.group.position, camera.position, (id) => remotes.getGroup(id)?.position)
  stripper.update(dt, [player.group.position, ...remotes.targets().map(({ pos }) => pos)])
  gameCamera.update(dt, player, settings, fp)
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
  // The plane earns the rocket's view: altitude pushes the fog wall back the
  // same way, so climbing actually reveals the world spread out below.
  const planeLift =
    ride === 'plane' ? Math.max(0, player.group.position.y - 20) * 4.5 : 0
  daynight.update(settings, camera.position, shadow ? 1 : 0, Math.max(rocket.fogLift, planeLift))
  minimap.update(player, remotes, settings, voice.level, skeletons)
  critters.update(dt, player.group.position)
  cheats.update()
  hud.detector(
    treasure.update(dt, player.group.position, weapon === 'shovel' && !player.dead && !shadow),
  )

  renderer.render(scene, camera)
})
