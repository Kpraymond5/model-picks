// Builds the college football output, ported from the colfoot sheet ("Power Rankings" and "Week V").
// Team stats come from ESPN box scores. Same output shape as build-nfl.js so the site renders both alike.
import { parseQbr, qbrUrl, parseOdds, oddsUrl, weekWindow, nflSeason, slugify, fpiUrl, parseFpi,
         espnTeamsUrl, parseEspnTeams, standingsUrl, parseCollegeStandings, futuresUrl, parseDivisionOdds } from "./sources.js";
import { loadSeasonGames, teamStats } from "./espn-stats.js";
import { powerRankings, evaluateGame } from "./model.js";

const num = v => { const n = parseFloat(String(v ?? "").replace(/[%,]/g, "")); return Number.isFinite(n) ? n : null; };
const ratio = (a, b, digits) => (a == null || !b) ? null : (a / b).toFixed(digits);
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

export async function buildCfb({ config, get, oddsKey = null, gameCache = {}, now = new Date(), log = console.log }) {
  const season = nflSeason(now);
  const league = config.espnLeague;

  // 1. FBS teams: ESPN's FBS standings give the list and conferences; the teams list gives names.
  const espnTeams = parseEspnTeams(await get(espnTeamsUrl(league), "json"));
  const nameById = Object.fromEntries(espnTeams.map(e => [e.id, e.short || e.name]));
  const standingsJson = await get(standingsUrl(season, league, ""), "json");
  const standings = parseCollegeStandings(standingsJson, nameById);
  const byEspnId = Object.fromEntries(standings.map(s => [s.espnId, s.team]));
  const teams = standings.map(s => s.team);
  const idOf = Object.fromEntries(standings.map(s => [s.team, s.espnId]));
  const N = teams.length;
  if (N < 100) throw new Error(`ESPN FBS standings returned only ${N} teams`);
  log(`ok  ESPN FBS teams (${N})`);

  // Odds API names -> our names, matched on ESPN's slug or full name
  const ourBySlug = {};
  for (const e of espnTeams) if (byEspnId[e.id]) { ourBySlug[e.slug] = byEspnId[e.id]; ourBySlug[slugify(e.name)] = byEspnId[e.id]; }
  const resolveName = name => ourBySlug[slugify(name)] || ourBySlug[config.teamAliases?.[slugify(name)]];

  // 2. Team stats from ESPN box scores (all of each team's games, FCS opponents included)
  const played = await loadSeasonGames({ league, season, weeks: 16, groups: 80, get, cache: gameCache, log });
  const ts = teamStats(played, teams.map(t => idOf[t]));
  const stats = Object.fromEntries(teams.map(t => [t, ts.stats[idOf[t]]]));
  const info = Object.fromEntries(teams.map(t => [t, { record: ts.record[idOf[t]], qb: null }]));
  log(`ok  team stats from ${played.length} games`);
  // Strength of schedule: ESPN FPI's SOS rank (past schedule) and remaining-SoS rank.
  // A team FPI doesn't list keeps the box-score SoS; with no SoS at all it gets the sheet's 70.
  const remSos = {};
  try {
    const fpi = parseFpi(await get(fpiUrl(season, league), "json"), t => byEspnId[String(t?.id)]);
    let n = 0;
    for (const t of teams) {
      if (fpi[t]?.sos) { stats[t].sos = { r: fpi[t].sos, v: null }; n++; }
      remSos[t] = fpi[t]?.remSos ?? null;
    }
    log(`ok  ESPN FPI strength of schedule (${n} of ${N} teams)`);
  } catch (e) { log(`warn FPI: ${e.message} (using box-score SoS)`); }
  for (const t of teams) if (stats[t].sos.r == null) stats[t].sos = { r: config.sosMissingRank, v: null };

  // 3. ESPN college QBR (rank among qualified passers); no qualified passer -> the sheet's 68.
  try {
    for (const row of parseQbr(await get(qbrUrl(season, league), "json"), a => byEspnId[String(a.athlete?.teamId)])) {
      stats[row.team].qbr = { r: row.rank, v: null };
      info[row.team].qb = row.qb;
    }
    log(`ok  ESPN QBR ${season}`);
  } catch (e) { log(`warn QBR: ${e.message}`); }
  for (const t of teams) if (!stats[t].qbr) stats[t].qbr = { r: config.qbrMissingRank, v: null, assumed: true };

  // 4. Per-play ratios for the expanded Power Rankings view
  for (const t of teams) {
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

  // 5. Model (a team with no rank for a stat gets the worst rank)
  const ranks = Object.fromEntries(teams.map(t => [t, Object.fromEntries(config.stats.map(s => [s.key, stats[t][s.key]?.r ?? N]))]));
  const table = powerRankings(ranks, config);
  const modelRank = Object.fromEntries(table.map(r => [r.team, r.modelRank]));

  // 6. Games and lines (FBS vs FBS only)
  let games = [], gamesSource = "none";
  if (oddsKey) {
    const { from, until } = weekWindow(now);
    const unmatched = new Set();
    games = parseOdds(await get(oddsUrl(oddsKey, config.oddsSport), "json"), { bookmaker: config.oddsBookmaker, from, until, resolve: resolveName, unmatched });
    gamesSource = `The Odds API (${games[0]?.book ?? "no games"})`;
    if (unmatched.size) log(`note games skipped, teams not matched to FBS: ${[...unmatched].join(", ")}`);
  }
  log(`ok  ${games.length} games from ${gamesSource}`);

  // 7. Conference-winner odds (optional)
  let confOdds = {};
  try {
    confOdds = parseDivisionOdds(await get(futuresUrl(season, league), "json"), byEspnId,
      item => /conference/i.test(item.name || "") && !/championship game|playoff/i.test(item.name || ""));
    log(`ok  conference odds (${Object.keys(confOdds).length} teams)`);
  } catch (e) { log(`warn conference odds: ${e.message}`); }

  const teamOut = name => ({
    name, modelRank: modelRank[name], record: info[name].record, qb: info[name].qb,
    qbr: stats[name].qbr.assumed ? null : stats[name].qbr.r, qbrAssumed: !!stats[name].qbr.assumed,
    offYppRank: stats[name].yardsPerPlay.r, defYppRank: stats[name].oppYardsPerPlay.r, sosRank: stats[name].sos.r,
    remSosRank: remSos[name] ?? null,
  });

  return {
    sport: "cfb",
    statsSource: "ESPN box scores",
    generatedAt: now.toISOString(),
    season,
    teamCount: N,
    gamesSource,
    groupRecordLabel: "Conf W-L",
    settings: { lineFactor: config.lineFactor, lineFactorTop: config.lineFactorTop, topN: config.topN, homeField: config.homeField,
                pickThreshold: config.pickThreshold, qbrMissingRank: config.qbrMissingRank },
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
    divisions: [...new Set(standings.map(s => s.conference))].map(conf => ({
      name: conf, conference: "FBS",
      teams: standings.filter(s => s.conference === conf)
        .map(s => ({ ...teamOut(s.team), overall: s.overall, divRecord: s.confRecord, odds: confOdds[s.team] ?? null })),
    })),
  };
}
