// snapshot.mjs — backs up FINISHED tiktactownship games to static JSON files.
// Run hourly by .github/workflows/snapshot.yml. Node 20+ (built-in fetch), no deps.
//
// It only ever READS the public Data API with the publishable key (the same
// public values that are already in index.html) and only ever touches games
// that are already OVER. The live game is never read or written here.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

// same public values as the frontend — safe to sit in a public repo
const SUPABASE_URL = "https://ufytfudgkamcvmalvxlk.supabase.co";
const SUPABASE_KEY = "sb_publishable_lWBuyPDuS7XJ7omknKGf8Q__S3D9a6B";

const REST    = `${SUPABASE_URL}/rest/v1`;
const OUT_DIR = "games";
const INDEX   = "index.json";
const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

// 1. how far did we get last time? (games finish strictly in order, so this is a clean watermark)
let last = 0;
if (existsSync(INDEX)) {
  try { last = JSON.parse(await readFile(INDEX, "utf8")).latest || 0; } catch {}
}

// 2. pull every move of every FINISHED game newer than the watermark, paged past the 1000-row cap
async function fetchNewMoves() {
  const rows = [], size = 1000;
  for (let offset = 0; ; offset += size) {
    const url = `${REST}/full_export?select=*` +
      `&game_status=neq.active&game_no=gt.${last}` +
      `&order=game_no.asc,move_number.asc&limit=${size}&offset=${offset}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < size) break;
  }
  return rows;
}

const rows = await fetchNewMoves();
if (rows.length === 0) {
  console.log(`No new finished games since #${last}. Nothing to do.`);
  process.exit(0);
}

// 3. fold the flat rows into one object per game
const games = new Map();
for (const r of rows) {
  if (!games.has(r.game_no)) {
    games.set(r.game_no, {
      game_no: r.game_no,
      status: r.game_status,
      winner_mark: r.winner_mark,
      winner_city: r.winner_city, winner_region: r.winner_region, winner_country: r.winner_country,
      started_at: r.game_started_utc, ended_at: r.game_ended_utc,
      moves: []
    });
  }
  games.get(r.game_no).moves.push({
    move_number: r.move_number, mark: r.mark, cell: r.cell, cell_label: r.cell_label,
    emojis: r.emojis, city: r.city, region: r.region, country: r.country,
    maps_url: r.maps_url, made_at: r.move_at_utc
  });
}

// 4. write one immutable file per game
await mkdir(OUT_DIR, { recursive: true });
let highest = last;
for (const [no, game] of [...games].sort((a, b) => a[0] - b[0])) {
  await writeFile(`${OUT_DIR}/${no}.json`, JSON.stringify(game));
  highest = Math.max(highest, no);
}

// 5. advance the index so the next run and the archive viewer both know how far static goes
await writeFile(INDEX, JSON.stringify({ latest: highest, updated_at: new Date().toISOString() }, null, 2));
console.log(`Snapshotted games ${last + 1}..${highest} (${games.size} file${games.size === 1 ? "" : "s"}).`);
