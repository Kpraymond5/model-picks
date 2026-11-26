// College basketball team stats built from ESPN box scores (replaces the TeamRankings pages in "Coll Bball").
// Completed games are read once and cached; later runs only fetch new games.

const SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball";
const n = v => { const x = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(x) ? x : 0; };
const pair = v => { const [a, b] = String(v ?? "").split("-"); return [n(a), n(b)]; };
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");

function line(summary, teamId) {
  const box = summary.boxscore?.teams?.find(t => String(t.team.id) === teamId);
  const stat = name => box?.statistics?.find(s => s.name === name)?.displayValue;
  const [fgm, fga] = pair(stat("fieldGoalsMade-fieldGoalsAttempted"));
  const [tpm, tpa] = pair(stat("threePointFieldGoalsMade-threePointFieldGoalsAttempted"));
  const [ftm, fta] = pair(stat("freeThrowsMade-freeThrowsAttempted"));
  const tov = n(stat("totalTurnovers") ?? stat("turnovers"));
  const oreb = n(stat("offensiveRebounds"));
  return { fgm, fga, tpm, tpa, ftm, fta, reb: n(stat("totalRebounds")), oreb, tov,
           poss: fga - oreb + tov + 0.475 * fta, ok: fga > 0 };
}

// All completed Division I games from `start` (Date) through yesterday.
export async function loadHoopsGames({ league, start, end = new Date(), groups = 50, get, cache = {}, log = console.log, concurrency = 6 }) {
  const events = [];
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const sb = await get(`${SITE}/${league}/scoreboard?dates=${ymd(d)}&groups=${groups}&limit=500`, "json");
    for (const e of sb.events || []) {
      const c = e.competitions?.[0];
      if (!e.status?.type?.completed || !c) continue;
      events.push({ id: String(e.id), date: e.date, comps: c.competitors.map(x => ({ id: String(x.team.id), pts: n(x.score) })) });
    }
  }
  const todo = events.filter(e => !cache[e.id]);
  log(`ok  ${league}: ${events.length} completed games, ${todo.length} new box scores to read`);
  for (let i = 0; i < todo.length; i += concurrency) {
    await Promise.all(todo.slice(i, i + concurrency).map(async e => {
      const s = await get(`${SITE}/${league}/summary?event=${e.id}`, "json");
      const [a, b] = e.comps;
      const la = line(s, a.id), lb = line(s, b.id);
      if (!la.ok || !lb.ok) { cache[e.id] = { id: e.id, skip: true }; return; } // no box score
      cache[e.id] = { id: e.id, date: e.date, teams: {
        [a.id]: { pts: a.pts, opp: b.id, ...la },
        [b.id]: { pts: b.pts, opp: a.id, ...lb },
      } };
    }));
  }
  return events.map(e => cache[e.id]).filter(g => g && !g.skip);
}

const pct = x => x == null ? null : (x * 100).toFixed(1) + "%";
const d1 = x => x == null ? null : x.toFixed(1);
const d2 = x => x == null ? null : x.toFixed(2);
const sgn = x => x == null ? null : (x > 0 ? "+" : "") + x.toFixed(1);
const div = (a, b) => b ? a / b : null;

// [key, value(totals), higherIsBetter, format]
const STATS = [
  ["ppg",       t => div(t.pts, t.g),                 true,  d1],
  ["oppPpg",    t => div(t.o.pts, t.g),               false, d1],
  ["offEff",    t => div(t.pts, t.poss),              true,  d2],
  ["defEff",    t => div(t.o.pts, t.o.poss),          false, d2],
  ["ftPct",     t => div(t.ftm, t.fta),               true,  pct],
  ["threePct",  t => div(t.tpm, t.tpa),               true,  pct],
  ["rebPct",    t => div(t.reb, t.reb + t.o.reb),     true,  pct],
  ["tovPct",    t => div(t.tov, t.poss),              false, pct],
  ["forcedTov", t => div(t.o.tov, t.o.poss),          true,  pct],
  ["possPg",    t => div(t.poss, t.g),                true,  d1],
  ["margin",    t => div(t.pts - t.o.pts, t.g),       true,  sgn],
  ["fgPct",     t => div(t.fgm, t.fga),               true,  pct],
  ["oppFgPct",  t => div(t.o.fgm, t.o.fga),           false, pct],
  ["oppThreePct", t => div(t.o.tpm, t.o.tpa),         false, pct],
  ["sos",       t => t.sos,                           true,  d1],
];
const FIELDS = ["pts", "fgm", "fga", "tpm", "tpa", "ftm", "fta", "reb", "oreb", "tov", "poss"];

// Per-team stats for the given ids -> { stats: {id: {key: {r, v, x}}}, record: {id: "W-L"} }
// x is the raw number (the model uses raw FT% and 3P%). SoS here is a Simple Rating System
// fallback; build-cbb.js replaces it with ESPN BPI's SOS rank when available.
export function hoopsTeamStats(games, teamIds, { outsideRating = -15 } = {}) {
  const ids = new Set(teamIds);
  const blank = () => Object.fromEntries(FIELDS.map(f => [f, 0]));
  const tot = {}, rec = {};
  for (const id of ids) { tot[id] = { g: 0, ...blank(), o: blank(), opps: [], margins: [] }; rec[id] = { w: 0, l: 0 }; }
  for (const game of games) for (const [id, l] of Object.entries(game.teams)) {
    if (!ids.has(id)) continue;
    const o = game.teams[l.opp], t = tot[id];
    t.g++;
    for (const f of FIELDS) { t[f] += l[f] || 0; t.o[f] += o[f] || 0; }
    t.opps.push(l.opp); t.margins.push(l.pts - o.pts);
    if (l.pts > o.pts) rec[id].w++; else rec[id].l++;
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
  for (const id of ids) tot[id].sos = tot[id].opps.length ? avg(tot[id].opps.map(rate)) : null;

  const out = Object.fromEntries([...ids].map(id => [id, {}]));
  for (const [key, val, higher, fmt] of STATS) {
    const vals = Object.fromEntries([...ids].map(id => [id, tot[id].g ? val(tot[id]) : null]));
    for (const id of ids) {
      const v = vals[id];
      const r = v == null ? null : 1 + [...ids].filter(o => vals[o] != null && (higher ? vals[o] > v + 1e-12 : vals[o] < v - 1e-12)).length;
      out[id][key] = { r, v: fmt(v), x: v };
    }
  }
  const record = Object.fromEntries([...ids].map(id => [id, `${rec[id].w}-${rec[id].l}`]));
  return { stats: out, record };
}
