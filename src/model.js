// The NFL v2 model, ported from the "Power Rankings" and "Week V" tabs.

// ranksByTeam: { "Buffalo": { yardsPerGame: 4, ..., qbr: 4 }, ... }
// score = sum over stats of (team's rank in that stat) * w1 * w2; lower is better.
// modelRank = position of the score among all teams, ties share a rank (like RANK(x, range, 1)).
export function powerRankings(ranksByTeam, config) {
  const rows = Object.entries(ranksByTeam).map(([team, ranks]) => {
    let score = 0;
    for (const s of config.stats) {
      const r = ranks[s.key];
      if (r == null) throw new Error(`${team} has no rank for ${s.key}`);
      score += r * s.w1 * s.w2;
    }
    return { team, score };
  });
  for (const row of rows) row.modelRank = 1 + rows.filter(o => o.score < row.score - 1e-9).length;
  return rows.sort((a, b) => a.score - b.score);
}

// Model line is the home team's spread: negative means the home team is favored.
// Week V: line = (home rank - away rank) * lineFactor + homeField
//         delta = |line - book home spread|; pick when delta clears the threshold.
// College variant: a bigger factor (lineFactorTop) when either team is ranked topN or better.
export function evaluateGame(homeRank, awayRank, homeSpread, config) {
  const top = config.lineFactorTop != null && Math.min(homeRank, awayRank) <= config.topN;
  const line = (homeRank - awayRank) * (top ? config.lineFactorTop : config.lineFactor) + config.homeField;
  if (homeSpread == null) return { line, delta: null, pick: null };
  const delta = Math.abs(line - homeSpread);
  let pick = null;
  if (delta > config.pickThreshold) pick = line < homeSpread ? "home" : "away";
  return { line, delta, pick };
}
