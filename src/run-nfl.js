// Collects this week's inputs, runs the model and writes site/data/nfl.json.
// Run: node src/run-nfl.js   (set ODDS_API_KEY to pull lines from The Odds API)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { buildNfl } from "./build-nfl.js";

const root = new URL("..", import.meta.url);
const config = JSON.parse(await readFile(new URL("config/nfl.json", root), "utf8"));
const UA = { "User-Agent": "Mozilla/5.0 (compatible; model-picks/1.0)" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, as = "text") {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === "json" ? await res.json() : await res.text();
    } catch (e) {
      if (attempt >= 3) throw new Error(`${url.split("?")[0]}: ${e.message}`);
      await sleep(3000 * attempt);
    }
  }
}

let manualGames = null;
try { manualGames = JSON.parse(await readFile(new URL("data/nfl-games.json", root), "utf8")); } catch {}

const out = await buildNfl({ config, get, oddsKey: process.env.ODDS_API_KEY || null, manualGames });

await mkdir(new URL("site/data/", root), { recursive: true });
await writeFile(new URL("site/data/nfl.json", root), JSON.stringify(out));
console.log(`wrote site/data/nfl.json: ${out.games.length} games, ${out.games.filter(g => g.pick).length} picks`);
