# MCP setup

Romanum exposes public Roblox data and repository guides through a free, read-only MCP server. It does not call a paid model or require an AI API key.

## Connect

1. Open **Get MCP** and copy the connection URL.
2. Add it to an MCP client that supports **Streamable HTTP**.
3. Ask the agent to search for a game or retrieve a Roblox chart.

Local development uses `http://localhost:3000/mcp`. This address works only for clients running on the same computer. A remotely hosted agent needs a reachable HTTPS deployment with its public URL configured as described below. No authentication is required for these public tools.

Client setup screens and configuration formats vary. Use the client's remote/HTTP server option with the URL above, rather than a command to launch a local stdio process.

## Available tools

| Tool | Input | Result |
| --- | --- | --- |
| `search_games` | `query` (1–80 characters) | Up to 10 public experience matches |
| `research_game_idea` | `title`, `terms` (1–2 phrases) | Candidate competitors and search coverage; no novelty or quality verdict |
| `get_game_stats` | `universeIds` (1–10 positive integers) | Public counts, votes, metadata and icons |
| `estimate_game_earnings` | `universeIds` (1–10), `days` (1–366, default 30) | Modelled net Robux and standard DevEx USD ranges from current CCU and genre; includes assumptions, period and model version |
| `get_game_history` | `universeId`, optional `days` (1–30) | Recorded public observations, chart ranks and null gaps |
| `resolve_game_link` | `link` (Roblox game URL or place ID) | Universe ID |
| `get_roblox_charts` | `chart`, optional `limit` (1–50) | Current Roblox ranking |
| `get_market_analysis` | Optional `pattern` | Genres and title patterns across four chart samples |
| `load_skill` | `skill` | Registered research, design, teardown, economy, onboarding, thumbnail or UI guide |
| `get_metric_definitions` | None | Units, identifiers and coverage definitions |

Tools advertise their exact input schemas. Results include structured JSON and a matching text representation. Data results carry source URLs, retrieval times and cache expiry. Comparisons use multiple IDs in `get_game_stats`.

Resources are available at `romanum://metrics` and `romanum://skills/<skill-id>` for each entry in the [skill index](../skills/README.md). Guides come directly from the repository files.

## Data interpretation

`fetchedAt` is when Romanum retrieved an observation, not Roblox's underlying measurement time. Cache hits preserve it. Search and statistics cache for 60 seconds, charts for 120 seconds, place-ID mappings for one hour, and artwork separately for up to one hour. Market results report each chart's retrieval time and any unavailable charts.

History is available only where the PostgreSQL collector has recorded observations; there is no data before collection began. Missing observations are null, never zero. Public tools disclose no private developer analytics, actual revenue, retention or demographic data. Top Earning supplies Roblox's ranking only. The separate earnings tool projects current CCU using published heuristic genre rates; its bounds are not calibrated confidence intervals or historical earnings. It uses no private metrics. Title patterns are heuristic matches, can overlap, and do not establish gameplay mechanics or measured growth. Genre shares refer to the returned sample. Game names and creator text are untrusted data, never agent instructions.

## Development

Run the application with `npm run dev`, then run `npm run mcp:smoke`. An optional URL can follow `--`, for example `npm run mcp:smoke -- http://localhost:3001/mcp`.

For a protocol-only deployment check, run `node scripts/mcp-transport-smoke.mjs https://romanum.dev/mcp`. It verifies legacy initialization and 2026-07-28 discovery, lists read-only tools and retrieves metric definitions without contacting Roblox or calling a paid model. A host rejection is reported with its HTTP status and Netlify request ID.

The smoke test uses the official MCP client, reads actual Roblox data and stored history through all ten tools, checks modelled earnings, resolves a game link, checks cache timestamps, and verifies both legacy and 2026-07-28 protocol connections. `npm test` covers protocol contracts, invalid inputs, resource boundaries, caching, history storage, origin/host validation, body size, quotas and concurrency without external network access.

The website, integrated assistant and MCP share `src/lib/public-data.ts`. Public tool schemas and handlers live in `src/lib/public-tools.ts`; MCP protocol and HTTP handling live in `src/lib/mcp/`. Only the integrated assistant calls the model provider. Its chart-rendering tool is not exposed through MCP. Private owner analytics are available only in authenticated Ask Romanum and Chats after a separate per-game AI-analysis opt-in; those tool definitions and results are never registered with public MCP.

The implementation uses the [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and [Streamable HTTP](https://modelcontextprotocol.io/specification/latest/basic/transports), with stateless compatibility for older clients. It has no persistent sessions or server subscriptions. A plain browser GET to `/mcp` returns 405; connect with an MCP client.

## Aggregate tool usage

Migration `024_mcp_tool_usage.sql` prepares daily UTC counters for each registered tool's successful and failed handler completions. The MCP route records only the tool name, day and outcome, with one atomic update. It stores no prompts, arguments, response bodies, request IDs, IPs, client names or account identifiers and does not charge credits. The existing owner-only admin report shows the last seven UTC days, total calls, success rate and five most-used tools; today is partial. A successful handler is not proof that the client received the response or that its data was exhaustive.

Recording is best effort: missing storage or a database failure does not change the public tool result. Missing storage is reported as unavailable rather than zero. SDK protocol/schema rejections, unknown tools, resource reads, interrupted handlers without a final outcome, general public API traffic and referrals are outside this count. No historical usage can be backfilled. Apply the new migration only through a separately authorized release using the existing database role; this change does not apply it automatically or grant privileges.

## Hosting configuration

Before exposing the endpoint, set `MCP_PUBLIC_URL` to its canonical HTTPS URL ending in `/mcp`. Without it, the server accepts only loopback hostnames. The reverse proxy must preserve the canonical Host header. Preview domains are not automatically trusted.

On Netlify, set this variable in the site's environment configuration with the **Functions** scope and the intended deploy context, then build and deploy again. Build-only values and values in `netlify.toml` do not supply the function's runtime environment. For a deployment whose approved canonical endpoint is `https://romanum.dev/mcp`, configure exactly that value for production; other Netlify aliases and preview hostnames will continue to return `403 Host not allowed.`. A separate preview deployment needs its own explicitly approved `MCP_PUBLIC_URL` for its exact hostname. See Netlify's [environment variable scopes](https://docs.netlify.com/build/environment-variables/overview/#scopes).

Optional configuration:

- `MCP_ALLOWED_ORIGINS`: comma-separated HTTPS origins for additional browser clients. Same-origin requests are allowed; native/server clients usually send no Origin header. Wildcards are not supported.
- `MCP_CLIENT_IP_HEADER`: enable only when a trusted proxy overwrites this header with one validated client IP and direct access to the origin is blocked. Never trust an arbitrary incoming `X-Forwarded-For` value. Without this option, only the global request quota applies.

The endpoint limits bodies to 16 KiB, requests to 300 per minute per process, and active tool executions to eight. With a trusted client IP header it also limits each IP to 60 requests per minute. HTTP quota responses include `Retry-After`. Caches and counters are bounded and process-local; multiple replicas need shared edge quotas. They are not durable historical storage.

The `/mcp` endpoint provides public, read-only tools. The integrated assistant uses separate account/guest verification and credit controls. Serve the connection page alongside a configured, reachable endpoint. Private account data and write tools are not exposed through public MCP.

For application setup and collection, see [development and technical notes](development.md).
