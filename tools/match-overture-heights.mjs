// Match Overture Maps lidar-derived building heights onto the OSM footprints
// in tools/.cache-buildings.json, writing tools/overture-heights.json keyed by
// OSM element id. Input comes from a DuckDB query of the Overture buildings
// theme (see the audit that added this); the output file is committed so
// re-bakes are reproducible without re-querying S3.
//
// Data (c) OpenStreetMap contributors (ODbL) and Overture Maps Foundation.

import { readFileSync, writeFileSync } from 'node:fs'

const OVERTURE_JSON = process.argv[2]
if (!OVERTURE_JSON) {
  console.error('usage: node tools/match-overture-heights.mjs <overture-buildings.json>')
  process.exit(1)
}

const osm = JSON.parse(readFileSync(new URL('./.cache-buildings.json', import.meta.url), 'utf8'))
const ovt = JSON.parse(readFileSync(OVERTURE_JSON, 'utf8'))

function ringsOf(g) {
  if (g.type === 'Polygon') return [g.coordinates[0]]
  if (g.type === 'MultiPolygon') return g.coordinates.map((p) => p[0])
  return []
}

function inside(ring, lon, lat) {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

const out = {}
let matched = 0
for (const el of osm) {
  const geoms =
    el.type === 'way'
      ? el.geometry
        ? [el.geometry]
        : []
      : (el.members || []).filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry)
  if (!geoms.length) continue
  // OSM centroid
  let lat = 0
  let lon = 0
  let n = 0
  for (const g of geoms)
    for (const p of g) {
      lat += p.lat
      lon += p.lon
      n++
    }
  lat /= n
  lon /= n
  // Overture polygon containing the OSM centroid; nearest-centroid fallback.
  let best = null
  for (const b of ovt) {
    if (b.h == null) continue
    if (ringsOf(b.g).some((r) => inside(r, lon, lat))) {
      if (!best || b.h > best.h) best = b
    }
  }
  if (!best) {
    let bd = 1e9
    for (const b of ovt) {
      if (b.h == null) continue
      const d = Math.hypot((b.lon - lon) * 88000, (b.lat - lat) * 111320)
      if (d < bd) {
        bd = d
        best = b
      }
    }
    if (bd > 12) best = null
  }
  if (best) {
    out[el.id] = Math.round(best.h * 10) / 10
    matched++
  }
}

writeFileSync(new URL('./overture-heights.json', import.meta.url), JSON.stringify(out))
console.log(`matched ${matched}/${osm.length} OSM buildings to Overture heights`)
