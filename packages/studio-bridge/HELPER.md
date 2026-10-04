# Local Studio read helper

`StudioReadHelper` and `scripts/studio-helper.mjs` turn the existing bridge and
reviewed stdio adapter into a reusable local request/result controller. This
extends the one-shot `studio:check`; it keeps one connection open for explicit
selection, repeated bounded reads, status polling and cancellation. It adds no
app route, database, paid call, game edit or persistent service.

The helper has **no write operation**. A separate dispatch guard allows only
`list_roblox_studios` and `get_studio_state` calls. The existing write review
workflow and its activation gates remain separate.

## Run locally

Use existing Node 22.18+ and the repository's installed MCP dependencies:

```powershell
# Optional in a worktree without node_modules: reuse an existing checkout.
$env:ROMANUM_BRIDGE_SDK_ROOT = 'C:\Users\nirke\Documents\Codex\2026-10-03\task-2\romanum-pricing-release'
node scripts/studio-helper.mjs --fixture
```

This flag launches only the existing authored stdio fixture. It reports
`mode: "fixture"` and `realStudioConnected: false` in every status. Running the
command without arguments returns `transport_disabled` and exits without
loading the SDK or starting a peer. `--help` describes the local command.

The command first emits an uncorrelated initial status (`id: null`, idle).
Send one JSON object per line and **wait for each dependent response** before
sending the next request. Successful connection discovers sessions but selects
none. Example fixture conversation:

```json
{"id":"connect-1","operation":"connect"}
{"id":"select-1","operation":"select","studioId":"studio-b"}
```

Copy `result.selectionId` from the selection response into the inspection:

```json
{"id":"read-1","operation":"inspect","selectionId":"COPY_SELECTION_ID","input":{}}
{"id":"status-1","operation":"status"}
{"id":"refresh-1","operation":"discover"}
{"id":"close-1","operation":"close"}
```

This is the helper's internal JSON-lines protocol, **not an MCP server**. The
underlying existing transport uses MCP over child stdin/stdout. There is no
TCP listener, URL, browser connection or automatic process restart.

## Requests, status and outcomes

| Operation | Fields beyond `id`, `operation` | Behavior |
| --- | --- | --- |
| `connect` | optional `timeoutMs` | Start and negotiate once, then discover; no automatic selection. |
| `status` | none | Immediate local snapshot; makes no remote calls. |
| `discover` | optional `timeoutMs` | Refresh sessions/schema; clear a changed target or failed discovery. |
| `select` | `studioId` | Choose a discovered session and create a fresh selection token. |
| `inspect` | `selectionId`, optional `input`, `timeoutMs` | Prepare and execute one `get_studio_state` action with its pinned target. |
| `cancel` | `requestId` | Abort only that active request; acknowledge whether it matched. |
| `close` | none | Cancel pending work and await existing bounded child cleanup. |

Responses carry the same `id`, `ok`, and `status`, plus `result` or a safe
`error: {code, outcome}`. Read results include the generated action ID, exact
target and original MCP result envelope. Remote text/resources remain untrusted
data; the helper neither executes text nor fetches resource links.

Status includes lifecycle state, fixture/owner mode, connection ID, sessions,
selected target, discovered **read** capability version/input schema,
`canInspect`, active request ID, last successful check time and last asynchronous
error. `connected` means protocol negotiation succeeded on a still-open peer;
it does not mean a place is selected. `realStudioConnected` additionally requires
trusted owner mode. Status does not actively probe liveness: use `discover` to
refresh. Disconnect clears sessions, schema and selection immediately.

Reads require the current selection token, and caller-supplied `studio_id` is
rejected. The bridge rechecks sessions, target identity, capability and schema
before dispatch. Reselection changes the token even for the same Studio.
If a read detects a changed target/capability, discover and select again.
Use `readCapability.inputSchema` to construct actual read parameters; do not
guess required fields. Empty `input` is valid only when the peer schema permits
it after the bridge injects `studio_id`.

One asynchronous operation runs at a time. `status`, `cancel`, and `close` stay
available during that operation; other requests return `busy`. Use a new request
ID for each request. Reusing an accepted ID returns `duplicate_request`, including
after failure or cancellation, without another dispatch. There is no result
receipt persistence or automatic retry/reconnect. Preserve returned evidence in
the trusted caller if needed; the existing durable workflow owns its SQL state.

Each operation has one total deadline (default 5 seconds, maximum 30 seconds),
including startup/discovery for `connect`. Cancellation is best effort and its
acknowledgement is separate from the cancelled request's eventual error.
Dispatched read failures have `outcome: "failed"`; pre-dispatch failures have
`not_dispatched`. This helper cannot create an uncertain write.

Limits: 64 KiB inbound frames/requests, 128 KiB outbound responses, 16 pending
CLI responses, 1,024 unique accepted request IDs per helper, and the bridge's
existing 256 actions and protocol bounds. IDs are 1-100 ASCII identifier
characters. Unknown operations/fields are rejected. The command exits on EOF,
explicit close, signal, malformed oversized framing, or 30 seconds without input.
EOF aborts pending work; keep stdin open until dependent responses arrive. All
owned child processes use the adapter's existing bounded shutdown. No logs or
results are saved to disk by this command.

## Integrate without touching the app

Trusted local callers can construct the controller directly:

```ts
import { StudioReadHelper } from './packages/studio-bridge/src/index.ts';
import { createFixtureStdioTransport, loadInstalledMcpSdk } from './packages/studio-bridge/src/transport/index.ts';

const transport = createFixtureStdioTransport(loadInstalledMcpSdk());
const helper = new StudioReadHelper(transport, { mode: 'fixture' });
try {
  const connection = await helper.handle({ id: 'connect', operation: 'connect' });
  // Display connection.status.sessions and let the owner explicitly choose.
  const selected = await helper.handle({ id: 'select', operation: 'select', studioId: 'studio-b' });
  if (selected.ok && selected.status.selected) {
    const read = await helper.handle({ id: 'read', operation: 'inspect', selectionId: selected.status.selected.selectionId });
    // Display read.status and, on success, read.result as untrusted evidence.
  }
} finally { await helper.close(); }
```

The same controller accepts the existing `createOwnerStdioTransport` after
separate owner activation. Only trusted local configuration sets mode and launch
path; a request cannot set credentials, executable, owner, project, permission
or mode. This controller is not an authentication/pairing design. Keep it away
from anonymous public MCP and model tools. A hosted Romanum process cannot
reach a desktop stdio process; the disabled private workflow still needs its
reviewed owner/project binding and a separately authorized desktop channel.

## Remaining live setup (not performed)

1. Confirm Roblox Studio is already installed on the owner's machine and open
   an explicitly chosen authorized test place. Inspection of the exact local
   target `C:\Users\nirke\AppData\Local\Roblox` was denied. Inspection stopped
   there; the installed launcher and MCP settings could not be verified. Owner
   approval/access is needed to inspect that target or supply a verified exact
   executable path. No installation or Studio launch was attempted.
2. Obtain approval before enabling **Assistant > Manage MCP Servers > Enable
   Studio as MCP server**, if not already enabled. Follow the
   [current official Roblox setup](https://create.roblox.com/docs/studio/mcp).
   No settings, access grants, credentials or client configuration were changed.
3. Review the installed official `%LOCALAPPDATA%\Roblox\mcp.bat` to identify
   its exact installed `StudioMCP.exe`. The existing adapter accepts only that
   absolute native executable, with no shell, batch wrapper or extra arguments.
   Do not bypass this restriction if the installation requires a different
   launcher; report that target for a separately reviewed adapter change.
4. After explicit authorization for local read connection, run:

   ```powershell
   node scripts/studio-helper.mjs --enable-owner --owner-executable 'C:\EXACT_INSTALLED_PATH\StudioMCP.exe'
   ```

   Then connect, display real discovery, select the owner's test Studio, and
   inspect once. Verify actual tool/session schemas and Studio's green MCP
   connection indicator. The existing validator deliberately rejects unsupported
   schema dialects/keywords; report any incompatibility rather than weaken it.

No live Studio connection/schema read, game editing, permission change,
persistent installation, public route activation, deployment or push happened.

## Focused verification

```powershell
node --test --test-concurrency=1 packages/studio-bridge/tests/helper.test.mjs
# Existing bridge/stdio regressions remain serial because of short fixture deadlines.
node --test --test-concurrency=1 packages/studio-bridge/tests/*.test.mjs
```

The six helper tests cover the actual command/stdio round trip, selection binding,
duplicate/write rejection, status/cancel during an active read, timeout and child
exit, target invalidation, startup cleanup, and disabled launch defaults. They
use only authored fixtures. No new dependency or proof harness is required.
