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
import { createWichita, updateWichita } from './wichita'
import { Arcade } from './arcade'
import { Theater } from './theater'
import { IceCream } from './icecream'
import { Oz, inOz, ozArrival, ozShoesSpot, ozBalloonSpot } from './oz'
import { Tornado } from './tornado'
import { buildCastle } from './castle'
import { Portals, type Gate } from './portal'
import * as blocks from './blocks'
import { initBlocks, blockAtPoint, BLOCK, MATERIALS } from './blocks'
import { initBuildHud } from './buildhud'
import { BlockGhost } from './blockghost'
import { Fireworks, SHELLS } from './fireworks'
import { FIFTY_RPM, FIFTY_LETHAL, FIFTY_CRATER } from './fifty'
import { FirstPersonAim } from './firstperson'
import { Scope, ScopeInput, hitscan } from './sniper'
import { Minimap } from './minimap'
import { Pickups } from './pickups'
import {
  BASE_MASS,
  COLOSSUS_MASS,
  VOXEL,
  boreCells,
  massOf,
  outermost,
  spillJitter,
} from './voxelbody'
import { Mass } from './mass'
import { Shark, SHARK_TARGET_ID } from './shark'
import { Mobs, MOB_TARGET_PREFIX } from './mobs'
import { Skeletons, SKEL_TARGET_PREFIX } from './skeletons'
import { Cats } from './cats'
import { Meckies, RESIDENTS } from './meckies'
import { Stripper } from './stripper'
import { EmoteController } from './emotes'
import { EmoteWheel } from './emotewheel'
import { ItemWheel } from './itemwheel'
import { handPreview, ridePreview } from './preview'
import { GameMap } from './map'
import { RocketRide, DESTINATIONS, LAND_BLAST_RADIUS, LAND_BLAST_DAMAGE } from './rocket'
import { Trebuchet } from './trebuchet'
import { NessieRide, NESSIE_BITE_R } from './nessie'
import { XWingFlight, airborneAt } from './xwing'
import { A10_MUZZLE } from './a10'
import { A10Strikes } from './a10strike'
import { Lasers } from './lasers'
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
  bodyOf,
  setBody,
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
import { initPhysics, stepPhysics } from './physics'

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
createWichita(scene)
// Old Town's entertainment district: playable cabinets and the picture
// house, facing each other across Douglas. High scores brag over the
// ordinary chat relay; the film runs off the shared clock. No new messages.
const arcade = new Arcade(scene)
const theater = new Theater(scene)
// The Land of Oz, and the Kansas weather that delivers you to it. The
// tornado rides the shared clock (see tornado.ts), so it costs the network
// nothing and everyone watches the same storm.
const oz = new Oz(scene)
const tornado = new Tornado(scene)
// The castle is a world block seeder, not a snapshot: initBlocks builds it
// now and rebuilds it on every welcome, before the room's damage replays.
initBlocks(scene, buildCastle)
// Rigid-body physics for debris (physics.ts). Async — the WASM loads in the
// background and effects.ts falls back to fake puffs until it's ready.
void initPhysics(scene)
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
const mass = new Mass()
player.onRespawn = () => {
  mass.revive()
  // Everyone else forgets our wounds off the g drop in our next state; our
  // own spill keys reset here so the reborn body can spill them again.
  if (net.id) pickups.unclaimPrefix(`b:${net.id}:`)
}
// Old Town Scoops, further down Douglas: sidewalk coins in, ice cream out.
// Purely local, like an arcade run — see icecream.ts.
const icecream = new IceCream(scene, player.group, mass)
// Anything that hurts us and isn't a player — a bear, a skeleton, the lava —
// still brings the house down. Nobody to strike, but they shout about it.
mass.onHurt = () => meckies.rally()
const cats = new Cats(scene, touch.active)
// The Meckies: residents you can pick up and carry somewhere else.
const meckies = new Meckies(scene, touch.active)
const hud = new Hud()
const killboard = new Killboard()
const treasure = new Treasure()

const pickups = new Pickups(scene)
pickups.onCollect = (keys) => mass.eat(keys.length)

// The other half of every remote body: `grown` streams in `state` (setBody
// mirrors it into the group's userData), and the holes bored in them ride
// `bore` and live here, so any body can be rebuilt from the pair at any moment.
const remoteWounds = new Map<string, Set<number>>()
function woundsOf(id: string): Set<number> {
  let s = remoteWounds.get(id)
  if (!s) {
    s = new Set()
    remoteWounds.set(id, s)
  }
  return s
}
function rebuildRemote(id: string, grown?: number): void {
  const group = remotes.getGroup(id)
  if (group) setBody(group, grown ?? group.userData.grown ?? BASE_MASS, woundsOf(id))
}

const FLESH_TINT = 0xd08a5a

// Voxels leaving a body burst out around it and drop. Where each lands is
// hashed off its sequence index, so every client scatters the same debris in
// the same places without anyone sending a position.
function spill(group: THREE.Group, ownerId: string, indices: number[], tint: number): void {
  const figure = bodyOf(group)
  for (const i of indices) {
    const j = spillJitter(i)
    const r = figure.radius * (0.35 + 0.65 * j.r)
    pickups.spawn(
      `b:${ownerId}:${i}`,
      group.position.x + Math.cos(j.a) * r,
      group.position.y + figure.height * (0.2 + 0.7 * j.h),
      group.position.z + Math.sin(j.a) * r,
      tint,
    )
  }
}

mass.onChange = () => setBody(player.group, mass.grown, mass.removed)
mass.onSpill = (indices) => spill(player.group, net.id ?? 'me', indices, FLESH_TINT)

// Sounds fade with distance from the local player.
function distVol(pos: THREE.Vector3, range = 70): number {
  return Math.max(0, 1 - player.group.position.distanceTo(pos) / range)
}

const net = new Net()
const voice = new Voice(net)
net.onWelcome = (players, craters, blocks, broken, faces, meck, scores, found, treb, bores) => {
  // Everyone else's holes replay; our own body comes back clean, which is why
  // the room drops our bores when we drop the socket.
  remoteWounds.clear()
  pickups.clear()
  for (const [id, indices] of bores) remoteWounds.set(id, new Set(indices))
  remotes.clear()
  voice.reset() // reconnects mint a new id; old voice links are orphaned
  players.forEach((p) => {
    remotes.upsert(p)
    rebuildRemote(p.id, p.g || BASE_MASS)
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
  // The castle regenerates pristine inside this call, then gets re-broken by
  // the room's cell list on top.
  building.replay(blocks, broken)
  // Wherever the Meckies were left, including in somebody's arms.
  for (const [i, x, z, by] of meck) meckies.applyRemote(i, x, z, by)
  // Treasure somebody already dug up, and the damage already done.
  found.forEach((i) => treasure.markClaimed(i))
  killboard.setScores(scores)
  // The trebuchet the room remembers being eaten — or, on a reconnect into a
  // fresh room, forgot: put it back.
  if (treb) trebuchet.smash(player, true)
  else trebuchet.restore()
}
net.onState = (p) => {
  const prevGrown = remotes.getGroup(p.id)?.userData.grown as number | undefined
  const isNew = !remotes.getGroup(p.id)
  remotes.upsert(p)
  // Rebuilding rewrites every instance matrix in the body, and `state` arrives
  // fifteen times a second — so only when the figure actually changed size.
  const grown = p.g || BASE_MASS
  // `grown` is monotonic in life; it only ever drops on a respawn. Fresh
  // body, fresh wound set — without this, every death leaves its holes
  // behind and a regrown giant renders as sticks and swiss cheese. The room
  // forgets its copy off the same g drop, so no message is needed.
  if (prevGrown !== undefined && grown < prevGrown) {
    woundsOf(p.id).clear()
    pickups.unclaimPrefix(`b:${p.id}:`)
  }
  if (isNew || remotes.getGroup(p.id)?.userData.grown !== grown) rebuildRemote(p.id, grown)
  if (isNew) voice.peerJoined(p.id)
}
net.onLeave = (id) => {
  meckies.dropCarriedBy(id)
  remoteWounds.delete(id) // mirroring what the room does on disconnect
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
  | 'none' | 'gun' | 'sniper' | 'm2' | 'sword' | 'shovel' | 'bow' | 'builder' | 'firework' | 'radio'
// 'nessie' is deliberately absent from the ride wheel: she is only ever
// mounted by jumping onto her back out at sea (see the Nessie block below).
type Ride = 'none' | 'wheelchair' | 'ramsey' | 'plane' | 'xwing' | 'a10' | 'nessie'
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
const emoteWheel = new EmoteWheel(touch.active, color)
emoteWheel.onPick = (id) => emotes.play(id)
// remotes.onEmote is wired further down, where the trebuchet exists: someone
// else's pose flipping to 'slung' is the only signal that it just fired.

setInterval(() => {
  net.sendClaim(pickups.drainClaims())
  const look = getLook(player.group)
  net.sendState({
    x: player.group.position.x,
    y: player.group.position.y,
    z: player.group.position.z,
    ry: player.group.rotation.y,
    // Only ever nonzero in the X-wing, and the only reason the message has
    // them at all — a banking fighter that reads level to everyone else
    // looks like it's sliding sideways through the sky.
    rx: player.group.rotation.x,
    rz: player.group.rotation.z,
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
    g: mass.grown,
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
// The relay never echoes a crater to its sender, so without this hook the
// digger is the only player whose shovel feeds them no dirt.
destruction.onCrater = (c) => spillDirt(c)
// A colossus does not land so much as arrive: one synced dig crater under the
// impact, the same message a shovel scoop sends.
player.onLand = (speed) => {
  if (mass.mass < COLOSSUS_MASS || speed < 9) return
  const p = player.group.position
  // Only when the ground itself caught us — landing on a rampart must not
  // carve the terrain forty feet under the blocks that actually took the hit.
  if (p.y - heightAt(p.x, p.z) > 1) return
  destruction.dig(p.x, p.z)
}
const shark = new Shark(scene, net, effects, remotes, mass)
const mobs = new Mobs(scene, net, effects, remotes, mass)
// The castle garrison. Hosted by one client like the shark and the land mobs,
// and only ever a problem for people who went through the portal.
const skeletons = new Skeletons(scene, net, remotes, effects, mass)
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
  // Past COLOSSUS_MASS nothing fits you: small is fast, airborne and fragile;
  // big is slow, grounded and durable. Rocket travel still works at any size —
  // it writes your position rather than seating you in anything.
  if (next !== 'none' && mass.mass >= COLOSSUS_MASS) {
    hud.feed('too big to fit')
    return
  }
  // Climbing out of a ship that's still in the air is allowed — you just
  // fall. What isn't allowed is leaving the flight model running without a
  // ship attached to it. The Hog shares the X-wing's flight model, so both
  // count as "a ship".
  if ((ride === 'xwing' || ride === 'a10') && next !== ride) xwing.stop(player.group)
  ride = next
  setRide(player.group, ride)
  player.ride = ride
  player.piloting = false
  sfx.equip(ride !== 'none')
  if (ride === 'ramsey') sfx.ramseyMount()
  if (ride === 'xwing') chat.addMessage('🛩️', 'space to take off · WS pitch · AD bank · click to fire')
  if (ride === 'a10') chat.addMessage('🐗', 'space to take off · WS pitch · AD bank · hold click to BRRRT')
  if (ride === 'nessie')
    chat.addMessage('🦕', 'AD steer · W hurry · space flies · aim down to dig deep · C climb off')
  saveLoadout()
}

// Item wheels: hold E and sweep for what's in your hand, hold Q for how you
// get around. Tap instead to pin the wheel open and click. The single-key
// toggles below still work for muscle memory.
//
// This array is the hand hotbar as well as the wheel: its order IS the 1-9
// mapping (see the keydown handler), so the number key, the wedge position and
// the badge on the wedge can never drift apart.
const HAND_ITEMS: { id: Weapon; label: string; letter?: string }[] = [
  { id: 'none', label: 'empty' },
  { id: 'gun', label: 'bazooka', letter: 'G' },
  { id: 'sniper', label: 'sniper', letter: 'N' },
  { id: 'sword', label: 'katana', letter: 'H' },
  { id: 'shovel', label: 'shovel', letter: 'F' },
  { id: 'bow', label: 'bow', letter: 'B' },
  { id: 'builder', label: 'builder', letter: 'T' },
  { id: 'firework', label: 'firework', letter: 'K' },
  { id: 'm2', label: 'fifty cal', letter: 'O' },
  // Slot 10: wheel-only, like the X-wing — the digits stop at 9.
  { id: 'radio', label: 'radio' },
]
const handWheel = new ItemWheel({
  key: 'KeyE',
  title: 'hand',
  digits: true,
  items: HAND_ITEMS.map((item, i) => ({
    id: item.id,
    label: item.label,
    key: item.letter ? `${i + 1}·${item.letter}` : `${i + 1}`,
    preview: () => handPreview(item.id, color),
  })),
  getCurrent: () => weapon,
  onPick: (id) => equipWeapon(id as Weapon),
})
const rideWheel = new ItemWheel({
  key: 'KeyQ',
  title: 'ride',
  items: [
    { id: 'none', label: 'on foot' },
    { id: 'wheelchair', label: 'wheelchair', key: 'R' },
    { id: 'ramsey', label: 'ramsey', key: 'Y' },
    { id: 'plane', label: 'plane', key: 'U' },
    // No hotkey of its own: every letter on the keyboard is spoken for, and
    // the wheel is a perfectly good front door.
    { id: 'xwing', label: 'x-wing' },
    { id: 'a10', label: 'warthog' },
  ].map((item) => ({ ...item, preview: () => ridePreview(item.id, color) })),
  getCurrent: () => ride,
  onPick: (id) => equipRide(id as Ride),
})
player.onSplash = (x, z) => effects.spawnSplash(x, z)
remotes.onSplash = (x, z) => {
  effects.spawnSplash(x, z)
  sfx.splash(distVol(new THREE.Vector3(x, 0, z), 50))
}
// Rockets detonate on built blocks, and our own blasts chew through them.
effects.solidAt = (p) => blockAtPoint(p.x, p.y, p.z) !== undefined
effects.onOwnExplosion = (center, dir) => {
  destruction.rocketCrater(center)
  building.blast(center)
  // A rocket is an aimed weapon like the rest: the owner works out the
  // channel it bores along its flight path, and the victim still decides
  // whether that was fatal. The victim takes no separate blast erosion (see
  // onBlast below), so this is the one place their damage is minted. The
  // blast reaches the body's core line, not the feet — a burst against a
  // colossus' chest is ten units from where it stands.
  for (const { id, pos, r, h } of remotes.targets()) {
    const dy = Math.max(0, Math.min(h ?? 2.6, center.y - pos.y))
    const d = Math.hypot(center.x - pos.x, center.y - pos.y - dy, center.z - pos.z)
    if (d < ROCKET_HIT_R + (r ?? 0)) boreVictim(id, center, ROCKET_BORE_R, dir, BORE_THROUGH)
  }
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
  // Keyed off the duck's own spot, so the murderer and everyone hearing about
  // it through the `duck` egg drop the same four voxels.
  spillPile(`d:${Math.round(at.x)},${Math.round(at.z)}`, at, 4, 0xf2d24b)
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
  else if (e.k === 'treb') smashTrebuchet(e.name, false)
}
net.onBlockPlace = (gx, gy, gz, m) => building.applyRemotePlace(gx, gy, gz, m)
net.onBlockHit = (gx, gy, gz) => building.applyRemoteBreak(gx, gy, gz)

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
  spillDirt(c)
}
// Turned earth. A flat count rather than the crater's true volume: a shovel
// swing scoops about sixty-seven voxels' worth, and paying that out would
// inflate the whole economy off one click.
const DIRT_PER_CRATER = 4
function spillDirt(c: { x: number; z: number; r: number }): void {
  const gx = Math.round(c.x * 4)
  const gz = Math.round(c.z * 4)
  for (let n = 0; n < DIRT_PER_CRATER; n++) {
    const a = (n / DIRT_PER_CRATER) * Math.PI * 2
    const x = c.x + Math.cos(a) * c.r * 0.5
    const z = c.z + Math.sin(a) * c.r * 0.5
    pickups.spawn(`c:${gx},${gz},${n}`, x, heightAt(x, z) + 1, z, 0x7a5a3a)
  }
}
effects.onBlast = (center, ownerId) => {
  const BLAST_RADIUS = 7
  const BLAST_DAMAGE = 75 // dead center; a rocket jump off the rim is cheap
  sfx.explosion(distVol(center, 90))
  // Distance to our own body line rather than our feet — a burst against a
  // giant's head used to register as ten units away and do nothing.
  const fig = bodyOf(player.group)
  const pp = player.group.position
  const bodyDy = Math.max(0, Math.min(fig.height, center.y - pp.y))
  const d = Math.hypot(center.x - pp.x, center.y - pp.y - bodyDy, center.z - pp.z)
  if (d >= BLAST_RADIUS) return
  const k = 1 - d / BLAST_RADIUS
  const dir = player.group.position.clone().sub(center)
  dir.y = 0
  if (dir.lengthSq() < 0.01) dir.set(0, 0, 1)
  dir.normalize()
  player.applyImpulse(dir.x * 20 * k, 7 + 9 * k, dir.z * 20 * k)
  // Only our own blasts erode us here — rocket jumps should hurt. Anybody
  // else's rocket does its damage through the bore their client mints, so
  // taking blast erosion on top would double-charge every hit.
  if (ownerId === 'me') mass.damage(BLAST_DAMAGE * k)
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
// Coming down out of the sky under your own weight, whether a rocket or a
// counterweight put you up there. Same rule the rockets follow: the traveller
// alone mints the world damage, so per-client divergence can never fork the
// terrain. No self-damage — sticking the landing is the whole point.
function touchdown(pos: THREE.Vector3): void {
  emotes.play('hero')
  heroUntil = performance.now() + HERO_HOLD_MS
  effects.spawnImpact(pos)
  sfx.impact()
  net.sendLand(pos)
  destruction.rocketCrater(pos)
  building.blast(pos)
  shark.blast(pos)
}
rocket.onLand = touchdown
// The trebuchet on the north shelf. Walk into the sling and it latches you in;
// it aims itself off your facing, which is how every other client's copy
// swings round with you without a single message of its own (see trebuchet.ts).
const trebuchet = new Trebuchet(scene, effects)
trebuchet.volumeAt = (pos) => distVol(pos, 120)
trebuchet.remoteRider = () => remotes.slingRider()
trebuchet.onBoard = () => {
  emotes.stop()
  emotes.play('slingride')
}
trebuchet.onThrow = () => emotes.play('slung')
trebuchet.onExit = () => emotes.stop()
trebuchet.onLand = (pos, water) => {
  // Straight into the sea: the splash is enough, and cratering the seabed
  // would be a crater nobody can see. Remotes splash for free — their copy of
  // us flips to the swim pose on the next state.
  if (water) {
    // Two rings, because a person arriving at sixty metres a second makes a
    // bigger hole in the sea than someone wading in.
    effects.spawnSplash(pos.x, pos.z)
    effects.spawnSplash(pos.x + 0.8, pos.z - 0.8)
    sfx.splash()
    emotes.stop()
    return
  }
  touchdown(pos)
}
// Somebody else's shot. Their pose flipping to 'slung' IS the fire event, so
// the arm starts its swing on the same state that starts their flight.
remotes.onEmote = (id, emote) => {
  const group = remotes.getGroup(id)
  sfx.emote(emote, group ? distVol(group.position, 60) : 0.6)
  if (emote === 'slung') trebuchet.remoteFire()
}
remotes.onRide = (id, r, name) => {
  if (r !== 'nessie') return
  hud.feed(`★ ${name} TAMED NESSIE ★`)
  const group = remotes.getGroup(id)
  sfx.bellow(group ? distVol(group.position, 130) : 0.4)
}

// Nessie's ride behaviour lives in nessie.ts; this is only her wiring.
const nessie = new NessieRide(scene, effects, distVol, {
  building,
  remotes,
  net,
  shark,
  mobs,
  skeletons,
  critters,
  trebuchet,
  destruction,
  hud,
  killDuck: () => killDuck(profile.name, true),
  smashTrebuchet: () => smashTrebuchet(profile.name, true),
})
// Same split as every other weapon: she removes voxels, and the victim decides
// that was fatal and announces it.
// `at` already sits inside the victim's body, at the height the jaws struck.
nessie.onBite = (id, at) => boreVictim(id, at, NESSIE_BITE_R)

function mountNessie(): void {
  equipRide('nessie')
  nessie.mount(player.group.position)
  sfx.bellow(0.9)
  hud.banner('YOU TAMED NESSIE', 3200)
}

function smashTrebuchet(byName: string, mine: boolean): void {
  if (trebuchet.isSmashed) return
  trebuchet.smash(player)
  hud.feed(`★ ${byName}'s NESSIE ATE THE TREBUCHET ★`)
  if (mine) net.sendEgg('treb')
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
  mass.damage(LAND_BLAST_DAMAGE * k)
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
// Every rocket trip goes through here, because the fighter has to be on the
// ground before the arc starts — otherwise the flight model keeps quietly
// steering you while rocket.ts is writing your position, and the two fight
// over where you are for the whole four seconds.
function launchRocket(dest: { x: number; z: number; followId?: string }, magic = false): boolean {
  // Oz doesn't do rockets. The twister is the only way in, and the silver
  // shoes or the Wizard's balloon are the only ways out — `magic` marks
  // those sanctioned trips. This also closes the back door of clicking a
  // friend's pin while they're off in fairyland.
  if (!magic) {
    const p = player.group.position
    if (inOz(p.x, p.z)) {
      hud.banner('THE SHOES OR THE BALLOON TAKE YOU HOME', 2600)
      return false
    }
    if (inOz(dest.x, dest.z)) {
      hud.banner('ONLY THE TWISTER GOES TO OZ', 2600)
      return false
    }
  }
  xwing.stop(player.group)
  player.piloting = false
  // Nessie doesn't do air travel: dismount first, so the arc doesn't drag a
  // sea monster's body across the sky behind you.
  if (ride === 'nessie') equipRide('none')
  return rocket.launch(player, dest)
}
// The twister's prize: you're not hurt, you're RELOCATED. The trip is the
// ordinary rocket arc, so remotes watch you leave Kansas with no new
// machinery — and the arc's own crater rule and landing blast apply.
tornado.onStrike = () => {
  hud.banner('TWISTER!', 2600)
  sfx.warp()
  launchRocket(ozArrival(), true)
}

// Leaving Oz, the two sanctioned ways. X is the knock/board key — the same
// key as the arcade cabinets, which are a continent away and can't collide.
let heelKnocks = 0
let lastKnockAt = 0
function ozExit(): void {
  const p = player.group.position
  if (player.dead || rocket.active || !inOz(p.x, p.z)) return
  const shoes = ozShoesSpot()
  const balloon = ozBalloonSpot()
  const now = performance.now()
  if (Math.hypot(p.x - shoes.x, p.z - shoes.z) < 3.5) {
    // The book's ritual: knock the heels together three times and command
    // the shoes. Slow knockers start over.
    if (now - lastKnockAt > 4000) heelKnocks = 0
    lastKnockAt = now
    heelKnocks++
    sfx.arcadeBlip(320 + heelKnocks * 160) // the heels clink, rising
    if (heelKnocks < 3) {
      hud.banner(`✦ KNOCK ${heelKnocks} OF 3 ✦`, 1000)
      return
    }
    heelKnocks = 0
    hud.banner('TAKE ME HOME TO AUNT EM!', 2600)
    sfx.warp()
    const home = DESTINATIONS[0].spot()
    player.teleport(home.x, Math.max(heightAt(home.x, home.z), 0), home.z, 0)
    gameCamera.snapTo(player)
  } else if (Math.hypot(p.x - balloon.x, p.z - balloon.z) < 5.5) {
    // The Wizard's way: up, and eventually down, the ordinary arc home.
    hud.banner('UP, UP, AND AWAY', 2600)
    launchRocket(DESTINATIONS[0].spot(), true)
  }
}
map.onPickPlayer = (id) => {
  const group = remotes.getGroup(id)
  if (!group) return
  launchRocket({ x: group.position.x, z: group.position.z, followId: id })
}
map.onPickDest = (index) => {
  const dest = DESTINATIONS[index]
  if (dest && launchRocket(dest.spot())) chat.addMessage('🚀', `to ${dest.name}!`)
}
// Keyboard shortcut, no map required: J cycles to the next place that isn't
// this one — island, island, castle, round again.
function rocketToNextIsland(): void {
  const p = player.group.position
  const here = DESTINATIONS.findIndex((d) => d.here(p.x, p.z))
  const next = (here + 1) % DESTINATIONS.length
  map.onPickDest(next)
}

// The X-wing. Mounting it is just a ride (see equipRide); this is the part
// that flies. Everything it does to the world on the way down happens here —
// xwing.ts only ever decides that the flight ended and how badly.
const xwing = new XWingFlight()
const CRASH_DAMAGE = 45
xwing.onTouchdown = () => {
  chat.addMessage('🛩️', 'down safe')
}
xwing.onCrash = (pos, kind) => {
  if (kind === 'water') {
    // Ditching. Wet, undignified, survivable.
    effects.spawnSplash(pos.x, pos.z)
    sfx.splash()
  } else {
    effects.spawnImpact(pos)
    effects.spawnDebris(pos, ride === 'a10' ? 0x7f8578 : 0xd8d4c6, 16, 9)
    sfx.explosion()
    mass.damage(CRASH_DAMAGE)
  }
  // No message and no crater: the wreck is cosmetic and self-inflicted, and
  // everyone else already watched the ship fall out of the sky in the
  // position stream. Climb out either way — you don't fly it home from here.
  equipRide('none')
}

// Cannon fire. Bolts are cosmetic on every screen except the shooter's,
// which is where the damage is decided — the same split rockets and arrows
// already use.
const lasers = new Lasers(scene)
// A weapon carries a volume rather than a damage number: it takes whatever
// voxels fall inside it, so one shot is lethal to a base figure and a flesh
// wound on a colossus. Sized against the base figure's 15 voxels so the old
// balance survives — two katana swings, two sniper rounds, five laser bolts.
const LASER_BORE_R = 0.45 // ~3 voxels
const SWORD_BORE_R = 0.7 // ~11
const SNIPER_BORE_R = 0.65 // ~9
const FIFTY_BORE_R = 0.85 // ~20, more than a whole base player
// A rocket bores a channel along its flight rather than a sphere: lethal
// through a base figure, a tunnel through a colossus. HIT_R is how close the
// blast centre must land to the body to count as boring it at all — wider
// than that is knockback only.
const ROCKET_HIT_R = 3
const ROCKET_BORE_R = 0.8
// How far a boring projectile's channel runs, centred on the impact. Long
// enough to cross the fattest colossus, so every round exits the far side —
// Breakout rules, and the reason a through-shot costs a giant a real tunnel.
const BORE_THROUGH = 18
const LASER_DAMAGE = 22
lasers.solidAt = (p) => blockAtPoint(p.x, p.y, p.z) !== undefined
lasers.onImpact = (pos, yaw, ownerId, hitId, dir) => {
  effects.spawnDebris(pos, 0xff6a2a, 4, 7)
  if (ownerId !== 'me') return
  if (hitId) {
    // Voxels only — the victim decides whether that was fatal, exactly like a
    // katana hit. The bolt bores straight through along its flight.
    boreVictim(hitId, pos, LASER_BORE_R, dir, BORE_THROUGH)
    sfx.hitmark()
    return
  }
  if (skeletons.swing(pos, yaw, LASER_DAMAGE)) {
    sfx.hitmark()
    return
  }
  if (shark.swing(pos, yaw, LASER_DAMAGE)) return
  if (mobs.swing(pos, yaw, LASER_DAMAGE)) return
  const block = blockAtPoint(pos.x, pos.y, pos.z)
  if (block) building.breakCell(block.gx, block.gy, block.gz)
}
net.onLaser = (id, origin, dir) => {
  const from = new THREE.Vector3(...origin)
  sfx.laser(distVol(from, 90))
  fireCannons(id, from, new THREE.Vector3(...dir))
}
// Four bolts from four wingtips, fanned off one origin and direction so a
// burst costs one message. Every client builds the identical spread.
const CANNON_SPREAD = 3.4
function fireCannons(ownerId: string, origin: THREE.Vector3, dir: THREE.Vector3): void {
  const right = new THREE.Vector3(dir.z, 0, -dir.x).normalize()
  for (const sx of [-1, 1]) {
    for (const sy of [0.6, -0.6]) {
      const from = origin
        .clone()
        .addScaledVector(right, sx * CANNON_SPREAD)
        .add(new THREE.Vector3(0, sy, 0))
      lasers.spawn(ownerId, from, dir)
    }
  }
}

// Fire missions: the radio hands a target to Droid, who flies the A-10 in on
// it (a10strike.ts). Everyone watches the same derived run; the caller alone
// mints what the gun breaks — the fifty's rule, at aircraft scale.
const strikes = new A10Strikes(scene)
const STRIKE_HIT_R = 2.6
const STRIKE_SELF_DAMAGE = 60 // danger close cuts both ways, but full health survives it
const STRIKE_CRATER = { r: 1.7, d: 0.55 }
const RADIO_COOLDOWN_MS = 16000
let lastStrikeCrater = 0
let lastStrikeAt = -1e9
strikes.onTracer = (from, to) => effects.spawnTracer(from, to)
strikes.onPuff = (pos) =>
  effects.spawnDebris(pos.clone().add(new THREE.Vector3(0, 0.5, 0)), 0xd23b2f, 2, 3)
strikes.onBurst = (owner, impact) => {
  // The dirt kicks up on every screen; what it broke is the caller's to say.
  effects.spawnDebris(impact, 0x6b4526, 3, 5)
  if (owner !== 'me') return
  // Girth counts: a colossus standing over the impact point is still hit
  // even though its centre is well outside the burst radius.
  for (const { id, pos, r } of remotes.targets()) {
    if (Math.hypot(impact.x - pos.x, impact.z - pos.z) < STRIKE_HIT_R + (r ?? 0)) {
      boreVictim(id, pos.clone().setY(pos.y + 1), FIFTY_BORE_R)
    }
  }
  // Your own strike can shred you too — through mass.damage, the same
  // self-inflicted path as standing under your own rocket.
  if (player.group.position.distanceTo(impact) < STRIKE_HIT_R) mass.damage(STRIKE_SELF_DAMAGE)
  shark.blast(impact)
  mobs.blast(impact)
  skeletons.blast(impact)
  // A burst chews through anything built where it lands — one block per
  // tick, so a castle wall comes apart course by course, not all at once.
  for (const h of [0.4, 1.6, 2.8]) {
    const block = blockAtPoint(impact.x, impact.y + h, impact.z)
    if (block) {
      building.breakCell(block.gx, block.gy, block.gz)
      break
    }
  }
  // Craters at the handheld fifty's cadence, and for the same reason: one
  // per round would melt the frame and flood the room.
  const now = performance.now()
  if (now - lastStrikeCrater > BULLET_CRATER_MS) {
    lastStrikeCrater = now
    destruction.bite(impact.x, impact.z, STRIKE_CRATER)
  }
}
net.onCas = (id, x, z) => {
  strikes.call(id, x, z)
  const caller = remotes.list().find((f) => f.id === id)?.name ?? 'somebody'
  chat.addMessage(RESIDENTS[0]?.name ?? 'Droid', `FIRE MISSION FOR ${caller.toUpperCase()}. DANGER CLOSE.`)
}

function callFireMission(): void {
  const now = performance.now()
  if (now - lastStrikeAt < RADIO_COOLDOWN_MS) {
    hud.banner('DROID IS REARMING', 1400)
    return
  }
  // The crosshair's ground point in first person; a spot well ahead of your
  // facing in third. Droid takes it from there.
  const aimed = fp.isActive ? fp.aimedDigPoint() : null
  const ry = player.group.rotation.y
  const x = aimed ? aimed.x : player.group.position.x + Math.sin(ry) * 28
  const z = aimed ? aimed.z : player.group.position.z + Math.cos(ry) * 28
  if (!strikes.call('me', x, z)) return // the sky is already full of Warthogs
  lastStrikeAt = now
  net.sendCas(x, z)
  sfx.equip(true)
  chat.addMessage('📻', 'fire mission called — Droid is inbound')
}

meckies.onMove = (i, x, z, by) => net.sendMeckie(i, x, z, by)
meckies.personName = () => profile.name
meckies.onWarCry = (group, text) => bubbles.show(group, text)
meckies.onSay = (name, text) => chat.addMessage(name, text)
// Wide enough to bore clean through, which kills a base figure outright and
// merely hurts a colossus. The rules still hold: attackers only ever remove
// voxels, and the victim announces their own death.
const MECKIE_BORE_R = 9
meckies.onStrike = (id) => {
  const group = remotes.getGroup(id)
  if (group) boreVictim(id, group.position.clone().setY(group.position.y + 1), MECKIE_BORE_R)
}
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
// Who last hurt us, and when. The killboard needs a culprit, and under mass.ts
// we're the only one who knows — everyone else just sent a `bore` and moved on.
// Stale credit expires, so a shark finishing you 20 seconds later doesn't get
// pinned on the last player who grazed you.
const CREDIT_WINDOW = 10000
let lastAttacker = ''
let lastAttackerAt = 0
mass.onSelfBore = (indices) => {
  if (net.id) net.sendBore(net.id, indices)
}
// Tell the room, so its wound set shrinks to match and late joiners see the
// healed body. A healed voxel can be bored again, so its old pickup key
// comes back into play too.
mass.onHeal = (indices) => {
  net.sendHeal(indices)
  for (const i of indices) pickups.unclaim(`b:${net.id}:${i}`)
}
net.onHeal = (id, indices) => {
  const wounds = remoteWounds.get(id)
  if (!wounds) return
  for (const i of indices) {
    wounds.delete(i)
    pickups.unclaim(`b:${id}:${i}`)
  }
  rebuildRemote(id)
}

// Take voxels out of somebody with an aimed weapon. The sphere resolves in the
// VICTIM'S own space, so it cannot drift with interpolation, and only the
// shooter resolves it — everyone else just applies the indices. A sphere that
// catches nothing still costs a voxel, so aim drift can never turn a landed
// shot into a whiff.
function boreVictim(
  victimId: string,
  at: THREE.Vector3,
  radius: number,
  dir?: THREE.Vector3,
  len = 0,
): boolean {
  const group = remotes.getGroup(victimId)
  if (!group) return false
  const local = group.worldToLocal(at.clone())
  const figure = bodyOf(group)
  // With a direction the sphere becomes a channel CENTERED on `at`, running
  // len/2 both ways — Breakout rules: a round takes every voxel on its path
  // through the body, entry to exit. The direction has to turn into the
  // victim's space along with the point.
  const d = dir ? dir.clone().applyQuaternion(group.getWorldQuaternion(_boreQ).invert()) : null
  if (d) local.addScaledVector(d, -len / 2)
  let hit = boreCells(figure, {
    ox: local.x, oy: local.y, oz: local.z,
    dx: d?.x ?? 0, dy: d?.y ?? 1, dz: d?.z ?? 0, r: radius, len,
  })
  if (!hit.length) hit = outermost(figure, 1)
  if (!hit.length) return false
  net.sendBore(victimId, hit)
  return true
}
const _boreQ = new THREE.Quaternion()

// Break every block the body is standing in, bounded by the figure's own
// footprint. Contact plowing calls it every frame for a colossus; a melee swing
// calls it once for anyone, so a mid-size giant jammed against rubble can still
// cut itself free.
function breakOverlapping(figure: ReturnType<typeof bodyOf>): number {
  const p = player.group.position
  const r = Math.ceil(figure.radius / BLOCK)
  const h = Math.ceil(figure.height / BLOCK)
  const cgx = Math.round(p.x / BLOCK)
  const cgy = Math.floor(p.y / BLOCK)
  const cgz = Math.round(p.z / BLOCK)
  let broke = 0
  const reachSq = ((figure.radius + BLOCK * 0.5) / BLOCK) ** 2
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > reachSq) continue
      for (let dy = 0; dy <= h; dy++) {
        if (blockAtPoint((cgx + dx) * BLOCK, (cgy + dy) * BLOCK + 0.1, (cgz + dz) * BLOCK)) {
          building.breakCell(cgx + dx, cgy + dy, cgz + dz)
          broke++
        }
      }
    }
  }
  return broke
}

// A parked colossus can skip the sweep; the timer still catches a block
// somebody builds into it while it stands there.
const lastPlow = new THREE.Vector3(Infinity, 0, 0)
let lastPlowMs = 0
function plowThrough(): void {
  const p = player.group.position
  const now = performance.now()
  if (p.distanceToSquared(lastPlow) < 0.0004 && now - lastPlowMs < 300) return
  lastPlow.copy(p)
  lastPlowMs = now
  breakOverlapping(bodyOf(player.group))
}

// Goomba rules: falling through somebody's crown takes a bite sized to the
// stomper and springs you back off their head. Only the stomper resolves it,
// the same owner-mints rule as every other weapon.
const STOMP_BORE_R = 0.55
const STOMP_MS = 600
const stompedAt = new Map<string, number>()
function checkStomp(): void {
  if (player.dead || player.flying || player.piloting || player.grabbed) return
  const vy = player.fallSpeed
  if (vy > -5) return
  const p = player.group.position
  const myFig = bodyOf(player.group)
  for (const { id, pos } of remotes.targets()) {
    const g = remotes.getGroup(id)
    if (!g) continue
    const fig = bodyOf(g)
    if (Math.hypot(p.x - pos.x, p.z - pos.z) > fig.radius + myFig.radius * 0.5) continue
    const crown = pos.y + fig.height
    if (p.y < crown - 1.4 || p.y > crown + 1.2) continue
    const now = performance.now()
    if (now - (stompedAt.get(id) ?? 0) < STOMP_MS) continue
    stompedAt.set(id, now)
    boreVictim(id, new THREE.Vector3(pos.x, crown - 0.3, pos.z), STOMP_BORE_R * mass.scale)
    player.applyImpulse(0, 8 - vy, 0) // the bounce, the whole reason to do it
    sfx.hitmark()
    return
  }
  // NPCs aren't in remotes.targets() — they live in their own modules with
  // their own damage paths, so each had to grow its own stomp. Bones squash
  // outright; a bear takes the weight by the stomper's mass.
  if (skeletons.stomp(p) || mobs.stomp(p, 30 * mass.scale)) {
    player.applyImpulse(0, 8 - vy, 0)
    sfx.hitmark()
  }
}

net.onClaim = (keys) => pickups.claimRemote(keys)
// `key` comes from what died and where, never from a counter, so every client
// names the same voxels.
function spillPile(key: string, at: THREE.Vector3, n: number, tint: number): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + i * 0.7
    const r = 0.4 + (i % 3) * 0.5
    pickups.spawn(`${key}:${i}`, at.x + Math.cos(a) * r, at.y + 1.2, at.z + Math.sin(a) * r, tint)
  }
}

// Rubble. Keyed by the cell it fell out of, so two clients that saw the wall
// come down in a different order still agree which voxel is which. A building
// block is three voxels on a side, so it comes apart into three — and it costs
// the same three to put one back (BUILD_COST below), or breaking your own wall
// would be a mass printer.
const RUBBLE_PER_BLOCK = 3
building.onBreak = (gx, gy, gz, m, at) => {
  for (let n = 0; n < RUBBLE_PER_BLOCK; n++) {
    pickups.spawn(`w:${gx},${gy},${gz}:${n}`, at.x, at.y, at.z, MATERIALS[m].debris, VOXEL * 0.9)
  }
}
// A rebuilt cell is new rubble, so the old claims on its keys let go —
// placements are synced, which is what keeps every client's claim set moving
// together. Without this, any cell whose rubble was ever eaten goes silent
// for the rest of the session.
building.onPlace = (gx, gy, gz) => {
  for (let n = 0; n < RUBBLE_PER_BLOCK; n++) pickups.unclaim(`w:${gx},${gy},${gz}:${n}`)
}
net.onBore = (attacker, victim, indices) => {
  if (victim === net.id) {
    // Our own self-announcements echo back (the room broadcasts bores to
    // everyone). Re-applying one isn't a no-op: the whiff fallback in take()
    // charges a fresh voxel for a set of already-removed ones, so the echo
    // of every lava tick and spent block would eat a bonus voxel forever.
    if (attacker === net.id) return
    if (attacker) {
      lastAttacker = attacker
      lastAttackerAt = performance.now()
      // Avenge BEFORE the voxels go: mass fires onHurt, and whichever handler
      // fires first takes the per-resident cooldown. This one knows who did it
      // and can hit back, so it has to win the race.
      meckies.avenge(attacker)
    }
    mass.bore(indices)
    return
  }
  // Mirror the victim's own filter (take() in mass.ts): the core never
  // erodes, indices past the figure are base-figure pokes the victim ignored,
  // and a victim at the floor loses a life rather than a voxel. Banking any
  // of those here is how wound sets drift until a giant renders as a stick.
  const wounds = woundsOf(victim)
  const grownV = remotes.getGroup(victim)?.userData.grown as number | undefined
  if (grownV !== undefined && massOf(grownV, wounds) <= BASE_MASS) return
  const fresh = indices.filter(
    (i) => i >= BASE_MASS && (grownV === undefined || i < grownV) && !wounds.has(i),
  )
  if (!fresh.length) return
  for (const i of fresh) wounds.add(i)
  const group = remotes.getGroup(victim)
  if (group) {
    spill(group, victim, fresh, FLESH_TINT)
    rebuildRemote(victim)
  }
}
// Being taken apart at your smallest form is your own announcement to make:
// the head pops here, and everyone else hears about it through `kill`.
mass.onDeath = () => {
  const fresh = performance.now() - lastAttackerAt < CREDIT_WINDOW
  if (net.id) net.sendKill(net.id, fresh ? lastAttacker : undefined)
  lastAttacker = ''
  dieLocally()
}
function dieLocally(): void {
  // Death always unseats you from Nessie — unlike a wheelchair, she is not
  // yours to keep, and the respawn is back on the island anyway.
  if (ride === 'nessie') equipRide('none')
  arcade.stop() // no posthumous high scores
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
    mass.kill()
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
// Every block a swing plausibly meets, not just the first a probe finds: the
// aimed columns ahead, with reach and height scaled to the figure, plus
// everything the body already overlaps — so a colossus standing waist-deep in
// masonry swings the whole wall face off. Returns how many blocks died, which
// is how the shovel decides whether to fall through to digging.
function meleeBreakBlocks(): number {
  const figure = bodyOf(player.group)
  const p = player.group.position
  const ry = player.group.rotation.y
  const sin = Math.sin(ry)
  const cos = Math.cos(ry)
  const s = mass.scale
  let broke = 0
  for (const dist of MELEE_REACH) {
    const tx = p.x + sin * dist * s
    const tz = p.z + cos * dist * s
    for (let h = 0.2; h < figure.height + 0.4; h += BLOCK) {
      const hit = blockAtPoint(tx, p.y + h, tz)
      if (hit) {
        building.breakCell(hit.gx, hit.gy, hit.gz)
        broke++
      }
    }
  }
  broke += breakOverlapping(figure)
  return broke
}

// At the controls of an airborne aircraft, which overrides whatever is in
// your hands: the trigger is the ship's own gun and nothing else. The X-wing
// and the Warthog share one flight model (`xwing`), so this covers both.
function inCockpit(): boolean {
  return (ride === 'xwing' || ride === 'a10') && xwing.airborne
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
// Trigger held down. The M2 and the A-10's gun use it; everything else is
// click-per-shot.
let firing = false
let lastBrrrt = 0 // the burp sound spans several rounds, so it has its own gate
const SNIPER_DAMAGE = 80 // brutal, but it's two hits and a slow bolt either way

// Everything one lethal .50 round does when it lands — shared by the
// handheld M2 and the A-10's nose gun, so the two can never disagree about
// what "kills anything it touches" means. Living things die outright; blocks
// come apart whatever they're made of; dirt gets bitten at a sane cadence.
// `dir` is the round's flight, so a body hit bores clean through.
function applyFiftyRound(hit: ReturnType<typeof hitscan>, now: number, dir: THREE.Vector3): void {
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
    // remove voxels. Out of a base figure, one round is all of them.
    boreVictim(hit.id, hit.point, FIFTY_BORE_R, dir, BORE_THROUGH)
    sfx.hitmark()
  } else if (hit.block) {
    building.breakCell(hit.block.gx, hit.block.gy, hit.block.gz)
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
}

function attack(): void {
  if (player.dead) return
  if (arcade.isPlaying) return // the trigger belongs to the cabinet
  const now = performance.now()
  emotes.stop() // no waving mid-rocket
  if (inCockpit()) {
    if (ride === 'a10') {
      // The GAU-8: the handheld M2's lethal ray fired down the nose at the
      // same cadence, with the mouse held down for the burp. Same tracer
      // message, same mint-once consequences — the plane is just the mount.
      if (now - lastAttack < FIFTY_RPM) return
      lastAttack = now
      if (now - lastBrrrt > 400) {
        lastBrrrt = now
        sfx.brrrt(0.9)
      }
      const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(player.group.quaternion).normalize()
      player.group.updateMatrixWorld()
      const origin = player.group.localToWorld(A10_MUZZLE.clone())
      const hit = hitscan(
        origin,
        dir,
        [...remotes.targets(), ...shark.targets(), ...mobs.targets(), ...skeletons.targets()],
        { blocks: true },
      )
      effects.spawnTracer(origin, hit.point)
      net.sendFifty(origin, hit.point)
      applyFiftyRound(hit, now, dir)
      return
    }
    if (now - lastAttack < 180) return
    lastAttack = now
    // Straight down the nose, from just past it — with pitch and roll on the
    // group, the ship's own forward vector is the only thing that reads right.
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(player.group.quaternion).normalize()
    // The click lands between frames, so the matrix is a frame stale — and a
    // frame of an 88-unit-per-second ship is a whole ship-length of error.
    player.group.updateMatrixWorld()
    const origin = player.group.localToWorld(new THREE.Vector3(0, 1.15, 4.6))
    sfx.laser()
    fireCannons('me', origin, dir)
    net.sendLaser(origin, dir)
    return
  }
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
      // whether that was fatal and announce it back as `kill`. The round
      // bores through along its flight, Breakout rules.
      boreVictim(hit.id, hit.point, SNIPER_BORE_R, dir, BORE_THROUGH)
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
      // The blade swings at the swinger's own chest height, reach scaled to
      // the swinger, and the victim's girth counts — two colossi could
      // otherwise stand chest to chest unable to connect, and a base player
      // could only ever cut a giant's ankles.
      const swingY = player.group.position.y + 1.2 * mass.scale
      for (const { id, pos, r, h } of remotes.targets()) {
        const to = pos.clone().sub(player.group.position)
        const dy = Math.max(0, Math.min(h ?? 2.2, swingY - pos.y))
        if (Math.hypot(to.x, swingY - pos.y - dy, to.z) > 2.4 * mass.scale + (r ?? 0)) continue
        const facing = Math.atan2(
          Math.sin(Math.atan2(to.x, to.z) - player.group.rotation.y),
          Math.cos(Math.atan2(to.x, to.z) - player.group.rotation.y),
        )
        if (Math.abs(facing) < 1.2) {
          // Just the damage — the victim decides whether that was fatal and
          // announces it, so the head pops when their `kill` comes back. The
          // cut lands where the blade actually swept, clamped into the body.
          const cutY = Math.max(pos.y + 0.3, Math.min(pos.y + (h ?? 2.2) - 0.2, swingY))
          boreVictim(id, new THREE.Vector3(pos.x, cutY, pos.z), SWORD_BORE_R * mass.scale)
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
      meleeBreakBlocks()
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
      if (meleeBreakBlocks()) return
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
    // A placed block IS voxels off your body: one currency for combat, growth
    // and construction, so a colossus can trade size back for speed by
    // building with it. It costs exactly what breaking one pays back.
    if (mass.spend(RUBBLE_PER_BLOCK)) {
      building.place(player.group.position, player.group.rotation.y, material, aimed)
    }
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
    applyFiftyRound(hit, now, dir)
  } else if (weapon === 'radio' && now - lastAttack > 500) {
    lastAttack = now
    callFireMission()
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
    void lock?.catch(() => { })
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
  if (weapon === 'bow' && !inCockpit()) {
    bowDrawStart = performance.now()
    sfx.bowDraw()
    return
  }
  // The M2 is belt-fed, and so is the Hog's nose: hold the button and it
  // keeps going.
  if (weapon === 'm2' || (ride === 'a10' && xwing.airborne)) firing = true
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
shark.onDeath = (at) => {
  chat.addMessage('🦈', 'blub…')
  spillPile(`s:${Math.round(at.x)},${Math.round(at.z)}`, at, 60, 0x4a6b7a)
}
mobs.onDeath = (name, at, i) => {
  chat.addMessage(name === 'bear' ? '🐻' : '😵', name === 'bear' ? 'the bear is down' : 'gary will return')
  // The island has no blocks on it, so without this the only food out here is
  // what you dig and what you take off each other.
  spillPile(`m:${i}:${Math.round(at.x)}`, at, name === 'bear' ? 14 : 8, 0x8a1f1f)
}
const bubbles = new Bubbles(camera, renderer.domElement)
mobs.onSay = (group, text) => bubbles.show(group, text)
const stripper = new Stripper(scene, bubbles)
// Longer messages get a longer mouth-flap while the bubble is up.
const jabberFor = (text: string): number => Math.min(4000, 900 + text.length * 55)
// A new personal best goes out as ordinary chat — the whole room hears the
// brag with no new message type, and it lands in everyone's log by name.
arcade.onHighScore = (title, score) => {
  const brag = `🕹️ new high score on ${title}: ${score}`
  net.sendChat(brag)
  chat.addMessage(profile.name, brag)
}
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
  // Strapped into the trebuchet, space is the trigger rather than a jump, and
  // C climbs back out. Edge-triggered on purpose: walking in with space held
  // down should not fling you before you've had a look at where you're aimed.
  if (trebuchet.loaded) {
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault()
      trebuchet.fire()
    }
    if (e.code === 'KeyC' && !e.repeat) trebuchet.eject(player)
  }
  if (e.code === 'KeyC' && !e.repeat && ride === 'nessie') equipRide('none')
  if (e.code === 'KeyG') equipWeapon(weapon === 'gun' ? 'none' : 'gun')
  if (e.code === 'KeyN') equipWeapon(weapon === 'sniper' ? 'none' : 'sniper')
  if (e.code === 'KeyZ' && !e.repeat && weapon === 'sniper') scopeInput.toggle()
  if (e.code === 'KeyH') equipWeapon(weapon === 'sword' ? 'none' : 'sword')
  if (e.code === 'KeyF') equipWeapon(weapon === 'shovel' ? 'none' : 'shovel')
  if (e.code === 'KeyB') equipWeapon(weapon === 'bow' ? 'none' : 'bow')
  if (e.code === 'KeyT') equipWeapon(weapon === 'builder' ? 'none' : 'builder')
  // Numbers are the hotbar: 1-9 equip the hand wheel's wedges in order. The
  // builder keeps 1-4 for its materials while it's out — that's the one place
  // a digit means something else, and the chips on screen say so.
  const digit = /^Digit([1-9])$/.exec(e.code)
  if (digit) {
    const slot = Number(digit[1])
    if (weapon === 'builder' && slot <= MATERIALS.length) {
      material = slot - 1
      buildHud.setMaterial(material)
      saveLoadout()
    } else if (slot <= HAND_ITEMS.length) {
      equipWeapon(HAND_ITEMS[slot - 1].id)
    }
  }
  if (e.code === 'KeyK') equipWeapon(weapon === 'firework' ? 'none' : 'firework')
  if (e.code === 'KeyO') equipWeapon(weapon === 'm2' ? 'none' : 'm2')
  if (e.code === 'KeyL') launchFireworks()
  if (e.code === 'KeyR') equipRide(ride === 'wheelchair' ? 'none' : 'wheelchair')
  if (e.code === 'KeyY') equipRide(ride === 'ramsey' ? 'none' : 'ramsey')
  if (e.code === 'KeyU') equipRide(ride === 'plane' ? 'none' : 'plane')
  // The X-wing has no letter of its own — the alphabet ran out — so it's
  // wheel-only. Space is still its throttle once you're strapped in: it
  // lights the engines from a standstill, and boosts after that.
  if (
    e.code === 'Space' &&
    (ride === 'xwing' || ride === 'a10') &&
    !xwing.airborne &&
    !player.dead &&
    !e.repeat
  ) {
    xwing.takeoff(player.group)
  }
  if (e.code === 'KeyJ') rocketToNextIsland()
  // X sits you down at the nearest arcade cabinet (or backs you off it),
  // then tries the ice cream counter down the street; when neither wants it,
  // it's Oz's exit key — the places are far enough apart the chain can't
  // misfire.
  if (
    e.code === 'KeyX' &&
    !e.repeat &&
    !arcade.toggle(player.group.position) &&
    !icecream.buy(player.group.position)
  )
    ozExit()
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
let ozZone = inOz(player.group.position.x, player.group.position.z)
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
  mass,
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
  trebuchet,
  map,
  xwing,
  lasers,
  scene,
  camera,
  attack,
  scope,
  draw: () => renderer.render(scene, camera),
}

const clock = new THREE.Clock()
let remoteTrailT = 0
renderer.setAnimationLoop(() => {
  // One bad frame must not end the session: three.js re-arms the next
  // requestAnimationFrame only after this callback returns, so an uncaught
  // throw here would stop rendering and simulation forever — while the
  // state interval kept streaming a frozen player to the room.
  try {
    frame()
  } catch (e) {
    console.error('frame skipped:', e)
  }
})

function frame(): void {
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
    scopeInput.isUp &&
      weapon === 'sniper' &&
      !touch.active &&
      !rocket.active &&
      !trebuchet.busy &&
      !player.dead &&
      !fp.paused,
  )
  scope.update(dt)
  // No aiming down a scope while the rocket flies you (or the trebuchet does);
  // the chase cam sells it. Scoping in forces first person for as long as the
  // scope is up, even if the player normally plays in third. The plane counts
  // as a reason to be in first person on its own — a cockpit view needs no
  // weapon in hand. The X-wing goes the other way: it's the one ride you want
  // to watch from behind, because the whole point is the ship.
  fp.setActive(
    (settings.firstPerson || scope.active) &&
      (weapon !== 'none' || ride === 'plane') &&
      !touch.active &&
      !rocket.active &&
      !trebuchet.busy &&
      ride !== 'xwing' &&
      ride !== 'a10',
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

  // Killed, or caught by the shark, mid-flight: hand control back before
  // anything else this frame gets to write our position.
  if (xwing.airborne && (player.dead || player.grabbed)) xwing.stop(player.group)
  // Touch has no space bar, so the jump pad doubles as the throttle.
  if ((ride === 'xwing' || ride === 'a10') && !xwing.airborne && touch.jumpHeld && !player.dead) {
    xwing.takeoff(player.group)
  }
  player.piloting = xwing.airborne

  const nessieRiders = remotes.nessieRiders()
  if (ride === 'nessie' && net.id && nessieRiders.some((r) => r.id < net.id!)) {
    equipRide('none')
    hud.banner('SHE CHOSE SOMEBODY ELSE', 2600)
  }
  critters.setNessieClaimed(ride === 'nessie' || nessieRiders.length > 0)
  if (
    ride !== 'nessie' &&
    (keys.has('Space') || touch.jumpHeld) &&
    !player.dead &&
    !player.flying &&
    !player.piloting &&
    !player.grabbed &&
    !trebuchet.busy &&
    nessieRiders.length === 0 &&
    critters.nessieMountable(player.group.position, 8)
  ) {
    mountNessie()
  }

  // At a cabinet the keys belong to the game: WASD steers WORM, not you,
  // and space is the red button rather than a jump.
  const atCabinet = arcade.isPlaying
  const stickF = atCabinet ? 0 : (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) + touch.moveF
  const stickS = atCabinet ? 0 : (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) + touch.moveS
  const boost = !atCabinet && (keys.has('Space') || touch.jumpHeld)
  const surging = ride === 'nessie' && !player.dead
  const digging = surging && (fp.isActive ? fp.pitch < -0.5 : gameCamera.pitch > 1.02)
  player.update(
    dt,
    {
      f: surging ? (keys.has('KeyS') ? 0.55 : 1) : stickF,
      s: stickS,
      // Space belongs to the throttle while you're strapped in — otherwise
      // taking off would also make the parked aircraft hop.
      jump: ride === 'xwing' || ride === 'a10' ? false : boost,
      crouch: surging ? digging : keys.has('KeyC'),
      sprint: surging ? keys.has('KeyW') : keys.has('ShiftLeft') || keys.has('ShiftRight'),
      strafe: fp.isActive,
    },
    gameCamera.yaw,
  )
  if (surging && !rocket.active && !player.grabbed)
    nessie.rampage(player.group.position, performance.now(), digging)
  // Straight after player.update, which left our position alone while it's
  // flying us. W/S is the stick (push forward to dive), A/D banks, Space is
  // the throttle and Shift the airbrake.
  xwing.update(
    dt,
    {
      pitch: -stickF,
      roll: stickS,
      boost,
      brake: keys.has('ShiftLeft') || keys.has('ShiftRight'),
    },
    player.group,
  )
  // ...and then the arc writes it, before anything else reads where we are —
  // the gates below included, so a rocket can't be teleported out mid-arc.
  rocket.update(dt, player)
  // Same slot, same reason: while it has you, the trebuchet writes where you
  // are — sitting in the basket, riding the arm up, or on your way across the
  // island. The strafe stick steers the frame instead of your feet.
  trebuchet.update(dt, player, stickS)
  // Our own S-foils and exhaust, off the same two facts remotes.ts derives
  // them from for everyone else (see xwing.ts).
  if (ride === 'xwing' || ride === 'a10') {
    const p = player.group.position
    player.group.userData.airborne = xwing.airborne || airborneAt(p.x, p.y, p.z)
    player.group.userData.throttle = xwing.throttle
  }
  gameCamera.pullBack(
    ride === 'xwing' || ride === 'a10' ? (xwing.airborne ? 13 : 8) : ride === 'nessie' ? 6 : 0,
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
  // Oz gets its arrival fanfare too; leaving quietly is fine — wherever you
  // land next will introduce itself.
  const nowOz = inOz(player.group.position.x, player.group.position.z)
  if (nowOz !== ozZone) {
    ozZone = nowOz
    if (nowOz) {
      announce('THE LAND OF OZ')
      sfx.warp()
      chat.addMessage('🌪️', 'no rockets here — X at the silver shoes (knock ×3) or the balloon goes home')
    }
  }
  // The realm's sea is molten. player.ts floats you in it exactly like water,
  // which is the joke: the only difference is that it kills you.
  if (shadow && player.pose === 'swim' && !player.dead) {
    mass.damage(52 * dt)
    burnT -= dt
    if (burnT <= 0) {
      burnT = 0.35
      sfx.sizzle()
    }
  } else {
    burnT = 0
  }

  mass.update(dt)
  // A colossus does not go around masonry, it goes through it — minted by the
  // player doing the plowing, the same owner-mints rule craters and rockets
  // follow. The rubble drops through building.onBreak like any other break, so
  // it walks out of a wall eating the wall.
  if (player.plows && !player.dead) plowThrough()
  checkStomp()
  // Size is a movement stat, derived from mass on every client rather than sent.
  player.mass = mass.mass
  pickups.update(dt, player.group.position, mass.scale)
  gameCamera.setScale(mass.scale)
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
  const posed = rocket.active || trebuchet.busy || performance.now() < heroUntil
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
  stepPhysics(dt)
  arrows.update(dt, [
    ...remotes.stickTargets(),
    { id: 'me', group: player.group },
    ...skeletons.stickTargets(),
  ])
  // Bolts only need the players: everything else they can hit is resolved at
  // the impact point through the same `swing` calls a katana uses.
  lasers.update(dt, [...remotes.targets(), { id: 'me', pos: player.group.position }])
  const beltFed = weapon === 'm2' || (ride === 'a10' && xwing.airborne)
  if (firing && (!beltFed || player.dead || chat.isOpen || map.isOpen)) ceaseFire()
  if (firing && beltFed) attack()
  fireworks.update(dt)
  strikes.update(dt, player.group.position)
  arcade.update(
    dt,
    player.group.position,
    {
      left: keys.has('KeyA') || keys.has('ArrowLeft'),
      right: keys.has('KeyD') || keys.has('ArrowRight'),
      up: keys.has('KeyW') || keys.has('ArrowUp'),
      down: keys.has('KeyS') || keys.has('ArrowDown'),
      a: keys.has('Space'),
    },
    player.dead,
  )
  icecream.update(dt, player.group.position, player.dead)
  remotes.update(dt)
  // `nessieRiders` is still the list from the top of the frame — nothing
  // between there and here changes anyone's ride.
  const allNessieRiders =
    ride === 'nessie' && !player.dead
      ? [{ id: 'me', group: player.group }, ...nessieRiders]
      : nessieRiders
  nessie.update(dt, allNessieRiders)
  nessie.shove(player, nessieRiders, performance.now())
  nessie.trample(stripper, allNessieRiders)
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
    ride === 'plane' || ride === 'nessie'
      ? Math.max(0, player.group.position.y - 20) * 4.5
      : 0
  daynight.update(
    settings,
    camera.position,
    shadow ? 1 : 0,
    Math.max(rocket.fogLift, planeLift, xwing.fogLift, trebuchet.fogLift),
  )
  // Wichita's windows come on with the same clock that just drove the sky —
  // the same clock is the projector, the tornado's leash, and Oz's
  // choreography, so everyone watches the same everything.
  updateWichita(daynight.now())
  theater.update(daynight.now(), player.group.position)
  tornado.update(
    dt,
    daynight.now(),
    player,
    !rocket.active && !trebuchet.busy && !player.grabbed,
  )
  oz.update(dt, daynight.now(), player.group.position)
  minimap.update(player, remotes, settings, voice.level, skeletons)
  critters.update(dt, player.group.position)
  cheats.update()
  hud.detector(
    treasure.update(dt, player.group.position, weapon === 'shovel' && !player.dead && !shadow),
  )

  renderer.render(scene, camera)
}
