// Collects college basketball inputs, runs the CBB model and writes site/data/cbb.json.
// Run: node src/run-cbb.js   (set ODDS_API_KEY to pull lines from The Odds API)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { buildCbb, hoopsSeason } from "./build-cbb.js";
import { get } from "./net.js";

const root = new URL("..", import.meta.url);
const config = JSON.parse(await readFile(new URL("config/cbb.json", root), "utf8"));
const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(new URL(path, root), "utf8")); } catch { return fallback; } };

const cachePath = `site/data/games-cbb-${hoopsSeason()}.json`;
const gameCache = await readJson(cachePath, {});

let out;
try {
  out = await buildCbb({ config, get, oddsKey: process.env.ODDS_API_KEY || null, gameCache });
} finally {
  // keep whatever box scores were read, even if a later step failed
  await mkdir(new URL("site/data/", root), { recursive: true });
  await writeFile(new URL(cachePath, root), JSON.stringify(gameCache));
}
await writeFile(new URL("site/data/cbb.json", root), JSON.stringify(out));
console.log(`wrote site/data/cbb.json: ${out.games.length} games, ${out.games.filter(g => g.pick).length} picks`);
