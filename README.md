# nhl-goal-bot

Posts NHL goals to Bluesky as they happen. Polls the public NHL API for live
games, verifies each goal, posts it, then watches for stat corrections.

## Setup

Requires Node 20+.

```bash
npm install
cp .env.example .env   # then fill in your Bluesky app password
```

Create a [Bluesky app password](https://bsky.app/settings/app-passwords) — never
use your main account password.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `BLUESKY_PASSWORD` | *(required)* | Bluesky app password |
| `BLUESKY_IDENTIFIER` | `nhl-goal-bot.bsky.social` | Bot handle |
| `POLL_INTERVAL_MS` | `45000` | How often to check for live games |
| `INITIAL_DELAY_MS` | `45000` | Wait before posting, to catch quick stat corrections |
| `POST_DELAY_MS` | `60000` | Cooldown after each post |
| `MAX_UPDATES` | `2` | Max correction posts per goal |
| `SCORE_MAX_AGE_MS` | `14400000` (4h) | How long goal records are kept |
| `GOAL_STORE_PATH` | `./data/posted-goals.json` | Persistent goal record file |
| `NHL_API_BASE_URL` | `https://api-web.nhle.com/v1` | NHL API endpoint |
| `PORT` | `10000` | Health-check HTTP port |

## Run

```bash
npm start   # node index.mjs
npm test    # node --test test/
```

A `GET /` health endpoint responds `NHL Goal Bot is running!` (useful for
Render/Railway/Fly health checks).

## How it works

- `src/nhl.mjs` — thin client for the NHL web API
- `src/goals.mjs` — goal parsing, dedup identity, message formatting (pure, tested)
- `src/store.mjs` — JSON-backed record of seen goals; restarts don't repost
- `src/bluesky.mjs` — single post path with session re-login retry
- `src/time.mjs` — Eastern Time day boundaries via `Intl` (DST-safe)
- `src/config.mjs` — validated env config

Goals are keyed by NHL event id, with a fuzzy fallback (period + minute +
scorer + score) for when the league re-issues an event id after a correction.

## License

MIT
