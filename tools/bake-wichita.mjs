// One-off bake: downtown Wichita, KS from OpenStreetMap -> src/wichita-data.ts
// Run with `node tools/bake-wichita.mjs`. Never runs in the game — the output
// is a static file, so every client computes the identical city (same rule as
// the castle: no randomness, no network).
//
// Data (c) OpenStreetMap contributors, ODbL.

const BBOX = [37.68, -97.347, 37.695, -97.319] // Kellogg->Central, river->Washington
const LAT0 = 37.6859 // Douglas Ave centerline — the island's z=0 spine
const LON0 = -97.334 // between Market and Broadway — x=0
const M_LAT = 111320
const M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180)

// Known skyline buildings OSM has no height for, meters. Everything else
// falls back to building:levels or a hash of the footprint.
const LANDMARK_H = {
  'Epic Center': 90,
  'Ruffin Building': 37,
  'The Lux': 30,
  'Broadway Plaza Building': 40,
  'Wichita Executive Centre': 45,
  'Kansas Health Foundation': 25,
  'Century II Performing Arts & Convention Center': 21,
  'Intrust Bank Arena': 24,
  'Wichita Union Station': 16,
  'Keen Kutter Building': 18,
  'Scottish Rite Center;Temple Live': 18,
  'Drury Plaza Hotel Broadview Wichita': 40,
  'Ambassador Hotel Wichita, Autograph Collection': 32,
  'Eaton Place': 20,
  'Orpheum Theatre': 20,
  'The Orpheum Offices': 20,
}

const ROAD_W = {
  primary: 14,
  secondary: 12,
  tertiary: 10,
  residential: 8,
  unclassified: 8,
  living_street: 8,
  pedestrian: 6,
  service: 5,
  footway: 2.5,
  cycleway: 2.5,
  path: 2.5,
}

function project(lat, lon) {
  return [(lon - LON0) * M_LON, (LAT0 - lat) * M_LAT] // east=+x, north=-z
}

// Ramer-Douglas-Peucker on [x,z] points.
function simplify(pts, tol) {
  if (pts.length < 3) return pts
  let maxD = 0
  let idx = 0
  const [ax, az] = pts[0]
  const [bx, bz] = pts[pts.length - 1]
  const dx = bx - ax
  const dz = bz - az
  const len = Math.hypot(dx, dz)
  for (let i = 1; i < pts.length - 1; i++) {
    // Closed rings start and end on the same point — fall back to point
    // distance or the whole ring measures 0 and collapses.
    const d =
      len < 1e-9
        ? Math.hypot(pts[i][0] - ax, pts[i][1] - az)
        : Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / len
    if (d > maxD) {
      maxD = d
      idx = i
    }
  }
  if (maxD <= tol) return [pts[0], pts[pts.length - 1]]
  return [
    ...simplify(pts.slice(0, idx + 1), tol).slice(0, -1),
    ...simplify(pts.slice(idx), tol),
  ]
}

function q(n) {
  return Math.round(n * 10) / 10
}

// Deterministic 1-3 story fallback height from the footprint itself.
function hashHeight(pts) {
  let h = 0
  for (const [x, z] of pts) h = (h * 31 + Math.round(x * 7 + z * 13)) | 0
  return 4 + (Math.abs(h) % 3) * 3 // 4, 7 or 10 m
}

function parseHeight(tags, pts) {
  const name = tags.name
  if (name && LANDMARK_H[name] != null) return LANDMARK_H[name]
  if (tags.height) {
    const m = parseFloat(String(tags.height).replace(/[^0-9.]/g, ''))
    if (m > 2 && m < 120) return m
  }
  if (tags['building:levels']) {
    const l = parseFloat(tags['building:levels'])
    if (l >= 1 && l < 30) return 2 + l * 3.2
  }
  const t = tags.building
  if (t === 'garage' || t === 'garages' || t === 'shed') return 3
  if (t === 'parking' || t === 'commercial' || t === 'retail') return 6
  return hashHeight(pts)
}

const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
]

async function overpass(query) {
  let lastErr
  for (const url of ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'shared-game-wichita-bake/1.0',
          },
          body: 'data=' + encodeURIComponent(`[out:json][timeout:90];${query}`),
        })
        if (!res.ok) throw new Error(`${url} -> ${res.status}`)
        const text = await res.text()
        let json
        try {
          json = JSON.parse(text)
        } catch {
          throw new Error(`${url} -> non-JSON (${text.slice(0, 80).replace(/\s+/g, ' ')})`)
        }
        if (json.remark) console.log('  remark:', json.remark)
        if (!json.elements?.length) throw new Error(`${url} -> 0 elements`)
        console.log(`  ${json.elements.length} elements from ${url}`)
        return json.elements
      } catch (e) {
        lastErr = e
        console.log(`  retrying (${e.message})`)
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  }
  throw lastErr
}

// Cache raw responses next to the script so re-bakes don't re-fetch.
const { writeFileSync, readFileSync, existsSync } = await import('node:fs')
async function cached(name, query) {
  const path = new URL(`./.cache-${name}.json`, import.meta.url)
  if (existsSync(path)) {
    console.log(`using cached ${name}`)
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  console.log(`fetching ${name}...`)
  const els = await overpass(query)
  writeFileSync(path, JSON.stringify(els))
  return els
}

const bbox = BBOX.join(',')
const bldRaw = await cached(
  'buildings',
  `(way["building"](${bbox});relation["building"](${bbox}););out geom;`,
)
const roadRaw = await cached(
  'roads',
  `way["highway"~"^(primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|service|footway|cycleway|path)$"](${bbox});out geom;`,
)
// The Arkansas River — the island's western shoreline.
const waterRaw = await cached(
  'water',
  `(way["natural"="water"](${bbox});relation["natural"="water"](${bbox});way["waterway"="riverbank"](${bbox}););out geom;`,
)

const buildings = []
for (const el of bldRaw) {
  // Ways carry their ring directly; for multipolygon relations take the
  // outer rings (holes and courtyards don't survive N64 fidelity anyway).
  const rings =
    el.type === 'way'
      ? el.geometry
        ? [el.geometry]
        : []
      : (el.members || [])
          .filter((m) => m.role === 'outer' && m.geometry)
          .map((m) => m.geometry)
  const tags = el.tags || {}
  for (const ring of rings) {
    let pts = ring.map((g) => project(g.lat, g.lon))
    // drop the closing duplicate point OSM rings carry
    if (pts.length > 1) {
      const [fx, fz] = pts[0]
      const [lx, lz] = pts[pts.length - 1]
      if (Math.hypot(fx - lx, fz - lz) < 0.01) pts = pts.slice(0, -1)
    }
    pts = simplify([...pts, pts[0]], 0.6).slice(0, -1)
    if (pts.length < 3) continue
    const b = { p: pts.flatMap(([x, z]) => [q(x), q(z)]), h: q(parseHeight(tags, pts)) }
    if (tags.name) b.n = tags.name
    buildings.push(b)
  }
}

const roads = []
for (const el of roadRaw) {
  if (!el.geometry) continue
  const tags = el.tags || {}
  let pts = simplify(
    el.geometry.map((g) => project(g.lat, g.lon)),
    0.8,
  )
  if (pts.length < 2) continue
  const r = { p: pts.flatMap(([x, z]) => [q(x), q(z)]), w: ROAD_W[tags.highway] || 6 }
  if (tags.name) r.n = tags.name
  roads.push(r)
}

const water = []
for (const el of waterRaw) {
  const rings =
    el.type === 'way'
      ? el.geometry
        ? [el.geometry]
        : []
      : (el.members || [])
          .filter((m) => m.role === 'outer' && m.geometry)
          .map((m) => m.geometry)
  for (const ring of rings) {
    let pts = ring.map((g) => project(g.lat, g.lon))
    if (pts.length > 1) {
      const [fx, fz] = pts[0]
      const [lx, lz] = pts[pts.length - 1]
      if (Math.hypot(fx - lx, fz - lz) < 0.01) pts = pts.slice(0, -1)
    }
    pts = simplify([...pts, pts[0]], 1.5).slice(0, -1)
    if (pts.length < 3) continue
    water.push({ p: pts.flatMap(([x, z]) => [q(x), q(z)]) })
  }
}

// Extents, for sizing the island.
let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9
for (const b of buildings)
  for (let i = 0; i < b.p.length; i += 2) {
    minX = Math.min(minX, b.p[i]); maxX = Math.max(maxX, b.p[i])
    minZ = Math.min(minZ, b.p[i + 1]); maxZ = Math.max(maxZ, b.p[i + 1])
  }

const header = `// Downtown Wichita, KS — baked from OpenStreetMap by tools/bake-wichita.mjs.
// Do not hand-edit; re-run the bake instead. Data (c) OpenStreetMap
// contributors, ODbL. Coordinates are meters from Douglas Ave (z=0) x Market
// St-ish (x=0); east = +x, north = -z. p = flat [x,z,...] rings/polylines.
// Extents: x ${q(minX)}..${q(maxX)}, z ${q(minZ)}..${q(maxZ)}.

export interface WichitaBuilding { p: number[]; h: number; n?: string }
export interface WichitaRoad { p: number[]; w: number; n?: string }
export interface WichitaWater { p: number[] }

`
const body =
  `export const BUILDINGS: WichitaBuilding[] = ${JSON.stringify(buildings)}\n\n` +
  `export const ROADS: WichitaRoad[] = ${JSON.stringify(roads)}\n\n` +
  `export const WATER: WichitaWater[] = ${JSON.stringify(water)}\n`

writeFileSync(new URL('../src/wichita-data.ts', import.meta.url), header + body)
console.log(
  `baked ${buildings.length} buildings, ${roads.length} roads, ${water.length} water polys`,
  `| x ${q(minX)}..${q(maxX)} z ${q(minZ)}..${q(maxZ)}`,
)
const named = buildings.filter((b) => b.n && b.h > 15).length
console.log(`tall named landmarks: ${named}`)
