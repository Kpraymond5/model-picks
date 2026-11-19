// Builds the college football output, ported from the colfoot sheet ("Power Rankings" and "Week V").
// Same shape as build-nfl.js so the site renders both the same way.
import { parseTeamRankings, parseQbr, qbrUrl, parseOdds, oddsUrl, weekWindow, nflSeason, slugify,
         espnTeamsUrl, parseEspnTeams, standingsUrl, parseCollegeStandings, futuresUrl, parseDivisionOdds } from "./sources.js";
import { powerRankings, evaluateGame } from "./model.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const n = parseFloat(String(v ?? "").replace(/[%,]/g, "")); return Number.isFinite(n) ? n : null; };
const ratio = (a, b, digits) => (a == null || !b) ? null : (a / b).toFixed(digits);
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

export async function buildCfb({ config, get, oddsKey = null, now = new Date(), log = console.log, pause = 1500 }) {
  const season = nflSeason(now);
  const league = config.espnLeague;

  // 1. TeamRankings pages. The team list (FBS) comes from the first page.
  const stats = {}, info = {}, slugOf = {};
  const pages = [...config.stats.filter(s => s.source !== "espn-qbr"), ...(config.displayStats || [])];
  for (const page of pages) {
    const rows = parseTeamRankings(await get(`https://www.teamrankings.com/${config.trPath}/${page.source}`, "text"));
    if (!Object.keys(stats).length) for (const r of rows) { stats[r.team] = {}; info[r.team] = { record: null, qb: null }; }
    for (const r of rows) {
      if (!stats[r.team]) continue;
      stats[r.team][page.key] = { r: r.rank, v: r.value };
      if (r.slug) slugOf[r.team] = r.slug;
      if (page.key === "sos" && r.record) info[r.team].record = r.record;
    }
    log(`ok  ${page.source}`);
    if (pause) await sleep(pause);
  }
  const teams = Object.keys(stats);
  const N = teams.length;

  // A team missing from a stat page gets the worst rank for that stat (SoS uses the sheet's 70).
  for (const s of config.stats) {
    if (s.source === "espn-qbr") continue;
    const missing = teams.filter(t => !stats[t][s.key]);
    for (const t of missing) stats[t][s.key] = { r: s.key === "sos" ? config.sosMissingRank : N, v: null, assumed: true };
    if (missing.length) log(`note ${s.source}: no row for ${missing.join(", ")}`);
  }
  // SoS: re-rank TeamRankings' SoS rank among these teams (sheet: RANK of the combined SoS column).
  const rawSos = Object.fromEntries(teams.map(t => [t, stats[t].sos.r]));
  for (const t of teams) stats[t].sos = { r: 1 + teams.filter(o => rawSos[o] < rawSos[t]).length, v: null };

  // 2. ESPN team ids -> our names, matched on the team's full-name slug.
  const ourBySlug = {};
  for (const t of teams) {
    const s = slugOf[t];
    if (!s) continue;
    ourBySlug[s] = t;
    if (config.teamAliases?.[s]) ourBySlug[config.teamAliases[s]] = t;
  }
  const byEspnId = {};
  try {
    for (const e of parseEspnTeams(await get(espnTeamsUrl(league), "json"))) {
      const t = ourBySlug[e.slug] || ourBySlug[slugify(e.name)];
      if (t) { byEspnId[e.id] = t; ourBySlug[slugify(e.name)] = t; }
    }
    log(`ok  ESPN teams (${Object.keys(byEspnId).length} of ${N} matched)`);
  } catch (e) { log(`warn ESPN teams: ${e.message}`); }
  const resolveName = name => ourBySlug[slugify(name)] || ourBySlug[config.teamAliases?.[slugify(name)]];

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

  // 5. Model
  const ranks = Object.fromEntries(teams.map(t => [t, Object.fromEntries(config.stats.map(s => [s.key, stats[t][s.key].r]))]));
  const table = powerRankings(ranks, config);
  const modelRank = Object.fromEntries(table.map(r => [r.team, r.modelRank]));

  // 6. Games and lines (FBS vs FBS only)
  let games = [], gamesSource = "none";
  if (oddsKey) {
    const { from, until } = weekWindow(now);
    const unmatched = new Set();
    games = parseOdds(await get(oddsUrl(oddsKey, config.oddsSport), "json"), { bookmaker: config.oddsBookmaker, from, until, resolve: resolveName, unmatched });
    gamesSource = `The Odds API (${games[0]?.book ?? "no games"})`;
    if (unmatched.size) log(`note games skipped, teams not in the FBS list: ${[...unmatched].join(", ")}`);
  }
  log(`ok  ${games.length} games from ${gamesSource}`);

  // 7. Conference standings and conference-winner odds (optional)
  let standings = [], confOdds = {};
  try {
    standings = parseCollegeStandings(await get(standingsUrl(season, league, ""), "json"), byEspnId);
    log(`ok  ESPN standings (${standings.length} teams)`);
  } catch (e) { log(`warn standings: ${e.message}`); }
  try {
    confOdds = parseDivisionOdds(await get(futuresUrl(season, league), "json"), byEspnId,
      item => /conference/i.test(item.name || "") && !/championship game|playoff/i.test(item.name || ""));
    log(`ok  conference odds (${Object.keys(confOdds).length} teams)`);
  } catch (e) { log(`warn conference odds: ${e.message}`); }

  const teamOut = name => ({
    name, modelRank: modelRank[name], record: info[name].record, qb: info[name].qb,
    qbr: stats[name].qbr.assumed ? null : stats[name].qbr.r, qbrAssumed: !!stats[name].qbr.assumed,
    offYppRank: stats[name].yardsPerPlay.r, defYppRank: stats[name].oppYardsPerPlay.r, sosRank: stats[name].sos.r,
  });

  return {
    sport: "cfb",
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
