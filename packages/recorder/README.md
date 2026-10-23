# @dexterm/recorder — history recorder (lane R-01)

The non-circular source of truth for the rug model, the eval harness, backtests and post-mortems
(`research/task-1287/AI-SUITE-DESIGN.md` §4). It records what the app already fetched, re-observes
tokens after they leave the screen, labels outcomes by code, and keeps the tables small.

## What it does

| job | how | requests |
|---|---|---|
| **observe** | listens to `Store.enrich()` / `Store.discover()` (`store.listener`, task-1329) and writes one `token_snapshots` row per mint when the normalised record changed materially against the last written row (`src/snapshot.ts` `MATERIAL`: price/mcap/liquidity ≥ 5 %, holders ≥ 10 %, volumes ≥ 20 %, trade counts ≥ 25 %, any identity/authority/source field), or a heartbeat row when the last stored row is older than 30 min, plus an hourly t0 anchor; `feed_members` gets entrants at once and a full list per feed every 10 min | none |
| **sweep** | re-observes mints that left the screen at the 1 h / 2 h / 6 h / 24 h / 72 h horizons (rule in `src/sweep.ts`): DexScreener `tokens/v1` batches of 30, issued with `withPriority('low')` inside the data layer's limiter and health gate, ≤ 6 calls per sweep, ≤ 1 sweep per minute, ≤ 1500 calls per day, skipped while the bucket is paused after a 429 | DexScreener `tokens/v1` |
| **ticks** (opt-in, task-1504) | `src/ticks.ts`: position-grade samples for autotrade. Focus = held > open > candidate > watch (one role per mint), at most 60 coins; held + open every 5 s, candidate + watch every 10 s; a call that goes out anyway is topped up with not-yet-due coins. Every sample is written (no change detection, no raw JSON) to `autotrade_ticks`; a mint with no pair in the answer gets a NULL-price row. Each priced sample folds into `autotrade_candles_1m` (sampled OHLC: high/low of the samples, not of every trade). Calls: DexScreener `tokens/v1` batches of 30 (never a per-coin keyless Jupiter call), `'normal'` priority when a held/open coin is in the call, else `'low'`, skipped while paused after a 429, ≤ 36,000 calls per UTC day (persisted in `recorder_meta`). Focus sources in the collector: the `watchlist` table, `paper_positions` with tokens, and `$DEXTERM_HOME/autotrade/focus.json` (`dexterm-autotrade-focus/1`, written by the autotrade runner / the app; ignored after 30 min without a rewrite, per-entry `until`) | DexScreener `tokens/v1` |
| **label** | `src/labels.ts` (port of the prototype `labels.mjs`, v0.2 rules in `labels.md` + BACKTEST.md §4): one `outcomes` row per (t0 anchor, horizon), code only, never a model | none |
| **prune** | raw JSON after 7 d (only watchlist / open-token rows ever have it), one live row per mint per minute after 24 h (t0 anchors and cited t1 rows kept), columns after 90 d (`retention.columnsDays`; sweep rows included), autotrade ticks after 14 d, sampled candles after 90 d; outcomes, verdicts and creators forever | none |
| **cap** (opt-in, task-1504) | `src/retention.ts`: once the DB's USED bytes (pages minus the freelist) reach 95 % of `cap.maxBytes`, first the `cap.reclaim` hook runs (the collector passes the data layer's `Cache.prune()`: cache entries a day past their TTL), then, only if still above 85 %, delete the oldest hour of history across `autotrade_ticks`, `autotrade_candles_1m`, `token_snapshots` (live and sweep rows) and `feed_members` (plus their `mints` summaries), one transaction per slice, until used ≤ 85 %. Rows newer than 1 h are never evicted; outcomes / verdicts / creators are never touched. Observation never pauses. SQLite reuses the freed pages, so the file stops growing near the high-water mark; a file already above the cap keeps its size until a `VACUUM` (collector stopped) | none |

t0 anchors: the first sighting of a mint and then at most one per hour. Every anchor gets five outcome
rows eventually (`unobserved` when the 2× window closed with nothing seen).

Tables live in the app's own SQLite file (`--db`, default `~/.local/share/dexterm/dexterm.db`), WAL mode,
next to the cache / watchlist / paper wallet: one `--db` controls everything and the MCP server, the
backtest harness and the eval can read the same file through `DEXTERM_DB_PATH`.

## What is kept, and for how long

| table | what | kept |
|---|---|---|
| `token_snapshots` | change-driven rows while listed + outcome sweep rows | 90 d (thinned to 1/min after 24 h; raw JSON 7 d) |
| `feed_members` | which feed listed a mint, at what rank | 90 d |
| `autotrade_ticks` | 5–10 s samples of focus coins (`--focus-ticks`) | 14 d |
| `autotrade_candles_1m` | 1m OHLC from those samples | 90 d |
| `outcomes`, `verdicts`, `creators` | labels, pack verdicts, coin creators | forever |

With a cap (`dexterm record run --retention-mb N`) the oldest rows of the first four go earlier, oldest first.
The collector's flags: `--retention-mb N` (cap, eviction instead of the old `--max-db-mb` pause),
`--retention-days D` (`columnsDays`), `--focus-ticks` (the tick lane on a 5 s loop). All off by default.

## Switch

On by default in live mode. Off with `dexterm --no-recorder` or `DEXTERM_RECORDER=0` (also `off`, `false`,
`no`). Never on in `--replay` / `--fixtures` (a replay must not write fixture-time rows into real history)
or with `--db :memory:`.

## CLI

```
dexterm recorder stats  [--db PATH]        rows, labels, bytes per snapshot, DB size
dexterm recorder label  [--db PATH]        label every due t0 anchor now
dexterm recorder prune  [--db PATH]        run retention now
dexterm recorder export [--db PATH] [--out FILE] [--since T] [--until T] [--labelled-only] [--limit N]
```

(`node packages/recorder/bin/dexterm-recorder.mjs …` is the same thing.)

## Export format (`dexterm-recorder-export/1`)

```jsonc
{
  "schema": "dexterm-recorder-export/1",
  "exported_at": "…", "labeler_version": "0.2.0", "data_tier": "keyless-proxy",
  "leakage_rule": "features are the t0 row only …",
  "horizons_sec": [3600, 7200, 21600, 86400, 259200],
  "counts": { "records": N, "with_any_outcome": M, "by_label": { "flat": …, "dead": … } },
  "records": [
    {
      "mint": "…", "t0": 1791…, "known_sec": 0,
      "feeds": ["jup:toptrending-1h", "ds:boosts-top"],       // feeds that listed the mint in the hour before t0
      "features": { "price_usd": …, "mcap": …, "liquidity_usd": …, "holder_count": …, "organic_score": …, "mint_auth_enabled": 0, "src_market": "dexscreener", … },
      "outcomes": {
        "3600":  { "label": "flat", "tier": "keyless-proxy", "t1": 1791…, "mcap_ratio": 1.02, "liq_ratio": 0.98, "price_ratio": 1.01, "max_mcap_ratio": 1.3, "positive": false },
        "7200":  { "label": "unobserved", "t1": null, … }
      }
    }
  ]
}
```

`features` are exactly the stored t0 columns (`src/snapshot.ts` `COLUMN_NAMES`); `positive` is
`rug ∪ dead` on keyless labels and `rug` alone once a label is chain-verified (R-02).

## Measuring

`python3 -I packages/recorder/tools/measure-live.py --seconds 360 [--no-recorder] -- --calm --verbose`
runs the real app in a pty and prints CPU, DB growth per 8 h day and the recorder stats;
`tools/measure-run.sh` is the task-1329 driver (seed → shift → measure on/off → full suite).

## Tests

`node --test --test-concurrency=1 packages/recorder/test/*.test.ts` — the labeler replays the
task-1287 prototype recording (`test/fixtures/proto-1287.json`, 178 tokens) and must reproduce every
v0.1 label; the recorder tests run over the data layer's offline fixtures with the network blocked.
