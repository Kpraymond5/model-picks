# Model Picks

The NFL v2 model without Google Sheets. A GitHub Action collects team stats and
betting lines every 6 hours, runs the model, and publishes the picks page on GitHub Pages.

## How it works

| Step | Where | What |
|---|---|---|
| Stats | `src/run-nfl.js` | 24 TeamRankings.com pages (yards per play, third down %, SoS, ...) and ESPN season QBR. Each gives every team a rank from 1 to 32. |
| Power score | `src/model.js` | Sum of (rank × w1 × w2) over the 25 stats. Lowest score is model rank 1. |
| Model line | `src/model.js` | (home rank − away rank) × 0.42 − 3.25, as the home team's spread. |
| Pick | `src/model.js` | When the model line is more than 2.8 points from the book's spread, take the side the model likes. |
| Lines | The Odds API | Spread, total and money line for this week's games (DraftKings when available). |
| Page | `site/index.html` | Reads `site/data/nfl.json`, written by the job. |

All weights and settings live in `config/nfl.json` (the same numbers as rows 4 and 5 of the
Power Rankings tab, plus the 0.42, −3.25 and 2.8 from Week V). Change them there.

`qbrMissingRank` (25) is the QBR rank given to a team with no qualified passer on ESPN's list.
That matches what the sheet produces today for Arizona and Las Vegas.

## Setup

1. Create a new repository on GitHub (for example `model-picks`).
2. Upload everything in this folder, keeping the folders (`.github`, `config`, `data`, `site`, `src`).
   On the repository page: **Add file → Upload files**, drag the folder contents in, commit.
3. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
4. Get a free key at the-odds-api.com, then **Settings → Secrets and variables → Actions →
   New repository secret**, name `ODDS_API_KEY`.
   Without a key, the job reads games from `data/nfl-games.json` instead
   (copy `data/nfl-games.example.json` to start).
5. **Actions → Update picks → Run workflow.** When it finishes, the page is at
   `https://<your-username>.github.io/<repository>/`.

The free Odds API tier (500 requests a month) covers a run every 6 hours.

## Adding a sport

Add `config/<sport>.json` with its stat pages and weights, a team list in `src/teams.js`,
and a `src/run-<sport>.js` step in the workflow. The model functions are shared.
