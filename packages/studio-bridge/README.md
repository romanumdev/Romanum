# Studio bridge foundation

The package now also supplies a [local read helper](HELPER.md) over the existing
stdio adapter: structured connection/status, explicit Studio selection,
correlated bounded inspections, cancellation and shutdown. Its runnable check
uses the authored fixture; real launch requires separate owner activation.

Local, mock-tested bridge scaffold. It connects to an injected **in-memory transport only in the supplied executable fixture**. It does not establish Roblox Studio access. No server, process launcher, listener, plugin, credential store or deployment is included.

From the repository root, using the already installed Node.js 24 runtime:

```powershell
node --test packages/studio-bridge/tests/*.test.mjs
node packages/studio-bridge/fixtures/demo.mjs
```

The demo explicitly chooses `studio-b`, discovers two allowed actions, and reads its mock state. Tests exercise approved writes only against fixture memory. Nothing opens, connects to or edits a game. The package has no runtime dependencies; Node 22.18+ supports its erasable TypeScript. With repository development dependencies available, run `npm --prefix packages/studio-bridge run typecheck` for type checking. Package tests are explicit and are not currently added to the root test command.

## Architecture and ownership

```text
trusted local owner / future authenticated controller
  ├── discovers sessions, selects one Studio, reviews exact write digest
  └── StudioBridge
        ├── bounded action records, local effect policy, correlation and deadlines
        └── injected BridgeTransport
              └── MockStudioTransport (the only supplied implementation)
```

`src/protocol.ts` defines typed JSON-RPC messages and the bridge's action contracts. `src/bridge.ts` performs lifecycle negotiation, capability/session discovery, proposal preparation and dispatch. `fixtures/mock-studio.ts` supplies a parsed-message channel with controllable dropped responses. [CONTRACT.md](CONTRACT.md) is the handoff for the agent job API owner.

The release already contains `src/lib/harness/studio.ts`, `src/lib/harness/types.ts` and the approval workflow in `src/lib/harness/runner.ts`. That connector supplies the existing Studio SDK/stdio path, static effect allowlist, schema validation and session pinning. This package is an isolated foundation for explicit message correlation and action lifecycle handling; it does not replace or register that connector. Its narrower two-tool policy is intentional. No app auth, model provider/router, database migration, public MCP transport, root scripts or production configuration changed.

## Policy and lifecycle

Only `get_studio_state` (read) and `multi_edit` (write) can become action capabilities. Local policy decides effects; remote `readOnlyHint` cannot approve writes or expose execution/generation/publishing. An unknown remote tool remains undispatched. Descriptors and output are untrusted data. Resource links in results are returned as data and never followed.

Initialize the MCP subset, discover available tools and Studios, explicitly select a Studio, then prepare an action. Every action binds its ID, exact input, local effect, descriptor version and selected Studio to a digest. Input and returned proposals are copied; later caller mutations cannot alter the stored action. A write needs a separate trusted `reviewAction(actionId, digest, true)` call. Model input, remote annotations, and an `execute()` option cannot grant confirmation.

The bridge refreshes tools and sessions before dispatch. Changes to the descriptor, Studio ID, place ID, display name, connection or selection invalidate the proposal. The full remote input schema is preserved for a trusted injected validator; the pinned `studio_id` is validated after injection and rejected in caller input. Fixture schemas and their narrow validator are examples, not verified live Roblox schemas.

Calls use generated connection-specific monotonically increasing IDs; callers cannot supply wire IDs. Duplicate/late/unknown response IDs are ignored. Action IDs are retained for the connection's lifetime and cannot be executed twice or concurrently. No automatic retries occur. Responses cannot revive terminal actions.

A single absolute deadline covers all discovery pages, session checking and action dispatch. The default is 5 seconds; per-operation values are limited to 1–30,000 ms. There are at most 16 concurrent requests, 10,000 requests per connection, 256 action records, three tool pages, 50 tools and 30 Studios. JSON is depth-limited; messages, inputs/outputs and schemas are capped at 128 KiB, 64 KiB and 32 KiB respectively. Reaching a lifetime limit requires a new explicitly selected connection; records are never evicted to permit replay.

Cancellation stops waiting and sends `notifications/cancelled` for the outstanding request. Initialization cancellation/timeout instead closes the channel. A dispatched write that times out, is cancelled, disconnects, or returns an error has `outcome: "unknown"` and action status `uncertain`. Cancellation is best effort and cannot guarantee rollback. Reconcile in Studio before preparing another write. Read errors and failures before dispatch have distinguishable outcomes.

## Still required for live access

These are future owner-mediated steps; none were performed by this change.

1. The owner installs or updates Roblox Studio from Roblox's official distribution and opens a place they are authorized to manage. The built-in MCP path needs no third-party Studio plugin. In Assistant, open **… → Manage MCP Servers** and enable **Enable Studio as MCP server**. [Official Roblox setup](https://create.roblox.com/docs/studio/mcp)
2. The owner chooses a trusted local MCP client using **Quick connect**, then verifies the green connection indicator in Studio. For Windows clients needing manual configuration, Roblox documents its installed `%LOCALAPPDATA%\Roblox\mcp.bat` wrapper; copy the configuration from the current official page. The scaffold launches neither that wrapper nor an arbitrary executable. [Connection configuration](https://create.roblox.com/docs/studio/mcp#connect-your-client)
3. Implement and review the local transport/SDK adapter. It must enforce framing/byte limits before parsing, nonblocking enqueue semantics, disconnect notification and bounded teardown. Use the official MCP client for protocol negotiation, framing and cancellation where possible. Avoid initializing an already initialized SDK client a second time; the mock currently owns its own minimal handshake. A hosted Romanum web process cannot reach a user's stdio session; a hosted connection/helper still needs a separately reviewed pairing and authorization design.
4. Supply real schema validation, matching the existing connector's `AjvJsonSchemaValidator` behavior. Inspect the installed Studio's `tools/list` and `list_roblox_studios` outputs, test any necessary normalization, and use actual schemas. This scaffold accepts session arrays directly or a `studios` container with `studio_id`/`id`, optional `name` and `place_id`/`placeId`; it never guesses a first session if a shape is unsupported.
5. Integrate the trusted owner/project/run controller separately. Keep selection and `reviewAction` out of model tools. Authenticate the reviewer, verify project ownership and allowed tools, display the exact target and proposed input, and bind the existing runner's approval to this bridge digest. Persist action claims/review/uncertain outcomes for restart safety before enabling real writes. This process-local scaffold supplies neither authentication nor durable replay protection across restarts.
6. With new explicit authorization, verify discovery and a read of an owner-selected test place first. Any live write requires a separately reviewed proposal and reconciliation procedure. Plugin installation, persistent services, network listeners, credentials, security settings and OS ACL changes are outside this implementation.

Studio IDs and place IDs are observations, not proof of ownership. A server that reuses an ID with identical metadata cannot be distinguished by this client alone. The check/dispatch interval is not an atomic server lease. Future adapters must invalidate connection identity after transport loss; stronger server session evidence needs an explicitly supported mechanism. No end-to-end Studio compatibility claim is made.

## Sources checked 2026-10-02

- Roblox documents built-in Studio MCP, local stdio and explicit Studio targeting: [Studio MCP](https://create.roblox.com/docs/studio/mcp).
- This fixture pins the supported MCP revision `2025-11-25`; it is not a claim about the latest installed Studio revision. Capabilities are negotiated before discovery: [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).
- Discovery and invocation use `tools/list` and `tools/call`. Remote annotations are hints, not permissions: [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
- Cancel only in-flight issued requests, ignore late responses, and never cancel initialize: [MCP cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation).
- The supplied [rblxdotsmcp reference](https://github.com/lachydotmcg/rblxdotsmcp) was publicly empty when inspected. No software or source was downloaded or installed from it.
