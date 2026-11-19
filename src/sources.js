// Parsers for each outside data source. Pure functions: text/JSON in, rows out.
import { BY_ESPN, BY_FULL } from "./teams.js";

const decode = s => s.replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').trim();

// Name -> URL-style key, e.g. "San José State Spartans" -> "san-jose-state-spartans"
export const slugify = s => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/&/g, "").replace(/[()'.]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// TeamRankings stat or ranking page -> [{rank, team, slug, record, value}]
// Uses the first table on the page; rank is TeamRankings' own (1 = best, ties share a rank).
// value is the current-season column as shown on the page (e.g. "6.7", "52.00%", "34:31").
export function parseTeamRankings(html) {
  const start = html.indexOf("<tbody");
  if (start < 0) throw new Error("TeamRankings page has no table");
  const body = html.slice(start, html.indexOf("</tbody>", start));
  const out = [];
  for (const row of body.split(/<tr[\s>]/).slice(1)) {
    const rank = row.match(/<td class="rank[^"]*"[^>]*>\s*(\d+)\s*<\/td>/);
    const cells = [...row.matchAll(/<td[^>]*data-sort="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g)];
    if (!rank || cells.length < 2) continue;
    const record = row.match(/<small>\s*\(([^)]*)\)\s*<\/small>/);
    const value = cells[2] ? decode(cells[2][2].replace(/<[^>]*>/g, "")) : null;
    const slug = cells[1][2].match(/\/team\/([^"/?#]+)/)?.[1] ?? null;
    out.push({ rank: Number(rank[1]), team: decode(cells[1][1]), slug, record: record ? record[1] : null, value });
  }
  return out;
}

// ESPN season QBR (qualified passers, sorted best first) -> [{rank, team, qb}]
export function qbrUrl(season, league = "nfl") {
  return `https://site.web.api.espn.com/apis/fitt/v3/sports/football/${league}/qbr` +
    `?region=us&lang=en&qbrType=seasons&seasonType=2&isqualified=true&sort=schedAdjQBR%3Adesc&limit=300&season=${season}`;
}
export function parseQbr(json, resolve = a => BY_ESPN[a.athlete?.teamShortName]) {
  const out = [], seen = new Set();
  (json.athletes || []).forEach((a, i) => {
    const team = resolve(a);
    if (!team || seen.has(team)) return; // a team's best-ranked passer only
    seen.add(team);
    out.push({ rank: i + 1, team, qb: a.athlete.shortName || a.athlete.displayName });
  });
  return out;
}

// ESPN standings -> [{team, espnId, conference, division, overall, divRecord, seed}]
export function standingsUrl(season, league = "nfl", extra = "&level=3") {
  return `https://site.api.espn.com/apis/v2/sports/football/${league}/standings?season=${season}${extra}`;
}
export function parseStandings(json) {
  const out = [];
  const walk = (g, conference) => {
    if (g.abbreviation === "AFC" || g.abbreviation === "NFC") conference = g.abbreviation;
    for (const e of g.standings?.entries || []) {
      const team = BY_ESPN[e.team?.abbreviation];
      if (!team) continue;
      const stat = name => e.stats?.find(s => s.name === name || s.type === name)?.displayValue ?? null;
      out.push({
        team, espnId: String(e.team.id), conference, division: g.name,
        overall: stat("overall"), divRecord: stat("vs. Div.") ?? stat("divisionRecord"),
        seed: Number(stat("playoffSeed")) || 99,
      });
    }
    for (const c of g.children || []) walk(c, conference);
  };
  walk(json, null);
  return out;
}

// ESPN college standings -> [{team, espnId, conference, overall, confRecord}], in ESPN's standings order.
// "conference" is the group that has teams (e.g. "SEC", or "Sun Belt - East" where a conference has divisions).
export function parseCollegeStandings(json, teamByEspnId) {
  const out = [];
  const walk = g => {
    for (const e of g.standings?.entries || []) {
      const team = teamByEspnId[String(e.team?.id)];
      if (!team) continue;
      const stat = name => e.stats?.find(s => s.name === name)?.displayValue ?? null;
      out.push({ team, espnId: String(e.team.id), conference: g.name, overall: stat("overall"), confRecord: stat("vs. Conf.") });
    }
    for (const c of g.children || []) walk(c);
  };
  walk(json);
  return out;
}

// ESPN teams list -> [{id, slug, name}]
export function espnTeamsUrl(league) {
  return `https://site.api.espn.com/apis/site/v2/sports/football/${league}/teams?limit=1000`;
}
export function parseEspnTeams(json) {
  return (json.sports?.[0]?.leagues?.[0]?.teams || []).map(({ team: t }) => ({ id: String(t.id), slug: t.slug, name: t.displayName }));
}

// ESPN futures (DraftKings) -> { team: "+750" } for division- (or conference-) winner markets
export function futuresUrl(season, league = "nfl") {
  return `https://sports.core.api.espn.com/v2/sports/football/leagues/${league}/seasons/${season}/futures?limit=200`;
}
export function parseDivisionOdds(json, teamByEspnId, isMarket = item => item.type === "winDivision") {
  const odds = {};
  for (const item of json.items || []) {
    if (!isMarket(item)) continue;
    for (const b of item.futures?.[0]?.books || []) {
      const id = b.team?.$ref?.match(/teams\/(\d+)/)?.[1];
      const team = teamByEspnId[id];
      if (team && b.value != null) odds[team] = String(b.value);
    }
  }
  return odds;
}

// The Odds API v4 events -> [{kickoff, away, home, homeSpread, total, awayMl, homeMl, book}]
export function oddsUrl(apiKey, sport = "americanfootball_nfl") {
  return `https://api.the-odds-api.com/v4/sports/${sport}/odds` +
    `?apiKey=${encodeURIComponent(apiKey)}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
}
// resolve: The Odds API team name -> our team name (or undefined to skip the game)
export function parseOdds(events, { bookmaker, from, until, resolve = name => BY_FULL[name], unmatched = null }) {
  const games = [];
  for (const ev of events) {
    const kickoff = new Date(ev.commence_time);
    if (kickoff < from || kickoff >= until) continue;
    const home = resolve(ev.home_team), away = resolve(ev.away_team);
    if (unmatched) { if (!home) unmatched.add(ev.home_team); if (!away) unmatched.add(ev.away_team); }
    if (!home || !away) continue;
    const books = ev.bookmakers || [];
    const book = books.find(b => b.key === bookmaker) || books[0];
    if (!book) continue;
    const market = k => book.markets.find(m => m.key === k)?.outcomes || [];
    const spread = market("spreads").find(o => o.name === ev.home_team);
    if (!spread) continue;
    const ml = name => market("h2h").find(o => o.name === name)?.price ?? null;
    const over = market("totals").find(o => o.name === "Over");
    games.push({
      kickoff: kickoff.toISOString(), away, home,
      homeSpread: spread.point, total: over?.point ?? null,
      awayMl: ml(ev.away_team), homeMl: ml(ev.home_team), book: book.title,
    });
  }
  return games.sort((a, b) => a.kickoff.localeCompare(b.kickoff));
}

// Current NFL week window: from a few hours ago (games in progress) to next Tuesday 12:00 UTC.
export function weekWindow(now = new Date()) {
  const from = new Date(now.getTime() - 6 * 3600e3);
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
  do until.setUTCDate(until.getUTCDate() + 1); while (until.getUTCDay() !== 2);
  return { from, until };
}

export function nflSeason(now = new Date()) {
  return now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}
