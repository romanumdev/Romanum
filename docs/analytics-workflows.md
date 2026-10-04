# Analytics workflows

The owner authorized these three additions on 4 October 2026. They extend recorded public history, the existing five-minute collector and private account/guest storage. This candidate is held locally for review; it does not change production configuration, billing, providers or access to private game metrics.

- [Comparisons](history-comparisons.md): actual concurrent-player observations in matched collection slots, raw counts and indexed change, and peers suggested from recorded genre and size evidence. Public pages and read-only AI/MCP tools share the same service.
- [Watches](watchlists.md): private saved games, optional peers and configurable change rules. The existing collector evaluates fresh matched windows and saves deduplicated in-app alerts. Missing data does not become zero activity.
- [Experiments](experiments.md): recommendation briefs and evidence become private development tasks with an intended metric, status and user-entered UTC release date. Later public player results compare matching before/after windows descriptively; private retention and revenue are not inferred from public activity.

Migrations `025_analytics_watchlists.sql` and `026_analytics_experiments.sql` are additive and have not been applied to production. Account exports explicitly include the new private records; account closure deletes them and existing closure guards prevent stale writes. Public history remains independent of these private records.

Recorded chart positions can be reported where they exist. Historical update events, unrecorded discovery exposure, revenue and causal effects must remain unavailable rather than be reconstructed. A coding brief is copied by the user; Romanum does not execute a coding agent, change a game or publish it.

The three slices are implemented locally. Focused checks cover the real isolated migration schema, peer SQL, rule episodes and collection capacity, private task revisions/results, MCP contracts, account exports and closure. Type checking, full lint and the production build pass. The 998-case regression run initially found two affected view-loader fixtures and eight legacy model-fixture assumptions; all ten are resolved by a 43-case focused rerun. Eight existing tests were skipped. No routing, billing or provider code changed to resolve those fixtures.

Desktop and phone checks use recorded-history fixtures, intercepted private writes and a local server without real credentials or a database connection. These demonstrate UI behavior, not live owner data, successful paid inference or actual Studio integration. The candidate handoff records the exact commit, test logs and browser evidence.
