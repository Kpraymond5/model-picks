// Builds the NFL output (power rankings + this week's games). No file or env access here,
// so the same code runs in Node (src/run-nfl.js) and in a browser for testing.
import { TEAM_NAMES } from "./teams.js";
import { parseTeamRankings, parseQbr, qbrUrl, parseOdds, oddsUrl, weekWindow, nflSeason } from "./sources.js";
import { powerRankings, evaluateGame } from "./model.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const n = parseFloat(String(v ?? "").replace(/[%,]/g, "")); return Number.isFinite(n) ? n : null; };
const ratio = (a, b, digits) => (a == null || !b) ? null : (a / b).toFixed(digits);
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

// get(url, "text" | "json") fetches with retries; manualGames is used when there is no odds key.
export async function buildNfl({ config, get, oddsKey = null, manualGames = null, now = new Date(), log = console.log, pause = 1500 }) {
  const stats = Object.fromEntries(TEAM_NAMES.map(t => [t, {}]));   // team -> key -> {r, v}
  const info = Object.fromEntries(TEAM_NAMES.map(t => [t, { record: null, qb: null }]));

  // 1. TeamRankings pages: model stats first, then display-only stats
  const pages = [...config.stats.filter(s => s.source !== "espn-qbr"), ...(config.displayStats || [])];
  for (const page of pages) {
    const rows = parseTeamRankings(await get(`https://www.teamrankings.com/nfl/${page.source}`, "text"));
    for (const row of rows) {
      if (!stats[row.team]) continue;
      stats[row.team][page.key] = { r: row.rank, v: row.value };
      if (page.key === "sos" && row.record) info[row.team].record = row.record;
    }
    const missing = TEAM_NAMES.filter(t => !stats[t][page.key]);
    if (missing.length) throw new Error(`${page.source} is missing ${missing.join(", ")}`);
    log(`ok  ${page.source}`);
    if (pause) await sleep(pause);
  }
  for (const t of TEAM_NAMES) stats[t].sos.v = null; // the SoS "value" is a rating, not shown

  // 2. ESPN QBR (rank among qualified passers)
  const season = nflSeason(now);
  for (const row of parseQbr(await get(qbrUrl(season), "json"))) {
    stats[row.team].qbr = { r: row.rank, v: null };
    info[row.team].qb = row.qb;
  }
  const noQbr = TEAM_NAMES.filter(t => !stats[t].qbr);
  for (const t of noQbr) stats[t].qbr = { r: config.qbrMissingRank, v: null, assumed: true };
  log(`ok  ESPN QBR ${season}` + (noQbr.length ? ` (no qualified QB: ${noQbr.join(", ")})` : ""));

  // 3. Per-play ratios shown in the Power Rankings tab (from the displayed values, like the sheet)
  for (const t of TEAM_NAMES) {
    const s = stats[t], n = k => num(s[k]?.v);
    s.passYdsPerAtt = { v: ratio(n("passYds"), n("passAtt"), 2) };
    s.rushYdsPerAtt = { v: ratio(n("rushYds"), n("rushAtt"), 2) };
    s.oppPassYdsPerAtt = { v: ratio(n("oppPassYds"), n("oppPassAtt"), 2) };
    s.oppRushYdsPerAtt = { v: ratio(n("oppRushYds"), n("oppRushAtt"), 2) };
    s.redZoneAttPerPlay = { v: ratio(n("redZoneAtt"), n("plays"), 3) };
    s.oppRedZoneAttPerPlay = { v: ratio(n("oppRedZoneAtt"), n("oppPlays"), 3) };
    s.intThrownPerAtt = { v: ratio(n("intThrown"), n("passAtt"), 3) };
    s.interceptionsPerAtt = { v: ratio(n("interceptions"), n("oppPassAtt"), 3) };
  }

  // 4. Model
  const ranks = Object.fromEntries(TEAM_NAMES.map(t => [t, Object.fromEntries(config.stats.map(s => [s.key, stats[t][s.key].r]))]));
  const table = powerRankings(ranks, config);
  const modelRank = Object.fromEntries(table.map(r => [r.team, r.modelRank]));

  // 5. Games and lines
  let games = [], gamesSource = "none";
  const { from, until } = weekWindow(now);
  if (oddsKey) {
    games = parseOdds(await get(oddsUrl(oddsKey), "json"), { bookmaker: config.oddsBookmaker, from, until });
    gamesSource = `The Odds API (${games[0]?.book ?? "no games"})`;
  } else if (manualGames) {
    games = manualGames.filter(g => new Date(g.kickoff) >= from && new Date(g.kickoff) < until);
    gamesSource = "data/nfl-games.json";
  }
  log(`ok  ${games.length} games from ${gamesSource}`);

  const teamOut = name => ({
    name, modelRank: modelRank[name], record: info[name].record, qb: info[name].qb,
    qbr: stats[name].qbr.assumed ? null : stats[name].qbr.r, qbrAssumed: !!stats[name].qbr.assumed,
    offYppRank: stats[name].yardsPerPlay.r, defYppRank: stats[name].oppYardsPerPlay.r, sosRank: stats[name].sos.r,
  });

  return {
    generatedAt: now.toISOString(),
    season,
    gamesSource,
    settings: { lineFactor: config.lineFactor, homeField: config.homeField, pickThreshold: config.pickThreshold, qbrMissingRank: config.qbrMissingRank },
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
    powerRankings: table.map(r => ({ ...teamOut(r.team), score: round(r.score, 3), stats: stats[r.team] })),
  };
}
