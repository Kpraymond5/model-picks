// Collects this week's inputs, runs the model and writes site/data/nfl.json.
// Run: node src/run-nfl.js   (set ODDS_API_KEY to pull lines from The Odds API)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { TEAM_NAMES } from "./teams.js";
import { parseTeamRankings, parseQbr, qbrUrl, parseOdds, oddsUrl, weekWindow, nflSeason } from "./sources.js";
import { powerRankings, evaluateGame } from "./model.js";

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

const now = new Date();
const ranks = Object.fromEntries(TEAM_NAMES.map(t => [t, {}]));
const info = Object.fromEntries(TEAM_NAMES.map(t => [t, { record: null, qb: null }]));

// 1. TeamRankings stat pages (politely, one at a time)
for (const stat of config.stats.filter(s => s.source !== "espn-qbr")) {
  const rows = parseTeamRankings(await get(`https://www.teamrankings.com/nfl/${stat.source}`));
  for (const row of rows) {
    if (!ranks[row.team]) continue;
    ranks[row.team][stat.key] = row.rank;
    if (stat.key === "sos" && row.record) info[row.team].record = row.record;
  }
  const missing = TEAM_NAMES.filter(t => ranks[t][stat.key] == null);
  if (missing.length) throw new Error(`${stat.source} is missing ${missing.join(", ")}`);
  console.log(`ok  ${stat.source}`);
  await sleep(1500);
}

// 2. ESPN QBR
const season = nflSeason(now);
for (const row of parseQbr(await get(qbrUrl(season), "json"))) {
  ranks[row.team].qbr = row.rank;
  info[row.team].qb = row.qb;
}
const noQbr = TEAM_NAMES.filter(t => ranks[t].qbr == null);
for (const t of noQbr) ranks[t].qbr = config.qbrMissingRank;
console.log(`ok  ESPN QBR ${season}` + (noQbr.length ? ` (no qualified QB: ${noQbr.join(", ")})` : ""));

// 3. Model
const table = powerRankings(ranks, config);
const modelRank = Object.fromEntries(table.map(r => [r.team, r.modelRank]));

// 4. Games and lines: The Odds API, else the hand-kept file data/nfl-games.json
let games = [], gamesSource;
const { from, until } = weekWindow(now);
if (process.env.ODDS_API_KEY) {
  games = parseOdds(await get(oddsUrl(process.env.ODDS_API_KEY), "json"), { bookmaker: config.oddsBookmaker, from, until });
  gamesSource = `The Odds API (${games[0]?.book ?? "no games"})`;
} else {
  try {
    games = JSON.parse(await readFile(new URL("data/nfl-games.json", root), "utf8"))
      .filter(g => new Date(g.kickoff) >= from && new Date(g.kickoff) < until);
    gamesSource = "data/nfl-games.json";
  } catch { gamesSource = "none"; }
}
console.log(`ok  ${games.length} games from ${gamesSource}`);

const teamOut = name => ({
  name, modelRank: modelRank[name], record: info[name].record, qb: info[name].qb,
  qbr: info[name].qb ? ranks[name].qbr : null,
  offYppRank: ranks[name].yardsPerPlay, defYppRank: ranks[name].oppYardsPerPlay, sosRank: ranks[name].sos,
});

const out = {
  generatedAt: now.toISOString(),
  season,
  gamesSource,
  settings: { lineFactor: config.lineFactor, homeField: config.homeField, pickThreshold: config.pickThreshold },
  games: games.map(g => {
    const r = evaluateGame(modelRank[g.home], modelRank[g.away], g.homeSpread, config);
    return {
      kickoff: g.kickoff, total: g.total,
      away: { ...teamOut(g.away), spread: g.homeSpread == null ? null : -g.homeSpread, ml: g.awayMl },
      home: { ...teamOut(g.home), spread: g.homeSpread, ml: g.homeMl },
      line: round(r.line, 2), delta: r.delta == null ? null : round(r.delta, 2),
      pick: r.pick ? (r.pick === "home" ? g.home : g.away) : null,
    };
  }),
  powerRankings: table.map(r => ({ ...teamOut(r.team), score: round(r.score, 3), ranks: ranks[r.team] })),
};

await mkdir(new URL("site/data/", root), { recursive: true });
await writeFile(new URL("site/data/nfl.json", root), JSON.stringify(out, null, 1));
console.log(`wrote site/data/nfl.json: ${out.games.length} games, ${out.games.filter(g => g.pick).length} picks`);

function round(x, d) { const f = 10 ** d; return Math.round(x * f) / f; }
