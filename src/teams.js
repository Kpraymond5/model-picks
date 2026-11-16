// One row per NFL team: TeamRankings name (the canonical name used everywhere),
// ESPN abbreviation, and the full name The Odds API uses.
export const NFL_TEAMS = [
  ["Arizona", "ARI", "Arizona Cardinals"],
  ["Atlanta", "ATL", "Atlanta Falcons"],
  ["Baltimore", "BAL", "Baltimore Ravens"],
  ["Buffalo", "BUF", "Buffalo Bills"],
  ["Carolina", "CAR", "Carolina Panthers"],
  ["Chicago", "CHI", "Chicago Bears"],
  ["Cincinnati", "CIN", "Cincinnati Bengals"],
  ["Cleveland", "CLE", "Cleveland Browns"],
  ["Dallas", "DAL", "Dallas Cowboys"],
  ["Denver", "DEN", "Denver Broncos"],
  ["Detroit", "DET", "Detroit Lions"],
  ["Green Bay", "GB", "Green Bay Packers"],
  ["Houston", "HOU", "Houston Texans"],
  ["Indianapolis", "IND", "Indianapolis Colts"],
  ["Jacksonville", "JAX", "Jacksonville Jaguars"],
  ["Kansas City", "KC", "Kansas City Chiefs"],
  ["Las Vegas", "LV", "Las Vegas Raiders"],
  ["LA Chargers", "LAC", "Los Angeles Chargers"],
  ["LA Rams", "LAR", "Los Angeles Rams"],
  ["Miami", "MIA", "Miami Dolphins"],
  ["Minnesota", "MIN", "Minnesota Vikings"],
  ["New England", "NE", "New England Patriots"],
  ["New Orleans", "NO", "New Orleans Saints"],
  ["NY Giants", "NYG", "New York Giants"],
  ["NY Jets", "NYJ", "New York Jets"],
  ["Philadelphia", "PHI", "Philadelphia Eagles"],
  ["Pittsburgh", "PIT", "Pittsburgh Steelers"],
  ["San Francisco", "SF", "San Francisco 49ers"],
  ["Seattle", "SEA", "Seattle Seahawks"],
  ["Tampa Bay", "TB", "Tampa Bay Buccaneers"],
  ["Tennessee", "TEN", "Tennessee Titans"],
  ["Washington", "WSH", "Washington Commanders"],
];

export const TEAM_NAMES = NFL_TEAMS.map(t => t[0]);
export const BY_ESPN = Object.fromEntries(NFL_TEAMS.map(t => [t[1], t[0]]));
export const BY_FULL = Object.fromEntries(NFL_TEAMS.map(t => [t[2], t[0]]));
BY_ESPN.WAS = "Washington"; // ESPN has used both
