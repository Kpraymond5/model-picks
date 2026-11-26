// Builds the college basketball output, ported from the "Coll Bball" sheet
// ("Power Rankings" for model rank, "Results 1" for the line and pick). Stats come from ESPN box scores.
import { parseOdds, oddsUrl, slugify, parseFpi, bpiUrl,
         standingsUrl, parseCollegeStandings, espnTeamsUrl, parseEspnTeams } from "./sources.js";
import { loadHoopsGames, hoopsTeamStats } from "./espn-hoops.js";

const BB = "https://site.api.espn.com/apis/site/v2/sports/basketball";
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

// Season label: the 2026-27 season is "2027" at ESPN.
export const hoopsSeason = (now = new Date()) => now.getUTCMonth() >= 6 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();

// statsFrom: first day of games to read (defaults to the season start; tests pass a later date).
export async function buildCbb({ config, get, oddsKey = null, gameCache = {}, now = new Date(), log = console.log, statsFrom = null }) {
  const season = hoopsSeason(now);
  const league = config.espnLeague;

  // 1. Division I teams and conferences from ESPN standings; names from the teams list
  const espnTeams = parseEspnTeams(await get(`${BB}/${league}/teams?limit=1000`, "json"));
  const nameById = Object.fromEntries(espnTeams.map(e => [e.id, e.short || e.name]));
  const standings = parseCollegeStandings(await get(`https://site.api.espn.com/apis/v2/sports/basketball/${league}/standings?season=${season}`, "json"), nameById);
  const byEspnId = Object.fromEntries(standings.map(s => [s.espnId, s.team]));
  const teams = standings.map(s => s.team);
  const idOf = Object.fromEntries(standings.map(s => [s.team, s.espnId]));
  const N = teams.length;
  if (N < 300) throw new Error(`ESPN standings returned only ${N} teams`);
  log(`ok  ESPN D1 teams (${N})`);

  const ourBySlug = {};
  for (const e of espnTeams) if (byEspnId[e.id]) { ourBySlug[e.slug] = byEspnId[e.id]; ourBySlug[slugify(e.name)] = byEspnId[e.id]; }
  const resolveName = name => ourBySlug[slugify(name)] || ourBySlug[config.teamAliases?.[slugify(name)]];

  // 2. Team stats from box scores (season starts Nov 1 of the previous calendar year)
  const yesterday = new Date(now.getTime() - 24 * 3600e3);
  const played = await loadHoopsGames({ league, start: statsFrom || new Date(Date.UTC(season - 1, 10, 1)), end: yesterday, get, cache: gameCache, log });
  const ts = hoopsTeamStats(played, teams.map(t => idOf[t]));
  const stats = Object.fromEntries(teams.map(t => [t, ts.stats[idOf[t]]]));
  const record = Object.fromEntries(teams.map(t => [t, ts.record[idOf[t]]]));
  log(`ok  team stats from ${played.length} games`);

  // 3. Strength of schedule from ESPN BPI (past SOS rank and remaining SOS rank)
  const remSos = {};
  try {
    const bpi = parseFpi(await get(bpiUrl(season), "json"), t => byEspnId[String(t?.id)]);
    let n = 0;
    for (const t of teams) {
      if (bpi[t]?.sos) { stats[t].sos = { r: bpi[t].sos, v: null, x: null }; n++; }
      remSos[t] = bpi[t]?.remSos ?? null;
      stats[t].remSos = { r: remSos[t], v: null };
    }
    log(`ok  ESPN BPI strength of schedule (${n} of ${N} teams)`);
  } catch (e) { log(`warn BPI: ${e.message} (using box-score SoS)`); }

  // 4. Model. Rank stats count by rank; FT% and 3P% count by value as (1 - pct) * 100, like the sheet.
  const term = (t, s) => {
    const st = stats[t][s.key];
    if (s.useValue) return st?.x == null ? 50 : (1 - st.x) * 100;
    return st?.r ?? (s.key === "sos" ? config.sosMissingRank : N);
  };
  const scored = teams.map(t => ({ team: t, score: config.stats.reduce((sum, s) => sum + term(t, s) * s.w1 * s.w2, 0) }));
  for (const r of scored) r.modelRank = 1 + scored.filter(o => o.score < r.score - 1e-9).length;
  scored.sort((a, b) => a.score - b.score);
  const modelRank = Object.fromEntries(scored.map(r => [r.team, r.modelRank]));

  // Line ("Results 1"): sum over stats of (home - away) term * weights, plus home field.
  // For the value stats the sheet uses (away% - home%) * 100, which is the same as (home term - away term).
  const lineFor = (home, away) => config.homeField + config.stats.reduce((sum, s) => sum + (term(home, s) - term(away, s)) * s.w1 * s.w2, 0);

  // 5. Today's and tomorrow's games with lines
  let games = [], gamesSource = "none";
  if (oddsKey) {
    const from = new Date(now.getTime() - 6 * 3600e3), until = new Date(now.getTime() + config.gamesWindowHours * 3600e3);
    const unmatched = new Set();
    games = parseOdds(await get(oddsUrl(oddsKey, config.oddsSport), "json"), { bookmaker: config.oddsBookmaker, from, until, resolve: resolveName, unmatched });
    gamesSource = `The Odds API (${games[0]?.book ?? "no games"})`;
    if (unmatched.size) log(`note games skipped, teams not matched: ${[...unmatched].slice(0, 20).join(", ")}${unmatched.size > 20 ? "…" : ""}`);
  }
  log(`ok  ${games.length} games from ${gamesSource}`);

  const teamOut = name => ({
    name, modelRank: modelRank[name], record: record[name], qb: null, qbr: null, qbrAssumed: false,
    offYppRank: stats[name].offEff.r, defYppRank: stats[name].defEff.r, sosRank: stats[name].sos.r,
    remSosRank: remSos[name] ?? null,
  });

  return {
    sport: "cbb",
    statsSource: "ESPN box scores",
    generatedAt: now.toISOString(),
    season,
    teamCount: N,
    hasQbr: false,
    offDefLabel: "eff",
    gamesSource,
    groupRecordLabel: "Conf W-L",
    divisionsTitle: "Division I",
    settings: { homeField: config.homeField, pickThreshold: config.pickThreshold },
    games: games.map(g => {
      const line = lineFor(g.home, g.away);
      const delta = g.homeSpread == null ? null : Math.abs(line - g.homeSpread);
      const pick = delta != null && delta > config.pickThreshold ? (line < g.homeSpread ? g.home : g.away) : null;
      return {
        kickoff: g.kickoff, total: g.total,
        away: { ...teamOut(g.away), spread: g.homeSpread == null ? null : -g.homeSpread, ml: g.awayMl },
        home: { ...teamOut(g.home), spread: g.homeSpread, ml: g.homeMl },
        line: round(line, 2), delta: delta == null ? null : round(delta, 2), pick,
      };
    }),
    powerRankings: scored.map(r => ({ ...teamOut(r.team), score: round(r.score, 3), stats: stats[r.team] })),
    divisions: [...new Set(standings.map(s => s.conference))].map(conf => ({
      name: conf, conference: "Division I",
      teams: standings.filter(s => s.conference === conf)
        .map(s => ({ ...teamOut(s.team), overall: s.overall, divRecord: s.confRecord, odds: null })),
    })),
  };
}
