# Tracked development tasks

Prepared implementation briefs can be copied freely or saved as private development tasks from the brief card. `/analytics/experiments` lists the current browser/account owner's tasks. This does not execute code, call an AI provider, spend credits, enable collection, or require sign-in. A non-AI save can create the existing signed pending guest identity. Creating a new account can adopt that guest owner ID; signing into an existing account uses its own owner and does not merge guest tasks. Clearing the guest cookie loses browser access to guest tasks.

Tasks retain immutable brief/evidence snapshots, a title, optional target universe ID and project association, intended metric, status and user-entered UTC release date. Existing project game plans, roadmap and to-do storage remain separate. Optional project links use an owner-matched foreign key. Metadata edits require the last-read revision. Each owner can keep 100 tasks including archived ones.

`analytics_experiments` is created by migration `026_analytics_experiments.sql`. Owner writes take the shared owner advisory lock and the existing account-closure trigger rejects closed owners and transfers. API identity comes from the signed account or guest session; payloads cannot select an owner. Optional project associations must reference an active owned project. Account closure/export must include this table; project deletion cascades associated tasks.

Supporting evidence records bounded source labels, public URLs, game IDs, player observations, retrieval dates, provenance and caveat codes. Recommendation cards bind their existing chart/search snapshots into the brief. Submitted snapshots are user-controlled reference material, not newly verified measurements. `prepared_brief_snapshot` and `client_supplied_snapshot` retain this distinction structurally.

## Descriptive before/after results

The initial measured metric is public concurrent players from stored `history_observations`; retention/revenue intentions remain explicitly unavailable. No private metric is inferred. A release date anchors midnight UTC. The before window is the preceding seven days; the after window is the following seven days, with exclusive ends. Corresponding five-minute slots are seven days apart, so weekdays and UTC times match. Actual release time is unknown.

Only valid, recorded observations within each slot are accepted. Absent runs, unavailable targets and games outside the collection sample remain explicit gaps, never zeros. The full after window must have elapsed, and at least 80% of the 2,016 corresponding slots must be observed in both windows. Means and absolute/percentage differences use only those paired slots. A zero baseline produces an undefined percentage, not infinity. Sparse windows return `insufficient`; future/incomplete windows return `awaiting_window`; missing game/date or unsupported metrics return `unavailable`. Result payloads retain both windows, all paired slots/gaps, coverage threshold, latest known observation, 30-minute freshness bound and `causal: false` semantics. Results are computed from existing history on explicit request, not persisted or backfilled.

These are descriptive public sample changes; releases do not establish causation or market fit. `semantics.caveats` retains sampling, release-time, missing-data and private-metric limits. The UI uses concise labels.

## APIs

`GET/POST /api/experiments`, `GET/PUT /api/experiments/:id`, and `GET /api/experiments/:id/results` are private and uncached. JSON mutations have a 96 KiB limit and reject cross-site/mismatched-origin requests. Guest identity creation happens only for a valid create request. GET requests never create identity or trigger verification.

Shared server APIs are `createExperiment`, `listExperiments`, `readExperiment`, `updateExperiment`, `deleteExperiment`, and `readExperimentResult`. Deleting via `DELETE /api/experiments/:id` also requires the current revision and the same owner lock. Pure `summarizeExperimentObservations` supports deterministic checks. The reusable UI is `TrackExperiment` and `ExperimentsPanel`; `ImplementationBriefCard` accepts `trackable={false}` when viewing an already saved task.

The conservative pairing policy excludes delayed retrievals outside their run's `[slot, slot + 5 minutes)` interval, rather than shifting them into a neighboring slot. Historical windows retain these exclusions as gaps. Evidence remains a client-supplied saved snapshot even when it originally came from a public recommendation.
