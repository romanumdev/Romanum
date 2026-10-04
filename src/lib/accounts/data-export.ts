import type { Database } from "../history/database.ts";

// A bounded, private export of one signed-in account's own Romanum data.
//
// Design rules this module holds to:
//   * The allowlist below is the only source of table access. A section name is
//     looked up in SPECS, so an unknown name never reaches SQL and no caller
//     string is ever interpolated into a statement.
//   * Every column is named explicitly; there is no `SELECT *` and no
//     `to_jsonb(table)`, so a column added later is not exported by accident.
//   * The account row is resolved inside the read transaction by id AND owner
//     id, and every section (and every join in it) is filtered by that owner.
//   * Pagination is forward-only keyset over a unique string key, ordered with
//     the deterministic `COLLATE "C"` collation, with parameterized bounds.
//   * Reads are live and lock nothing: a page is a point-in-time read, not a
//     snapshot shared across pages, and nothing is written or materialized.
//
// Deliberately absent: session and token hashes, raw encrypted game keys, the
// internal operator/evidence identities and claim ids, and any raw image bytes
// (metadata and bounded binary reads are exposed instead).

export const EXPORT_SECTIONS = [
  "profile",
  "credits_account",
  "credits_operations",
  "credits_ledger",
  "usage_charges",
  "usage_carry",
  "usage_holds",
  "tool_usage",
  "weekly_credit_claims",
  "chats",
  "chat_messages",
  "chat_attachments",
  "chat_runs",
  "creative_projects",
  "creative_assets",
  "creative_workflows",
  "creative_jobs",
  "creative_reviews",
  "creative_reconciliations",
  "agent_runs",
  "agent_actions",
  "ui_asset_rights",
  "ui_library_entries",
  "ui_library_events",
  "ui_library_sources",
  "ui_library_dependencies",
  "linked_games",
  "linked_game_metrics",
  "linked_game_consents",
  "ad_reports",
  "ad_report_settings",
  "ad_report_consents",
  "ad_report_creative_links",
  "ad_report_observations",
  "ad_report_observation_reports",
  "ad_report_observation_creatives",
  "analytics_watchlists",
  "analytics_watchlist_state",
  "analytics_notifications",
  "analytics_experiments",
] as const;

export type ExportSection = (typeof EXPORT_SECTIONS)[number];

/** The account to export, as resolved from a verified session: never trusted alone. */
export type ExportAccount = { id: string; ownerId: string };

export type ExportErrorCode = "invalid" | "not_found" | "too_large";

export class ExportError extends Error {
  readonly code: ExportErrorCode;
  constructor(code: ExportErrorCode, message: string) {
    super(message);
    this.name = "ExportError";
    this.code = code;
  }
}

// One page holds at most 100 rows and, when more than one row is returned, at
// most 512 KiB of JSON. A single record may be up to 3 MiB: a lone record larger
// than the page budget is still returned whole (it is never skipped, truncated
// or dropped), and anything larger than that is refused rather than lost.
export const MAX_PAGE_ROWS = 100;
export const MAX_PAGE_BYTES = 512 * 1024;
const MAX_RECORD_BYTES = 3 * 1024 * 1024;
const MAX_FETCH_ROWS = MAX_PAGE_ROWS + 1;
const MAX_CURSOR_CHARS = 2000;

// A single image read returns at most this many bytes, sliced in SQL so the
// whole image is never materialized in memory just to return one chunk.
const MAX_IMAGE_OFFSET = 10 * 1024 * 1024;
const IMAGE_CHUNK_BYTES = 512 * 1024;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The account id must look like a UUID before it can be resolved against `accounts`. */
function requireAccount(account: ExportAccount | null | undefined): ExportAccount {
  if (!account || typeof account.id !== "string" || typeof account.ownerId !== "string" || !UUID.test(account.id)) {
    throw new ExportError("invalid", "A valid account id and owner id are required.");
  }
  return account;
}

// Every section is a fixed SQL fragment selected by name. `$1` is the resolved
// owner id, `$2` is the resolved account id, `$3` is the cursor key (or NULL) and
// `$4` is the fetch limit. `key` is the unique, ascending string key.
type SectionSpec = { columns: string; from: string; scope: string; key: string };

const SPECS: Record<ExportSection, SectionSpec> = {
  analytics_watchlists: {
    columns: "w.id, w.name, w.universe_id::text AS universe_id, w.peer_ids, w.enabled, w.direction, w.threshold_percent, w.minimum_players, w.window_minutes, w.revision, w.created_at, w.updated_at",
    from: "analytics_watchlists w", scope: "w.owner_id=$1", key: "w.id::text",
  },
  analytics_watchlist_state: {
    columns: "s.watchlist_id, s.revision, s.latched, s.evaluated_slot, s.coverage, s.detail",
    from: "analytics_watchlist_state s JOIN analytics_watchlists w ON w.id=s.watchlist_id AND w.owner_id=s.owner_id",
    scope: "s.owner_id=$1 AND w.owner_id=$1", key: "s.watchlist_id::text",
  },
  analytics_notifications: {
    columns: "n.id, n.watchlist_id, n.observed_at, n.title, n.evidence, n.acknowledged_at, n.created_at",
    from: "analytics_notifications n JOIN analytics_watchlists w ON w.id=n.watchlist_id AND w.owner_id=n.owner_id",
    scope: "n.owner_id=$1 AND w.owner_id=$1", key: "n.id::text",
  },
  analytics_experiments: {
    columns: "e.id, e.project_id, e.title, e.brief, e.evidence, e.intended_metric, e.universe_id::text AS universe_id, e.status, e.release_date, e.revision, e.created_at, e.updated_at",
    from: "analytics_experiments e", scope: "e.owner_id=$1", key: "e.id::text",
  },
  ad_reports: {
    columns: "r.id, r.project_id, r.owner_id, r.content_fingerprint, r.bundle, r.created_at",
    from: "ad_reports r", scope: "r.owner_id=$1", key: "r.id::text",
  },
  ad_report_settings: {
    columns: "s.project_id, s.owner_id, s.ai_analysis, s.consent_version, s.updated_at",
    from: "ad_report_settings s", scope: "s.owner_id=$1", key: "s.project_id::text",
  },
  ad_report_consents: {
    columns: "s.id, s.project_id, s.owner_id, s.ai_analysis, s.consent_version, s.created_at",
    from: "ad_report_consents s", scope: "s.owner_id=$1", key: "s.id::text",
  },
  ad_report_creative_links: {
    columns: "l.id, l.project_id, l.owner_id, l.report_id, l.ad_id, l.creative_id, l.created_at",
    from: "ad_report_creative_links l", scope: "l.owner_id=$1", key: "l.id::text",
  },
  ad_report_observations: {
    columns: "o.id, o.project_id, o.owner_id, o.status, o.body, o.supersedes_id, o.created_at",
    from: "ad_report_observations o", scope: "o.owner_id=$1", key: "o.id::text",
  },
  ad_report_observation_reports: {
    columns: "e.observation_id, e.project_id, e.owner_id, e.report_id",
    from: "ad_report_observation_reports e", scope: "e.owner_id=$1", key: "e.observation_id::text || ':' || e.report_id::text",
  },
  ad_report_observation_creatives: {
    columns: "e.observation_id, e.project_id, e.owner_id, e.creative_id",
    from: "ad_report_observation_creatives e", scope: "e.owner_id=$1", key: "e.observation_id::text || ':' || e.creative_id::text",
  },
  // Account profile only: names and the Roblox user id, never session material.
  profile: {
    columns: "a.id, a.owner_id, a.roblox_user_id::text AS roblox_user_id, a.username, a.display_name, a.picture_url, a.credit_plan, a.created_at, a.signed_in_at",
    from: "accounts a",
    scope: "a.id = $2::uuid AND a.owner_id = $1",
    key: "a.id::text",
  },
  credits_account: {
    columns: "c.owner_id, c.balance::text AS balance, c.reserved::text AS reserved, c.created_at, c.updated_at",
    from: "credits_accounts c",
    scope: "c.owner_id = $1",
    key: "c.owner_id",
  },
  credits_operations: {
    columns: "o.operation_id, o.owner_id, o.kind, o.status, o.amount::text AS amount, o.captured_amount::text AS captured_amount, o.created_at, o.updated_at",
    from: "credits_operations o",
    scope: "o.owner_id = $1",
    key: "o.operation_id",
  },
  credits_ledger: {
    columns: "l.id::text AS id, l.owner_id, l.entry_type, l.status, l.operation_id, l.amount::text AS amount, l.balance_change::text AS balance_change, l.reserved_change::text AS reserved_change, l.balance_after::text AS balance_after, l.reserved_after::text AS reserved_after, l.created_at",
    from: "credits_ledger l",
    scope: "l.owner_id = $1",
    key: "l.id::text",
  },
  usage_charges: {
    columns: "u.id, u.owner_id, u.feature, u.calls, u.tools, u.cost_nano_usd::text AS cost_nano_usd, u.price_nano_usd::text AS price_nano_usd, u.credits_charged::text AS credits_charged, u.unpaid_nano_usd::text AS unpaid_nano_usd, u.created_at",
    from: "usage_charges u",
    scope: "u.owner_id = $1",
    key: "u.id::text",
  },
  usage_carry: {
    columns: "u.owner_id, u.carry_nano_usd::text AS carry_nano_usd, u.updated_at",
    from: "usage_carry u",
    scope: "u.owner_id = $1",
    key: "u.owner_id",
  },
  // A hold's call fingerprint and the operation id are internal identity, not
  // user-facing billing detail, so only the amounts, status and result are read.
  usage_holds: {
    columns: "h.id, h.owner_id, h.feature, h.status, h.max_price_nano_usd::text AS max_price_nano_usd, h.reserved_credits::text AS reserved_credits, h.settled_charge_id, h.settled_cost_nano_usd::text AS settled_cost_nano_usd, h.settled_price_nano_usd::text AS settled_price_nano_usd, h.settled_credits_charged::text AS settled_credits_charged, h.created_at, h.updated_at",
    from: "usage_holds h",
    scope: "h.owner_id = $1",
    key: "h.id::text",
  },
  tool_usage: {
    columns: "t.id, t.owner_id, t.feature, t.tool_name, t.price_nano_usd::text AS price_nano_usd, t.status, t.credits_charged, t.charge_id, t.created_at, t.updated_at",
    from: "tool_usage t",
    scope: "t.owner_id = $1",
    key: "t.id::text",
  },
  weekly_credit_claims: {
    columns: "w.week_start, w.owner_id, w.amount, w.created_at",
    from: "weekly_credit_claims w",
    scope: "w.owner_id = $1",
    key: "w.week_start::text",
  },
  chats: {
    columns: "c.id, c.owner_id, c.project_id, c.title, c.history, c.created_at, c.updated_at",
    from: "chats c",
    scope: "c.owner_id = $1",
    key: "c.id::text",
  },
  chat_messages: {
    columns: "m.id, m.chat_id, m.seq::text AS seq, m.role, m.content, m.events, m.created_at",
    from: "chat_messages m JOIN chats c ON c.id = m.chat_id",
    scope: "c.owner_id = $1",
    key: "m.id::text",
  },
  // Attachment metadata only: the display name and the byte length, never bytes.
  chat_attachments: {
    columns: "a.id, a.message_id, a.owner_id, a.position, a.name, a.mime_type, octet_length(a.bytes) AS byte_length, a.created_at",
    from: "chat_attachments a JOIN chat_messages m ON m.id = a.message_id JOIN chats c ON c.id = m.chat_id",
    scope: "a.owner_id = $1 AND c.owner_id = $1",
    key: "a.id::text",
  },
  creative_projects: {
    columns: "p.id, p.owner_id, p.name, p.context, p.revision, p.archived, p.created_at, p.updated_at",
    from: "creative_projects p",
    scope: "p.owner_id = $1",
    key: "p.id::text",
  },
  // Asset metadata only: dimensions, hash, author metadata and byte length.
  creative_assets: {
    columns: "a.id, a.owner_id, a.project_id, a.kind, a.mime_type, a.width, a.height, a.sha256, a.metadata, octet_length(a.bytes) AS byte_length, a.created_at",
    from: "creative_assets a JOIN creative_projects p ON p.id = a.project_id AND p.owner_id = a.owner_id",
    scope: "a.owner_id = $1 AND p.owner_id = $1",
    key: "a.id::text",
  },
  // Plan metadata is the owner's written record; the idempotency keys and the
  // call input hash that back a saved plan are internal and stay out.
  creative_workflows: {
    columns: "w.id, w.owner_id, w.project_id, w.kind, w.brief, w.reference_ids, w.concepts, w.credit_budget, w.allow_agent_review, w.approval, w.plan_title, w.project_revision, w.project_context, w.source_chat_id, w.created_at",
    from: "creative_workflows w JOIN creative_projects p ON p.id = w.project_id AND p.owner_id = w.owner_id",
    scope: "w.owner_id = $1 AND p.owner_id = $1",
    key: "w.id::text",
  },
  creative_jobs: {
    columns: "j.id, j.owner_id, j.project_id, j.workflow_id, j.concept_key, j.stage, j.asset_key, j.status, j.provider_id, j.provider_model, j.provider_mode, j.quoted_credits, j.request, j.output_asset_id, j.error_code, j.created_at, j.started_at, j.finished_at",
    from: "creative_jobs j JOIN creative_workflows w ON w.id = j.workflow_id AND w.owner_id = j.owner_id AND w.project_id = j.project_id",
    scope: "j.owner_id = $1 AND w.owner_id = $1",
    key: "j.id::text",
  },
  // Reviews keep their outcome and reasoning; the durable claim id does not.
  creative_reviews: {
    columns: "r.id, r.owner_id, r.project_id, r.workflow_id, r.job_id, r.asset_id, r.reviewer_id, r.reviewer_model, r.reviewer_mode, r.asset_sha256, r.status, r.approved, r.reason, r.error_code, r.claimed_at, r.finished_at, r.created_at",
    from: "creative_reviews r JOIN creative_jobs j ON j.id = r.job_id AND j.owner_id = r.owner_id AND j.project_id = r.project_id",
    scope: "r.owner_id = $1 AND j.owner_id = $1",
    key: "r.id::text",
  },
  // The outcome a person cares about; operator, evidence and fingerprint stay out.
  creative_reconciliations: {
    columns: "r.id, r.job_id, r.owner_id, r.project_id, r.outcome, r.actual_credits, r.output_asset_id, r.created_at",
    from: "creative_reconciliations r JOIN creative_jobs j ON j.id = r.job_id AND j.owner_id = r.owner_id AND j.project_id = r.project_id",
    scope: "r.owner_id = $1 AND j.owner_id = $1",
    key: "r.id::text",
  },
  agent_runs: {
    columns: "r.id, r.owner_id, r.project_id, r.objective, r.context, r.allowed_tools, r.auto_project_writes, r.max_steps, r.steps, r.status, r.final_text, r.error_code, r.waiting_job_id, r.created_at",
    from: "agent_runs r JOIN creative_projects p ON p.id = r.project_id AND p.owner_id = r.owner_id",
    scope: "r.owner_id = $1 AND p.owner_id = $1",
    key: "r.id::text",
  },
  agent_actions: {
    columns: "a.id, a.run_id, a.sequence, a.tool_name, a.tool_version, a.tool_scope, a.target, a.effect, a.input, a.reason, a.status, a.result, a.error_code, a.approved_at, a.created_at",
    from: "agent_actions a JOIN agent_runs r ON r.id = a.run_id",
    scope: "r.owner_id = $1",
    key: "a.id::text",
  },
  // The owner's own rights declaration is included; operator evidence IDs in
  // creative reconciliation records remain excluded.
  ui_asset_rights: {
    columns: "r.asset_id, r.owner_id, r.project_id, r.status, r.license, r.attribution, r.evidence_private, r.updated_at",
    from: "ui_asset_rights r JOIN creative_assets a ON a.id = r.asset_id AND a.owner_id = r.owner_id AND a.project_id = r.project_id",
    scope: "r.owner_id = $1 AND a.owner_id = $1",
    key: "r.asset_id::text",
  },
  ui_library_entries: {
    columns: "e.id, e.owner_id, e.project_id, e.state, e.revision, e.title, e.description, e.tags, e.layout, e.assets, e.source_entry_ids, e.license, e.attribution, e.credits, e.consent_version, e.created_at, e.shared_at",
    from: "ui_library_entries e",
    scope: "e.owner_id = $1",
    key: "e.id::text",
  },
  ui_library_events: {
    columns: "v.id::text AS id, v.entry_id, v.owner_id, v.action, v.revision, v.notice_version, v.created_at",
    from: "ui_library_events v JOIN ui_library_entries e ON e.id = v.entry_id AND e.owner_id = v.owner_id",
    scope: "v.owner_id = $1 AND e.owner_id = $1",
    key: "v.id::text",
  },
  ui_library_sources: {
    columns: "s.entry_id, s.asset_id",
    from: "ui_library_sources s JOIN ui_library_entries e ON e.id = s.entry_id",
    scope: "e.owner_id = $1",
    key: "(s.entry_id::text || '|' || s.asset_id::text)",
  },
  ui_library_dependencies: {
    columns: "d.entry_id, d.source_entry_id",
    from: "ui_library_dependencies d JOIN ui_library_entries e ON e.id = d.entry_id",
    scope: "e.owner_id = $1",
    key: "(d.entry_id::text || '|' || d.source_entry_id::text)",
  },
  linked_games: {
    columns: "g.id, g.account_id, g.universe_id::text AS universe_id, g.collect, g.share, g.ai_analysis, g.shared_since, g.consent_version, g.status, g.synced_at, g.sync_error, g.created_at",
    from: "linked_games g",
    scope: "g.account_id = $2::uuid",
    key: "g.id::text",
  },
  chat_runs: {
    columns: "r.id,r.account_id,r.owner_id,r.chat_id,r.question_id,r.status,r.payload,r.events,r.event_count,r.cancel_requested,r.error,r.created_at,r.started_at,r.finished_at",
    from: "chat_runs r",
    scope: "r.account_id=$2::uuid AND r.owner_id=$1",
    key: "r.id::text",
  },
  linked_game_metrics: {
    columns: "m.game_id, m.metric, m.day::text AS day, m.value, m.status, m.fetched_at",
    from: "linked_game_metrics m JOIN linked_games g ON g.id = m.game_id",
    scope: "g.account_id = $2::uuid",
    key: "concat(m.game_id::text, '|', m.metric, '|', m.day::text)",
  },
  linked_game_consents: {
    columns: "c.id::text AS id, c.account_id, c.universe_id::text AS universe_id, c.setting, c.enabled, c.notice, c.created_at",
    from: "linked_game_consents c",
    scope: "c.account_id = $2::uuid",
    key: "c.id::text",
  },
};

const encodeCursor = (section: string, key: string): string =>
  Buffer.from(JSON.stringify([section, key]), "utf8").toString("base64url");

const invalidCursor = () => new ExportError("invalid", "The export cursor is not valid for this section.");

function decodeCursor(section: string, cursor: string): string {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== "string" || typeof decoded[1] !== "string") throw invalidCursor();
  // A cursor minted for one section can never continue another.
  if (decoded[0] !== section || decoded[1].length === 0) throw invalidCursor();
  return decoded[1];
}

/** Drops the internal pagination key and normalizes timestamps to ISO strings. */
function toRecord(row: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    if (name === "export_key") continue;
    record[name] = value instanceof Date ? value.toISOString() : value;
  }
  return record;
}

/**
 * Reads one page of an owner's rows for one allowlisted section.
 *
 * The account is resolved by id AND owner id inside a read-only transaction, so
 * a caller cannot export another owner's data by supplying mismatched ids. Rows
 * come back ascending by their unique string key under `COLLATE "C"`, and the
 * returned `nextCursor` is the last emitted key, present only while more rows
 * remain. A section with no more rows returns an empty page and a null cursor.
 */
export async function readExportPage(
  database: Database,
  account: ExportAccount,
  section: string,
  after: string | null = null,
): Promise<{ section: string; records: Record<string, unknown>[]; nextCursor: string | null }> {
  const spec: SectionSpec | undefined = Object.hasOwn(SPECS, section) ? (SPECS as Record<string, SectionSpec>)[section] : undefined;
  if (!spec) throw new ExportError("invalid", `Unknown export section: ${String(section)}.`);
  requireAccount(account);
  const afterKey = after === null || after === undefined ? null : decodeCursor(section, after);

  return database.transaction(async (sql) => {
    // Bound the data sent from PostgreSQL before materialising rows in Node.
    // The size probe and selected rows must see the same page contents.
    await sql.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const { rows: accounts } = await sql.query<{ id: string; owner_id: string }>(
      "SELECT id, owner_id FROM accounts WHERE id=$1 AND owner_id=$2",
      [account.id, account.ownerId],
    );
    const resolved = accounts[0];
    if (!resolved) throw new ExportError("not_found", "No account matches that id and owner id.");

    // The account-ownership EXISTS both types the account-id parameter and
    // re-asserts the owner in the statement itself, so no section can ever
    // return rows without the resolved owner filter applied.
    const base = `SELECT ${spec.columns}, ${spec.key} AS export_key FROM ${spec.from} `
      + `WHERE EXISTS (SELECT 1 FROM accounts acct WHERE acct.id = $2::uuid AND acct.owner_id = $1) `
      + `AND (${spec.scope}) `
      + `AND ($3::text IS NULL OR (${spec.key}) COLLATE "C" > $3::text COLLATE "C") `;
    const order = `ORDER BY (${spec.key}) COLLATE "C" ASC LIMIT $4`;
    const values = [resolved.owner_id, resolved.id, afterKey, MAX_FETCH_ROWS];
    // to_jsonb receives only the explicitly projected columns above, never a
    // base table row. Return sizes first, not 101 potentially huge chat histories.
    const { rows: sizes } = await sql.query<{ export_key: string; export_bytes: number }>(
      `WITH candidates AS (${base}${order}) SELECT export_key, octet_length((to_jsonb(candidates) - 'export_key')::text) AS export_bytes FROM candidates ORDER BY export_key COLLATE "C"`, values,
    );
    const keys: string[] = []; let budget = 2;
    for (const row of sizes) {
      if (keys.length >= MAX_PAGE_ROWS) break;
      if (row.export_bytes > MAX_RECORD_BYTES) throw new ExportError("too_large", `A record in ${section} exceeds the export limit.`);
      if (keys.length && budget + row.export_bytes + 1 > MAX_PAGE_BYTES) break;
      keys.push(row.export_key); budget += row.export_bytes + 1;
    }
    if (!keys.length) return { section, records: [], nextCursor: null };
    const { rows } = await sql.query<Record<string, unknown>>(
      `${base}AND (${spec.key}) = ANY($5::text[]) ${order}`, [...values, keys],
    );

    const records: Record<string, unknown>[] = [];
    let pageBytes = 2; // the enclosing "[]"
    let lastKey = "";
    for (const row of rows) {
      if (records.length >= MAX_PAGE_ROWS) break;
      const record = toRecord(row);
      const size = Buffer.byteLength(JSON.stringify(record), "utf8");
      if (size > MAX_RECORD_BYTES) throw new ExportError("too_large", `A single record in ${section} is larger than the 3 MiB export limit.`);
      // The page budget stops a multi-row page early; a lone allowed record is
      // still emitted so the export always makes progress without gaps.
      if (records.length > 0 && pageBytes + size + 1 > MAX_PAGE_BYTES) break;
      records.push(record);
      pageBytes += size + (records.length > 1 ? 1 : 0);
      lastKey = String(row.export_key);
    }
    const more = sizes.length > records.length;
    return { section, records, nextCursor: more ? encodeCursor(section, lastKey) : null };
  });
}

const IMAGE_SQL = {
  chat: "SELECT a.mime_type, octet_length(a.bytes) AS total_bytes, substr(a.bytes, $3::int, $4::int) AS chunk "
    + "FROM chat_attachments a JOIN chat_messages m ON m.id = a.message_id JOIN chats c ON c.id = m.chat_id "
    + "WHERE a.id = $1 AND a.owner_id = $2 AND c.owner_id = $2",
  creative: "SELECT a.mime_type, octet_length(a.bytes) AS total_bytes, substr(a.bytes, $3::int, $4::int) AS chunk "
    + "FROM creative_assets a JOIN creative_projects p ON p.id = a.project_id AND p.owner_id = a.owner_id "
    + "WHERE a.id = $1 AND a.owner_id = $2 AND p.owner_id = $2",
} as const;

/**
 * Reads one bounded chunk of a single owned image.
 *
 * `offset` is a byte position validated to be an integer in `[0, 10 MiB]`; a
 * slice of at most 512 KiB is read in SQL so the whole image is never loaded to
 * serve one chunk. The account, the image and its parent are all resolved within
 * the owner's scope, so a missing or foreign image reads as null. The client is
 * responsible for turning `{kind, id, mimeType}` into a filename.
 */
export async function readExportImage(
  database: Database,
  account: ExportAccount,
  kind: "chat" | "creative",
  id: string,
  offset: number,
): Promise<{ bytes: Uint8Array; mimeType: string; totalBytes: number; nextOffset: number | null } | null> {
  if (kind !== "chat" && kind !== "creative") throw new ExportError("invalid", "Unknown export image kind.");
  if (typeof id !== "string" || !UUID.test(id)) throw new ExportError("invalid", "An image id must be a UUID.");
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_IMAGE_OFFSET) throw new ExportError("invalid", "An image offset must be a whole number of bytes within the image limit.");
  requireAccount(account);

  return database.transaction(async (sql) => {
    const { rows: accounts } = await sql.query<{ id: string; owner_id: string }>(
      "SELECT id, owner_id FROM accounts WHERE id=$1 AND owner_id=$2",
      [account.id, account.ownerId],
    );
    const resolved = accounts[0];
    if (!resolved) throw new ExportError("not_found", "No account matches that id and owner id.");

    const { rows } = await sql.query<{ mime_type: string; total_bytes: number | string; chunk: Uint8Array }>(
      IMAGE_SQL[kind],
      [id, resolved.owner_id, offset + 1, IMAGE_CHUNK_BYTES],
    );
    const row = rows[0];
    if (!row) return null;
    const totalBytes = Number(row.total_bytes);
    if (offset >= totalBytes) throw new ExportError("invalid", "The image offset is past the end of the image.");
    const bytes = new Uint8Array(row.chunk);
    const nextOffset = offset + bytes.length < totalBytes ? offset + bytes.length : null;
    return { bytes, mimeType: row.mime_type, totalBytes, nextOffset };
  });
}
