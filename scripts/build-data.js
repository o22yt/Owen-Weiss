#!/usr/bin/env node
/*
 * Builds the game's data files from two npm packages:
 *   - world-atlas      (Natural Earth 1:50m country shapes, TopoJSON)
 *   - world-countries  (country metadata: capitals, languages, borders, ...)
 *
 * Output (plain <script> files so the game works straight from file:// too):
 *   data/world.js      -> window.WORLD_TOPO     (TopoJSON, geometry ids = ISO alpha-3)
 *   data/countries.js  -> window.COUNTRIES      (metadata for every guessable country)
 *
 * Usage:  npm install && npm run build:data
 */
const fs = require("fs");
const path = require("path");

const topo = JSON.parse(JSON.stringify(require("world-atlas/countries-50m.json")));
const meta = require("world-countries");

// Shapes with no ISO numeric code in world-atlas, matched by name instead.
const NAME_TO_CCA3 = { Kosovo: "UNK" };
// Non-"independent" places we still want in the game.
const EXTRA_COUNTRIES = new Set(["UNK", "TWN", "PSE", "ESH"]);
// Countries smaller than this are guessable but never picked as the daily answer
// (at map resolution they're just a dot).
const MIN_DAILY_AREA_KM2 = 500;

const byNumeric = new Map(meta.filter((m) => m.ccn3).map((m) => [m.ccn3, m]));
const byCca3 = new Map(meta.map((m) => [m.cca3, m]));

const shapeIds = new Set();
for (const g of topo.objects.countries.geometries) {
  let cca3 = null;
  if (g.id && byNumeric.has(g.id)) cca3 = byNumeric.get(g.id).cca3;
  else if (NAME_TO_CCA3[g.properties.name]) cca3 = NAME_TO_CCA3[g.properties.name];
  g.id = cca3 || undefined;
  g.properties = {};
  if (cca3) shapeIds.add(cca3);
}

const countries = meta
  .filter((m) => (m.independent || EXTRA_COUNTRIES.has(m.cca3)) && shapeIds.has(m.cca3))
  .map((m) => ({
    id: m.cca3,
    name: m.name.common,
    official: m.name.official,
    aliases: [...new Set([m.name.official, ...m.altSpellings.filter((s) => s.length > 3)])].filter(
      (s) => s !== m.name.common
    ),
    capital: m.capital || [],
    region: m.region,
    subregion: m.subregion || m.region,
    languages: Object.values(m.languages || {}),
    currencies: Object.values(m.currencies || {}).map((c) => c.name),
    latlng: m.latlng,
    landlocked: m.landlocked,
    borders: m.borders.filter((b) => byCca3.has(b)),
    area: m.area,
    flag: m.flag,
    cca2: m.cca2,
    daily: m.area >= MIN_DAILY_AREA_KM2,
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

// Size rank among all countries in the game (1 = largest).
[...countries].sort((a, b) => b.area - a.area).forEach((c, i) => (c.areaRank = i + 1));

const out = path.join(__dirname, "..", "data");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "world.js"), "window.WORLD_TOPO=" + JSON.stringify(topo) + ";\n");
fs.writeFileSync(
  path.join(out, "countries.js"),
  "window.COUNTRIES=" + JSON.stringify(countries) + ";\n"
);
console.log(
  `Wrote ${countries.length} countries (${countries.filter((c) => c.daily).length} eligible as daily answers).`
);
