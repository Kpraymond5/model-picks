// Collects this week's college inputs, runs the CFB model and writes site/data/cfb.json.
// Run: node src/run-cfb.js   (set ODDS_API_KEY to pull lines from The Odds API)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { buildCfb } from "./build-cfb.js";
import { nflSeason } from "./sources.js";
import { get } from "./net.js";

const root = new URL("..", import.meta.url);
const config = JSON.parse(await readFile(new URL("config/cfb.json", root), "utf8"));
const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(new URL(path, root), "utf8")); } catch { return fallback; } };

const cachePath = `site/data/games-cfb-${nflSeason()}.json`;
const gameCache = await readJson(cachePath, {});

let out;
try {
  out = await buildCfb({ config, get, oddsKey: process.env.ODDS_API_KEY || null, gameCache });
} finally {
  // keep whatever box scores were read, even if a later step failed
  await mkdir(new URL("site/data/", root), { recursive: true });
  await writeFile(new URL(cachePath, root), JSON.stringify(gameCache));
}
await writeFile(new URL("site/data/cfb.json", root), JSON.stringify(out));
console.log(`wrote site/data/cfb.json: ${out.games.length} games, ${out.games.filter(g => g.pick).length} picks`);
