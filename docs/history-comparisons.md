# Public recorded-history comparisons

`GET /api/history/compare?universeIds=123,456&days=7` compares persisted public concurrent-player observations for two to five distinct universe IDs. `days` defaults to 1 and accepts integers from 1 to 30. IDs must be positive safe integers. Unknown parameters, repeated parameters, duplicate IDs and malformed values return 400 before storage access. Clients cannot choose separate periods or a cutoff.

The endpoint is anonymous, free and read-only. It uses the existing `createHistoryService`, public history tables and collector cadence. It does not query current Roblox data, account sessions, linked-game metrics or paid providers, and does not collect, backfill or write anything. Responses use `Cache-Control: no-store`.

## Period and provenance

One server clock reading fixes `cutoff` for the entire request. Every game is read with exactly the same `from`, `to`, days and five-minute interval. `to` equals `cutoff`. Observations outside these bounds are excluded by the shared history service. The response identifies the public source (`https://games.roblox.com/v1/games`), Romanum storage and limitations.

The comparison retains the actual `history_runs.slot` from rows returned by the existing service's SELECTs, using a read adapter. It does not add SQL, change the history service or floor retrieval timestamps into guessed collection slots. A delayed fetch can cross a five-minute boundary, so using `observedAt` alone could incorrectly pair different runs. `slots[].slot` is the collection run; each observation retains its actual retrieval timestamp. Roblox's underlying measurement time is unavailable, and games in one run need not have identical retrieval times. If a retrieval timestamp identifies multiple run slots for one game, those observations are ambiguous and excluded.

The cutoff bounds observation timestamps; it is not an atomic database snapshot. Reads can see an in-flight collector finish during the request. They share one database handle but do not start a transaction or lock collection.

## Coverage fields

The response reports:

- `games[].recordedSpan`: first and last valid retrieval timestamps in the requested period, or null.
- `games[].recordedSlotSpan`: first and last valid collection slots, or null. A span does not imply continuous observations.
- `games[].coverage.validSamples`: valid observed slots, including an actual count of zero.
- `games[].coverage.returnedSlots` and `gaps`: the shared service's returned observation/gap points and the count that cannot provide a valid player sample.
- `gapCounts`: missed runs, unavailable/failed observations, games not sampled in a run, invalid counts and ambiguous observations.
- `requestedSlotsWithoutValidSample` and `validFractionOfRequestedSlots`: missing coverage across the complete requested period, including time before collection began.
- `coverage.requestedSlots`: five-minute slots touched by the requested period, including both partial boundaries (at most 8,641 for 30 days). The shared service can omit a current open slot without a run; the requested-period denominator still includes it.
- `coverage.allGamesPairedSlots`: slots with valid observations for every selected game, plus their requested-period fraction.
- `pairs[].coverage`: paired sample count, union of the two games' valid slots, paired/union overlap fraction, paired/requested fraction, each game's unpaired count and the actual paired slot span.

`slots` is a chronological matrix of valid recorded observations. Its observation lists contain only games actually observed in that slot; omitted games are missing, not zero. No fabricated values, interpolated points or extrapolation are returned. Raw gap counts are separate from requested-period missing coverage because the shared history service starts when Romanum recording began and returns no points for unknown games.

For five games, at most ten unordered pairs and 43,205 valid game observations can be returned. No response silently truncates the requested period.

## Comparison policy

Every pair independently uses the intersection of its actual observed collection slots. Unpaired observations contribute to coverage only. They never enter player-count statistics.

A pair needs at least **three paired slots** and an overlap fraction of at least **0.5**, where:

```text
overlapFraction = paired slots / union of both games' valid slots
```

No valid union yields null overlap, not a zero-valued player metric. These fixed thresholds are a descriptive evidence floor, not statistical significance. They do not require half the requested days to be recorded. A short history can qualify while covering a small fraction of the request; consumers must display the recorded/paired spans, actual sample count and requested-period coverage alongside its statistics. Three observations cannot establish a sustained trend.

For an eligible pair, `observedPlayerCounts` contains the mean player count of each game **on the same paired slots**, the mean/minimum/maximum left-minus-right difference, and first/last paired evidence with both retrieval timestamps. The description states the matching-slot sample count and observed concurrent-player difference. Endpoint growth and an index are described below; there is no retention estimate, causal verdict or pooled leaderboard. Values are sample means, not time-weighted estimates over missing intervals.

Inadequate pairs return `status: "insufficient_data"`, reason codes and `observedPlayerCounts: null` while retaining coverage. Reasons include too few paired slots, low overlap, or unavailable/unrecorded history. The overall result is `compared` when every pair qualifies, `partial` when some qualify, and `insufficient_data` when none qualify. Different pairs may cover different observed overlaps, explicitly reported per pair; their means must not be presented as a shared-period ranking.

For example, if A has eight valid slots and B is observed in only three of them, the overlap is 3/8 and statistics are withheld. A recorded zero in both games contributes a paired sample; a missing observation contributes no sample.

## Missing data and errors

No configured storage returns a 200 result with `available: false` and insufficient data. An unknown recorded game has `status: "not_recorded"`; an empty observed period has null spans and no comparable statistics. Storage failures return 503 with a generic retry message. Invalid requests return a generic 400 message. Neither error exposes SQL, exception text, database addresses or credentials.

Chart collection is a changing sample of selected public games, not all Roblox activity. Public concurrent players are not daily active users, unique players, session length, revenue or retention. Observed differences cannot establish why a game changed or sustained market growth. Other traffic, updates, featuring and sampling gaps remain possible influences; this endpoint does not infer them.

## Verification

```sh
node --test tests/history-comparison.test.mjs tests/history-comparison-http.test.mjs tests/history.test.mjs
npm run lint
npx --no-install next typegen
npx tsc --noEmit
npm run build
```

The new fixtures execute the actual history service and HTTP route over read-only SELECT adapters. They cover real zeros versus missing data, nonoverlap, failed and missed slots, unequal coverage, threshold boundaries, delayed retrievals and ambiguous timestamps, invalid counts, one fixed cutoff, two-to-five-game and one-to-thirty-day bounds, the complete 8,641-slot/43,205-observation bound, unknown storage/games, partial comparisons and sanitized errors. No live database, collector, private credentials or paid call is required. A fresh checkout needs Next.js route type generation before type checking. The existing layout's production build also needs its public Geist font download or an isolated cached-font verification setup.


## Public comparison workspace and tools

`/analytics/compare?universeIds=123,456&days=7` pre-fills the public comparison form. `CompetitorComparison` accepts `initialUniverseIds?: number[]` and `initialDays?: number`. The user explicitly submits comparison or peer discovery. The chart can switch between raw concurrent players and indexed CCU. It fills every requested collection slot with actual evidence or null and never connects gaps. Coverage, paired spans, retrieval timestamps, evidence reasons and actual non-sponsored chart positions remain visible.

`pairs[].growth` uses first and last matching pair observations after the existing pair floor passes. `sameWindow` uses only slots observed for every selected game and requires every pair to pass plus three common slots. It reports its own span and sample count; its series are suitable for a shared chart. Each growth has first/last evidence, absoluteChange, percentChange, indexStatus and a series with raw CCU and index. Index 100 is the first matching observation, not the requested-window boundary. If that observation is zero, percentage and every index value are null with `zero_baseline`; absolute changes remain available. Endpoints describe observed change only, never a sustained trend.

`slots[].observations[].chartRanks` preserves actual chart placements from the history service. Missing ranks do not imply chart exit. `annotations.updates` is `not_recorded`: no update timeline, causal explanation, revenue or interpolated observations are manufactured.

`GET /api/history/peers?universeId=123&days=7` is anonymous, read only and no-store. It accepts one positive safe universe ID and 1-30 days (default 1), rejects repeated/unknown parameters, and sanitizes storage failures. The latest recorded chart run containing the requested game supplies the candidate set. Only non-sponsored entries with retrieval times in the requested period are eligible. Candidates are deduplicated, prefer matching recorded genre, then minimize absolute log2 distance in (CCU + 1), with deterministic ID tie-breaking; at most four are returned. The +1 makes recorded zeros well-defined. A distance of at most one labels a similar-size suggestion. Every candidate labels genre/size fallback and preserves chart-specific retrieval timestamps and placement evidence. The source is the recorded chart CCU sample, not a current provider lookup or the game-stat series; peers still need comparison coverage checks. Missing storage or an absent chart anchor returns no suggestions.

The existing `PUBLIC_TOOLS` registry exposes `compare_game_history` and `suggest_game_peers`, using these services and strict schemas. They add no paid provider calls. Existing model-credit and external-MCP policy remains unchanged.

Focused additions: `node --test tests/history-comparison.test.mjs tests/history-comparison-http.test.mjs tests/history-peers.test.mjs`. No comparison migration or live provider/database action is needed.
