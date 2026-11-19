// Collects this week's inputs, runs the NFL model and writes site/data/nfl.json.
// Run: node src/run-nfl.js   (set ODDS_API_KEY to pull lines from The Odds API)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { buildNfl } from "./build-nfl.js";
import { get } from "./net.js";

const root = new URL("..", import.meta.url);
const config = JSON.parse(await readFile(new URL("config/nfl.json", root), "utf8"));

let manualGames = null;
try { manualGames = JSON.parse(await readFile(new URL("data/nfl-games.json", root), "utf8")); } catch {}

const out = await buildNfl({ config, get, oddsKey: process.env.ODDS_API_KEY || null, manualGames });
out.sport = "nfl";
out.teamCount = 32;

await mkdir(new URL("site/data/", root), { recursive: true });
await writeFile(new URL("site/data/nfl.json", root), JSON.stringify(out));
console.log(`wrote site/data/nfl.json: ${out.games.length} games, ${out.games.filter(g => g.pick).length} picks`);
