// Collects this week's inputs, runs the NFL model and writes site/data/nfl.json.
// Run: node src/run-nfl.js   (set ODDS_API_KEY to pull lines from The Odds API)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { buildNfl } from "./build-nfl.js";
import { nflSeason } from "./sources.js";
import { get } from "./net.js";

const root = new URL("..", import.meta.url);
const config = JSON.parse(await readFile(new URL("config/nfl.json", root), "utf8"));
const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(new URL(path, root), "utf8")); } catch { return fallback; } };

const cachePath = `site/data/games-nfl-${nflSeason()}.json`;
const gameCache = await readJson(cachePath, {});
const manualGames = await readJson("data/nfl-games.json", null);

const out = await buildNfl({ config, get, oddsKey: process.env.ODDS_API_KEY || null, manualGames, gameCache });

await mkdir(new URL("site/data/", root), { recursive: true });
await writeFile(new URL(cachePath, root), JSON.stringify(gameCache));
await writeFile(new URL("site/data/nfl.json", root), JSON.stringify(out));
console.log(`wrote site/data/nfl.json: ${out.games.length} games, ${out.games.filter(g => g.pick).length} picks`);
