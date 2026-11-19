// Builds the NFL output (power rankings + this week's games). No file or env access here,
// so the same code runs in Node (src/run-nfl.js) and in a browser for testing.
import { TEAM_NAMES, BY_ESPN } from "./teams.js";
import { parseQbr, qbrUrl, parseOdds, oddsUrl, weekWindow, nflSeason, espnTeamsUrl, parseEspnTeams, fpiUrl, parseFpi,
         standingsUrl, parseStandings, futuresUrl, parseDivisionOdds } from "./sources.js";
import { loadSeasonGames, teamStats } from "./espn-stats.js";
import { powerRankings, evaluateGame } from "./model.js";

const num = v => { const n = parseFloat(String(v ?? "").replace(/[%,]/g, "")); return Number.isFinite(n) ? n : null; };
const ratio = (a, b, digits) => (a == null || !b) ? null : (a / b).toFixed(digits);
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

// get(url, "text" | "json") fetches with retries; manualGames is used when there is no odds key.
// gameCache: box scores already read in earlier runs (updated in place).
export async function buildNfl({ config, get, oddsKey = null, manualGames = null, gameCache = {}, now = new Date(), log = console.log }) {
  const season = nflSeason(now);

  // 1. Team stats from ESPN box scores, ranked 1-32 (1 = best)
  const idByTeam = {};
  for (const e of parseEspnTeams(await get(espnTeamsUrl("nfl"), "json"))) if (BY_ESPN[e.abbr]) idByTeam[BY_ESPN[e.abbr]] = e.id;
  const missingIds = TEAM_NAMES.filter(t => !idByTeam[t]);
  if (missingIds.length) throw new Error(`ESPN teams list is missing ${missingIds.join(", ")}`);
  const played = await loadSeasonGames({ league: "nfl", season, weeks: 18, get, cache: gameCache, log });
  const ts = teamStats(played, Object.values(idByTeam));
  const stats = Object.fromEntries(TEAM_NAMES.map(t => [t, ts.stats[idByTeam[t]]]));
  const info = Object.fromEntries(TEAM_NAMES.map(t => [t, { record: ts.record[idByTeam[t]], qb: null }]));
  log(`ok  team stats from ${played.length} games`);

  // Strength of schedule: ESPN FPI's SOS rank (past schedule) and remaining-SoS rank.
  // If FPI is unavailable, SoS falls back to the box-score rating (SRS) computed above.
  const remSos = {};
  try {
    const fpi = parseFpi(await get(fpiUrl(season), "json"), t => BY_ESPN[t?.abbreviation]);
    let n = 0;
    for (const t of TEAM_NAMES) {
      if (fpi[t]?.sos) { stats[t].sos = { r: fpi[t].sos, v: null }; n++; }
      remSos[t] = fpi[t]?.remSos ?? null;
    }
    log(`ok  ESPN FPI strength of schedule (${n} teams)`);
  } catch (e) { log(`warn FPI: ${e.message} (using box-score SoS)`); }

  // 2. ESPN QBR (rank among qualified passers)
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

  // 6. Division standings (ESPN) and division-winner odds (DraftKings via ESPN).
  //    Optional: if either source fails, the rest of the page still publishes.
  let standings = [], divOdds = {};
  try {
    standings = parseStandings(await get(standingsUrl(season), "json"));
    log(`ok  ESPN standings (${standings.length} teams)`);
  } catch (e) { log(`warn standings: ${e.message}`); }
  try {
    const byId = Object.fromEntries(standings.map(s => [s.espnId, s.team]));
    divOdds = parseDivisionOdds(await get(futuresUrl(season), "json"), byId);
    log(`ok  division odds (${Object.keys(divOdds).length} teams)`);
  } catch (e) { log(`warn division odds: ${e.message}`); }

  const teamOut = name => ({
    name, modelRank: modelRank[name], record: info[name].record, qb: info[name].qb,
    qbr: stats[name].qbr.assumed ? null : stats[name].qbr.r, qbrAssumed: !!stats[name].qbr.assumed,
    offYppRank: stats[name].yardsPerPlay.r, defYppRank: stats[name].oppYardsPerPlay.r, sosRank: stats[name].sos.r,
    remSosRank: remSos[name] ?? null,
  });

  return {
    sport: "nfl",
    teamCount: 32,
    statsSource: "ESPN box scores",
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
    divisions: [...new Set(standings.map(s => s.division))].map(division => ({
      name: division,
      conference: standings.find(s => s.division === division).conference,
      teams: standings.filter(s => s.division === division).sort((a, b) => a.seed - b.seed)
        .map(s => ({ ...teamOut(s.team), overall: s.overall, divRecord: s.divRecord, odds: divOdds[s.team] ?? null })),
    })),
  };
}
