import { z } from "zod";
import type { Database, Sql } from "../history/database.ts";
import { ownerIdSchema } from "../creative/schema.ts";

// Closing the signed-in owner's account. This is the only place that removes an
// owner's private data, and it does so atomically: either every owned row and the
// account itself are gone and the closure marker is written, or nothing changes.
//
// It deliberately keeps the minimal credit accounting (the immutable ledger, the
// credit account and open usage holds), so a reservation that is still settling
// can finish after the owner is closed, and keeps the marker so a stale cookie,
// queued write or retry cannot resurrect the account. Public Roblox history is
// not owned by anyone here and is never touched.

export type AccountClosureErrorCode = "invalid" | "not_found" | "unfinished_work" | "shared_assets";

export class AccountClosureError extends Error {
  readonly code: AccountClosureErrorCode;
  constructor(code: AccountClosureErrorCode) {
    super(`Account closure: ${code}.`);
    this.name = "AccountClosureError";
    this.code = code;
  }
}

const closeInput = z.object({ id: z.uuid(), ownerId: ownerIdSchema }).strict();

function parseInput(input: { id: unknown; ownerId: unknown }): { id: string; ownerId: string } {
  const parsed = closeInput.safeParse(input);
  if (!parsed.success) throw new AccountClosureError("invalid");
  return parsed.data;
}

// Orders the owner's advisory lock the same way every guard trigger does, so a
// closure and an in-flight write can never both see "not yet closed".
async function lockOwner(sql: Sql, ownerId: string) {
  await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
}

// A queued or uncertain image job, a claimed review or a live agent run may still
// be working on this owner's rows; deleting underneath it would fork its lineage.
// Open credit holds stay reserved and can settle later; they contain accounting
// metadata and are retained rather than deleted with the private content.
async function assertNoUnfinishedWork(sql: Sql, ownerId: string) {
  const { rows } = await sql.query(
    `SELECT 1 FROM creative_jobs WHERE owner_id=$1 AND status IN ('queued','running','uncertain')
     UNION ALL SELECT 1 FROM creative_reviews WHERE owner_id=$1 AND status='claimed'
     UNION ALL SELECT 1 FROM agent_runs WHERE owner_id=$1 AND status IN ('ready','running','waiting','awaiting_approval','uncertain')
     LIMIT 1`,
    [ownerId],
  );
  if (rows[0]) throw new AccountClosureError("unfinished_work");
}

// Another owner's listing or derived draft may cite this owner's assets or
// entries. Those rows belong to the other account, so they are never deleted or
// rewritten here; the close fails for an operator to resolve. The public reuse
// path is not exposed, so this should stay unreachable in production for now.
async function assertNoSharedAssets(sql: Sql, ownerId: string) {
  const { rows } = await sql.query(
    `SELECT 1 FROM ui_library_sources s
       JOIN ui_library_entries e ON e.id = s.entry_id
      WHERE e.owner_id <> $1 AND s.asset_id IN (SELECT id FROM creative_assets WHERE owner_id=$1)
     UNION ALL
     SELECT 1 FROM ui_library_dependencies d
       JOIN ui_library_entries e ON e.id = d.entry_id
      WHERE e.owner_id <> $1 AND d.source_entry_id IN (SELECT id FROM ui_library_entries WHERE owner_id=$1)
     LIMIT 1`,
    [ownerId],
  );
  if (rows[0]) throw new AccountClosureError("shared_assets");
}

// Every statement is scoped to this owner. Children without an owner_id
// (chat_messages, agent_actions, linked game records) are reached only through
// their owner's parent row, and the parent rows are deleted in dependency order.
async function deleteOwnerData(sql: Sql, ownerId: string, accountId: string) {
  // Saved analytics work is private; watch state and alerts cascade from watches.
  await sql.query("DELETE FROM analytics_watchlists WHERE owner_id=$1", [ownerId]);
  await sql.query("DELETE FROM analytics_experiments WHERE owner_id=$1", [ownerId]);
  // The catalogue's own audit trail and lineage first, then its listings and
  // rights, before the private assets and projects they point at.
  await sql.query("DELETE FROM ui_library_events WHERE owner_id=$1", [ownerId]);
  await sql.query("DELETE FROM ui_library_dependencies WHERE entry_id IN (SELECT id FROM ui_library_entries WHERE owner_id=$1)", [ownerId]);
  await sql.query("DELETE FROM ui_library_sources WHERE entry_id IN (SELECT id FROM ui_library_entries WHERE owner_id=$1)", [ownerId]);
  await sql.query("DELETE FROM ui_library_entries WHERE owner_id=$1", [ownerId]);
  await sql.query("DELETE FROM ui_asset_rights WHERE owner_id=$1", [ownerId]);
  // Agent runs and their actions, then the creative work they may have produced
  // or reviewed: reconciliations and reviews before the jobs and assets they cite.
  await sql.query("DELETE FROM agent_runs WHERE owner_id=$1", [ownerId]);
  await sql.query("DELETE FROM creative_reviews WHERE owner_id=$1", [ownerId]);
  await sql.query("DELETE FROM creative_reconciliations WHERE owner_id=$1", [ownerId]);
  await sql.query("DELETE FROM creative_jobs WHERE owner_id=$1", [ownerId]);
  await sql.query("DELETE FROM creative_workflows WHERE owner_id=$1", [ownerId]);
  await sql.query("DELETE FROM creative_assets WHERE owner_id=$1", [ownerId]);
  // Chats (messages and attachments cascade) before the projects they may link to.
  await sql.query("DELETE FROM chats WHERE owner_id=$1", [ownerId]);
  await sql.query("DELETE FROM creative_projects WHERE owner_id=$1", [ownerId]);
  // The account itself; its sessions, linked games with keys and metrics, and
  // consent records all cascade.
  await sql.query("DELETE FROM accounts WHERE id=$1 AND owner_id=$2", [accountId, ownerId]);
  // The marker is written last, while the owner's advisory lock is still held, so
  // the cascades above never trip the closed-owner guard part way through.
  await sql.query("INSERT INTO account_closures(owner_id, account_id) VALUES($1,$2)", [ownerId, accountId]);
}

/**
 * Deletes the signed-in owner's account and private data in one transaction.
 *
 * An account that is already closed by the same owner is an idempotent success;
 * a mismatched or unknown account is `not_found`, without revealing whether an
 * account with that ID ever existed. Unfinished creative work is
 * `unfinished_work`, and an asset another owner's listing depends on is
 * `shared_assets`.
 */
export async function closeAccount(database: Database, input: { id: string; ownerId: string }): Promise<void> {
  const { id, ownerId } = parseInput(input);
  await database.transaction(async (sql) => {
    // Same order as the UI library service: its lock row, then the owner's lock,
    // so a concurrent share/reuse cannot interleave with the deletion.
    await sql.query("SELECT id FROM ui_library_lock WHERE id=true FOR UPDATE");
    await lockOwner(sql, ownerId);
    const { rows } = await sql.query<{ id: string }>("SELECT id FROM accounts WHERE id=$1 AND owner_id=$2 FOR UPDATE", [id, ownerId]);
    if (!rows[0]) {
      // A retry after the account row is gone: only the same owner may see success.
      const { rows: closed } = await sql.query<{ owner_id: string }>("SELECT owner_id FROM account_closures WHERE account_id=$1", [id]);
      if (closed[0]?.owner_id === ownerId) return;
      throw new AccountClosureError("not_found");
    }
    await assertNoUnfinishedWork(sql, ownerId);
    await assertNoSharedAssets(sql, ownerId);
    await deleteOwnerData(sql, ownerId, id);
  });
}

/**
 * Whether this owner has been closed, for sign-in, guest adoption and request
 * authorization paths. A missing or malformed owner ID is never closed.
 */
export async function isClosedOwner(sql: Pick<Database, "query">, ownerId: string): Promise<boolean> {
  if (typeof ownerId !== "string" || ownerId.length === 0 || ownerId.length > 200 || ownerId.includes("\0")) return false;
  const { rows } = await sql.query("SELECT 1 FROM account_closures WHERE owner_id=$1", [ownerId]);
  return rows.length > 0;
}
