// Team season stats built from ESPN box scores (replaces the TeamRankings pages).
// Each completed game is read once and kept in a cache, so later runs only fetch new games.

const SITE = "https://site.api.espn.com/apis/site/v2/sports/football";
const n = v => { const x = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(x) ? x : 0; };
const pair = (v, sep) => { const [a, b] = String(v ?? "").split(sep); return [n(a), n(b)]; };
const clock = v => { const [m, s] = String(v ?? "").split(":"); return n(m) * 60 + n(s); };

// One team's line from a game summary
function teamLine(summary, teamId) {
  const box = summary.boxscore?.teams?.find(t => String(t.team.id) === teamId);
  const stat = name => box?.statistics?.find(s => s.name === name)?.displayValue;
  const players = summary.boxscore?.players?.find(p => String(p.team.id) === teamId)?.statistics || [];
  const totals = (cat, key) => {
    const c = players.find(s => s.name === cat);
    const i = c?.keys?.indexOf(key) ?? -1;
    return i >= 0 ? c.totals?.[i] : null;
  };
  const [comp, passAtt] = pair(stat("completionAttempts"), "/");
  const [td3c, td3a] = pair(stat("thirdDownEff"), "-");
  const [pens, penYds] = pair(stat("totalPenaltiesYards"), "-");
  const [fgm, fga] = pair(totals("kicking", "fieldGoalsMade/fieldGoalAttempts"), "/");
  const rushAtt = n(stat("rushingAttempts"));
  const sacksTaken = stat("sacksYardsLost") != null ? pair(stat("sacksYardsLost"), "-")[0] : null; // NFL only
  const plays = stat("totalOffensivePlays") != null ? n(stat("totalOffensivePlays")) : rushAtt + passAtt;

  // Red zone from the drive log: a drive is a trip if it ran a play from inside the 20; it scores on a TD or FG.
  let rzTrips = 0, rzScores = 0;
  for (const d of summary.drives?.previous || []) {
    if (String(d.team?.id) !== teamId) continue;
    const inside = (d.plays || []).some(p => {
      const y = p.start?.yardsToEndzone;
      return y > 0 && y <= 20 && !/kickoff|extra point|two-point|timeout|end of|coin toss|penalty/i.test(p.type?.text || "");
    });
    if (!inside) continue;
    rzTrips++;
    if (/^(TD|FG)$/.test(d.result || "") || /touchdown|field goal/i.test(d.displayResult || "") && !/missed|interception|fumble|blocked/i.test(d.displayResult || "")) rzScores++;
  }

  return {
    yds: n(stat("totalYards")), plays, passYds: n(stat("netPassingYards")), passAtt, comp,
    rushYds: n(stat("rushingYards")), rushAtt, ints: n(stat("interceptions")), fumLost: n(stat("fumblesLost")),
    sacksTaken, sacksMade: n(totals("defensive", "sacks")), penYds, top: clock(stat("possessionTime")),
    td3c, td3a, rzTrips, rzScores, fgm, fga,
  };
}

// All completed regular-season games for a season: [{id, date, teams: {id: {pts, opp, ...line}}}]
export async function loadSeasonGames({ league, season, weeks, groups = null, get, cache = {}, log = console.log, concurrency = 6 }) {
  const events = [];
  for (let w = 1; w <= weeks; w++) {
    const url = `${SITE}/${league}/scoreboard?seasontype=2&week=${w}&dates=${season}&limit=400` + (groups ? `&groups=${groups}` : "");
    const sb = await get(url, "json");
    for (const e of sb.events || []) {
      const c = e.competitions?.[0];
      if (!e.status?.type?.completed || !c) continue;
      events.push({ id: String(e.id), date: e.date, comps: c.competitors.map(x => ({ id: String(x.team.id), pts: n(x.score) })) });
    }
  }
  const todo = events.filter(e => !cache[e.id]);
  log(`ok  ${league} ${season}: ${events.length} completed games, ${todo.length} new box scores to read`);
  for (let i = 0; i < todo.length; i += concurrency) {
    await Promise.all(todo.slice(i, i + concurrency).map(async e => {
      const s = await get(`${SITE}/${league}/summary?event=${e.id}`, "json");
      const [a, b] = e.comps;
      const la = teamLine(s, a.id), lb = teamLine(s, b.id);
      // College box scores have no "sacks taken": use the other side's defensive sacks.
      if (la.sacksTaken == null) la.sacksTaken = lb.sacksMade;
      if (lb.sacksTaken == null) lb.sacksTaken = la.sacksMade;
      cache[e.id] = { id: e.id, date: e.date, teams: {
        [a.id]: { pts: a.pts, opp: b.id, ...la },
        [b.id]: { pts: b.pts, opp: a.id, ...lb },
      } };
    }));
  }
  return events.map(e => cache[e.id]).filter(Boolean);
}

// Per-team season stats -> { [teamId]: { key: {r, v} } } plus records, for the given team ids.
// Each stat: [key, value(t), higherIsBetter, format]
const pct = x => x == null ? null : (x * 100).toFixed(1) + "%";
const d1 = x => x == null ? null : x.toFixed(1);
const d2 = x => x == null ? null : x.toFixed(2);
const mmss = x => x == null ? null : `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`;
const div = (a, b) => b ? a / b : null;

const STATS = [
  ["yardsPerGame",     t => div(t.yds, t.g),                  true,  d1],
  ["oppYardsPerGame",  t => div(t.o.yds, t.g),                false, d1],
  ["yardsPerPlay",     t => div(t.yds, t.plays),              true,  d1],
  ["oppYardsPerPlay",  t => div(t.o.yds, t.o.plays),          false, d1],
  ["yardsPerPoint",    t => div(t.yds, t.pts),                false, d1],
  ["oppYardsPerPoint", t => div(t.o.yds, t.o.pts),            true,  d1],
  ["thirdDown",        t => div(t.td3c, t.td3a),              true,  pct],
  ["redZone",          t => div(t.rzScores, t.rzTrips),       true,  pct],
  ["redZoneAtt",       t => div(t.rzTrips, t.g),              true,  d1],
  ["completion",       t => div(t.comp, t.passAtt),           true,  pct],
  ["intThrown",        t => div(t.ints, t.g),                 false, d2],
  ["fumblesLost",      t => div(t.fumLost, t.g),              false, d2],
  ["qbSacked",         t => div(t.sacksTaken, t.passAtt + t.sacksTaken), false, pct],
  ["oppThirdDown",     t => div(t.o.td3c, t.o.td3a),          false, pct],
  ["oppRedZone",       t => div(t.o.rzScores, t.o.rzTrips),   false, pct],
  ["oppRedZoneAtt",    t => div(t.o.rzTrips, t.g),            false, d1],
  ["oppCompletion",    t => div(t.o.comp, t.o.passAtt),       false, pct],
  ["interceptions",    t => div(t.o.ints, t.g),               true,  d2],
  ["oppFumblesLost",   t => div(t.o.fumLost, t.g),            true,  d2],
  ["sackPct",          t => div(t.o.sacksTaken, t.o.passAtt + t.o.sacksTaken), true, pct],
  ["penaltyYards",     t => div(t.penYds, t.g),               false, d1],
  ["oppPenaltyYards",  t => div(t.o.penYds, t.g),             true,  d1],
  ["fgPct",            t => div(t.fgm, t.fga),                true,  pct],
  ["passYds",          t => div(t.passYds, t.g),              true,  d1],
  ["passAtt",          t => div(t.passAtt, t.g),              true,  d1],
  ["rushYds",          t => div(t.rushYds, t.g),              true,  d1],
  ["rushAtt",          t => div(t.rushAtt, t.g),              true,  d1],
  ["oppPassYds",       t => div(t.o.passYds, t.g),            false, d1],
  ["oppPassAtt",       t => div(t.o.passAtt, t.g),            false, d1],
  ["oppRushYds",       t => div(t.o.rushYds, t.g),            false, d1],
  ["oppRushAtt",       t => div(t.o.rushAtt, t.g),            false, d1],
  ["plays",            t => div(t.plays, t.g),                true,  d1],
  ["oppPlays",         t => div(t.o.plays, t.g),              false, d1],
  ["timeOfPoss",       t => div(t.top, t.g),                  true,  mmss],
  ["sos",              t => t.sos,                            true,  x => x == null ? null : x.toFixed(1)],
];
const FIELDS = ["pts", "yds", "plays", "passYds", "passAtt", "comp", "rushYds", "rushAtt", "ints", "fumLost",
                "sacksTaken", "sacksMade", "penYds", "top", "td3c", "td3a", "rzTrips", "rzScores", "fgm", "fga"];

// Strength of schedule uses a Simple Rating System: rating = average margin + average opponent rating,
// solved by iteration. SoS = average opponent rating (higher = harder, rank 1 = hardest).
// Opponents outside the team list (FCS in college) get outsideRating.
export function teamStats(games, teamIds, { outsideRating = -20 } = {}) {
  const ids = new Set(teamIds);
  const tot = {}, rec = {};
  const blank = () => Object.fromEntries(FIELDS.map(f => [f, 0]));
  for (const id of ids) { tot[id] = { g: 0, ...blank(), o: blank(), opps: [] }; rec[id] = { w: 0, l: 0, t: 0 }; }
  for (const game of games) {
    for (const [id, line] of Object.entries(game.teams)) {
      if (!ids.has(id)) continue;
      const opp = game.teams[line.opp];
      const t = tot[id];
      t.g++;
      for (const f of FIELDS) { t[f] += line[f] || 0; t.o[f] += opp[f] || 0; }
      t.opps.push(line.opp);
      t.margins = t.margins || [];
      t.margins.push(line.pts - opp.pts);
      if (line.pts > opp.pts) rec[id].w++; else if (line.pts < opp.pts) rec[id].l++; else rec[id].t++;
    }
  }
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  let rating = Object.fromEntries([...ids].map(id => [id, 0]));
  const rate = o => rating[o] ?? outsideRating;
  for (let k = 0; k < 200; k++) {
    const next = {};
    for (const id of ids) next[id] = tot[id].g ? avg(tot[id].margins) + avg(tot[id].opps.map(rate)) : 0;
    const mean = avg(Object.values(next));
    for (const id of ids) next[id] -= mean;
    rating = next;
  }
  for (const id of ids) { const t = tot[id]; t.sos = t.opps.length ? avg(t.opps.map(rate)) : null; }

  const out = Object.fromEntries([...ids].map(id => [id, {}]));
  for (const [key, val, higher, fmt] of STATS) {
    const vals = Object.fromEntries([...ids].map(id => [id, tot[id].g ? val(tot[id]) : null]));
    for (const id of ids) {
      const v = vals[id];
      const r = v == null ? null : 1 + [...ids].filter(o => vals[o] != null && (higher ? vals[o] > v + 1e-12 : vals[o] < v - 1e-12)).length;
      out[id][key] = { r, v: fmt(v) };
    }
  }
  const record = Object.fromEntries([...ids].map(id => { const r = rec[id]; return [id, r.t ? `${r.w}-${r.l}-${r.t}` : `${r.w}-${r.l}`]; }));
  return { stats: out, record, games: Object.fromEntries([...ids].map(id => [id, tot[id].g])) };
}
