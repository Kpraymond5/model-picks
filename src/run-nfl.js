// Collects this week's inputs, runs the model and writes site/data/nfl.json.
// Run: node src/run-nfl.js   (set ODDS_API_KEY to pull lines from The Odds API)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { buildNfl } from "./build-nfl.js";

const root = new URL("..", import.meta.url);
const config = JSON.parse(await readFile(new URL("config/nfl.json", root), "utf8"));
const UA = { "User-Agent": "Mozilla/5.0 (compatible; model-picks/1.0)" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retries ride out short outages: waits 5s, 20s, then 60s before giving up.
const WAITS = [5000, 20000, 60000];
async function get(url, as = "text") {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === "json" ? await res.json() : await res.text();
    } catch (e) {
      const where = url.split("?")[0];
      if (attempt >= WAITS.length) throw new Error(`${where}: ${e.message}`);
      console.log(`retry ${where} (${e.message})`);
      await sleep(WAITS[attempt]);
    }
  }
}

let manualGames = null;
try { manualGames = JSON.parse(await readFile(new URL("data/nfl-games.json", root), "utf8")); } catch {}

const out = await buildNfl({ config, get, oddsKey: process.env.ODDS_API_KEY || null, manualGames });

await mkdir(new URL("site/data/", root), { recursive: true });
await writeFile(new URL("site/data/nfl.json", root), JSON.stringify(out));
console.log(`wrote site/data/nfl.json: ${out.games.length} games, ${out.games.filter(g => g.pick).length} picks`);
