import { z } from "zod";
import { authorizationUrl as signInAuthorizationUrl, completeSignIn, ROBLOX_OAUTH, oauthClient, type OAuthClient, type SignInAttempt } from "../accounts/roblox-oauth.ts";
import type { Database, Sql } from "../history/database.ts";
import { openSecret, sealSecret } from "../secrets.ts";

export const ANALYTICS_SCOPE = "universe.analytics:read";
const RESOURCE_URL = "https://apis.roblox.com/oauth/v1/token/resources";
export type AnalyticsAuthorizationInput = { code: string; verifier: string; nonce: string; redirectUri: string };
export type OAuthOptions = { fetch?: typeof fetch; now?: number; signal?: AbortSignal; client?: OAuthClient };
export class OAuthError extends Error {
  readonly kind: "reconnect_required" | "unavailable" | "invalid_grant";
  constructor(kind: "reconnect_required" | "unavailable" | "invalid_grant") {
    super(kind === "unavailable" ? "Couldn't reach Roblox authorization. Try again later." : "Reconnect this game's Roblox analytics access.");
    this.name = "OAuthError";
    this.kind = kind;
  }
}
const ownerSchema = z.object({ id: z.string().regex(/^[1-9]\d{0,14}$/), type: z.enum(["User", "Group"]) });
const grantSchema = z.object({
  access_token: z.string().min(1).max(16384), refresh_token: z.string().min(1).max(16384),
  scopes: z.array(z.string().min(1).max(200)).max(100), expiresAt: z.iso.datetime(),
  subject: z.string().regex(/^[1-9]\d{0,14}$/), universeId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  resourceOwners: z.array(ownerSchema).min(1).max(1000),
});
export type AnalyticsOAuthGrant = z.infer<typeof grantSchema>;
const tokenSchema = z.object({
  access_token: z.string().min(1).max(16384), refresh_token: z.string().min(1).max(16384),
  token_type: z.string().refine(value => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive().max(86400), scope: z.string().max(20000),
});
const resourcesSchema = z.object({ resource_infos: z.array(z.object({
  owner: ownerSchema,
  resources: z.object({ universe: z.object({ ids: z.array(z.string().max(100)).max(10000) }).optional() }).passthrough(),
})).max(1000) });

export function authorizationUrl(client: OAuthClient, attempt: SignInAttempt, redirectUri: string): string {
  const url = new URL(signInAuthorizationUrl(client, attempt, redirectUri));
  url.searchParams.set("scope", `openid profile ${ANALYTICS_SCOPE}`);
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

/** Fixed Roblox destinations, bounded responses, no implicit request retries or redirects. */
async function authRequest(url: string, body: URLSearchParams, options: OAuthOptions): Promise<unknown> {
  options.signal?.throwIfAborted();
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { method: "POST", redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body,
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  } catch { throw new OAuthError("unavailable"); }
  if (response.status === 400 || response.status === 401 || response.status === 403) throw new OAuthError("reconnect_required");
  if (!response.ok) throw new OAuthError("unavailable");
  const reader = response.body?.getReader();
  if (!reader) throw new OAuthError("unavailable");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 262144) { await reader.cancel(); throw new OAuthError("invalid_grant"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error instanceof OAuthError) throw error; throw new OAuthError("unavailable"); }
  finally { reader.releaseLock(); }
}
async function resourceOwners(client: OAuthClient, token: string, universeId: number, options: OAuthOptions) {
  const parsed = resourcesSchema.safeParse(await authRequest(RESOURCE_URL, new URLSearchParams({
    token, client_id: client.clientId, client_secret: client.clientSecret,
  }), options));
  if (!parsed.success) throw new OAuthError("invalid_grant");
  const owners = parsed.data.resource_infos.filter(info => info.resources.universe?.ids.includes(String(universeId))).map(info => info.owner);
  if (!owners.length) throw new OAuthError("reconnect_required");
  return owners;
}
function normalizedTokens(value: unknown, now: number) {
  const parsed = tokenSchema.safeParse(value);
  if (!parsed.success) throw new OAuthError("invalid_grant");
  const scopes = parsed.data.scope.split(/\s+/).filter(Boolean);
  if (!scopes.includes(ANALYTICS_SCOPE)) throw new OAuthError("reconnect_required");
  return { access_token: parsed.data.access_token, refresh_token: parsed.data.refresh_token, scopes,
    expiresAt: new Date(now + parsed.data.expires_in * 1000).toISOString() };
}

export async function exchangeAnalyticsAuthorization(client: OAuthClient, input: AnalyticsAuthorizationInput,
  target: { robloxUserId: number; universeId: number }, options: OAuthOptions = {}): Promise<AnalyticsOAuthGrant> {
  if (![target.robloxUserId, target.universeId].every(id => Number.isSafeInteger(id) && id > 0)) throw new OAuthError("invalid_grant");
  let captured: unknown;
  // completeSignIn performs nonce, issuer, audience, expiry and userinfo subject checks.
  const profile = await completeSignIn(client, input, { fetch: boundedSignInFetch(options), now: options.now,
    captureTokens: tokens => { captured = tokens; } });
  if (profile.userId !== target.robloxUserId) throw new OAuthError("invalid_grant");
  const tokens = normalizedTokens(captured, options.now ?? Date.now());
  const owners = await resourceOwners(client, tokens.access_token, target.universeId, options);
  return grantSchema.parse({ ...tokens, subject: String(profile.userId), universeId: target.universeId, resourceOwners: owners });
}

/** Reuse identity verification while bounding its token and userinfo responses too. */
function boundedSignInFetch(options: OAuthOptions): typeof fetch {
  return async (input, init) => {
    const response = await (options.fetch ?? fetch)(input, { ...init, redirect: "error", signal: options.signal
      ? AbortSignal.any([options.signal, init?.signal ?? AbortSignal.timeout(10000)]) : init?.signal });
    if (!response.ok) return response;
    const reader = response.body?.getReader(); if (!reader) throw new OAuthError("unavailable");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 262144) { await reader.cancel(); throw new OAuthError("invalid_grant"); } chunks.push(value); }
      return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
    } finally { reader.releaseLock(); }
  };
}

type GrantRow = { key_version: number; iv: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array;
  subject: string; reconnect_required: boolean; universe_id: string | number; roblox_user_id: string | number };
const context = (accountId: string, gameId: string) => `linked-game-oauth:${accountId}:${gameId}`;
async function writeGrant(sql: Sql, accountId: string, gameId: string, grant: AnalyticsOAuthGrant, key: Buffer) {
  const plain = JSON.stringify(grant);
  if (Buffer.byteLength(plain, "utf8") > 65536) throw new OAuthError("invalid_grant");
  const sealed = sealSecret(plain, context(accountId, gameId), key);
  await sql.query(`INSERT INTO linked_game_oauth(game_id,key_version,iv,ciphertext,tag,subject,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(game_id) DO UPDATE SET key_version=EXCLUDED.key_version,
    iv=EXCLUDED.iv,ciphertext=EXCLUDED.ciphertext,tag=EXCLUDED.tag,subject=EXCLUDED.subject,
    expires_at=EXCLUDED.expires_at,reconnect_required=false,updated_at=now()`,
  [gameId,sealed.keyVersion,sealed.iv,sealed.ciphertext,sealed.tag,grant.subject,grant.expiresAt]);
  return sealed.ciphertext;
}
export async function saveGameOAuthGrant(database: Database, accountId: string, gameId: string, grant: AnalyticsOAuthGrant, secretsKey: Buffer): Promise<void> {
  const parsed = grantSchema.safeParse(grant);
  if (!parsed.success || !parsed.data.scopes.includes(ANALYTICS_SCOPE) || Date.parse(parsed.data.expiresAt) <= Date.now()) throw new OAuthError("invalid_grant");
  await database.transaction(async sql => {
    const { rows } = await sql.query<{ universe_id: string | number; roblox_user_id: string | number }>(
      `SELECT g.universe_id,a.roblox_user_id FROM linked_games g JOIN accounts a ON a.id=g.account_id
       WHERE g.id=$1 AND g.account_id=$2 FOR UPDATE OF g`, [gameId,accountId]);
    if (!rows[0] || String(rows[0].roblox_user_id) !== grant.subject || Number(rows[0].universe_id) !== grant.universeId) throw new OAuthError("invalid_grant");
    await writeGrant(sql, accountId, gameId, parsed.data, secretsKey);
  });
}

export async function openGameOAuthCredential(database: Database, accountId: string, gameId: string, key: Buffer,
  options: OAuthOptions = {}): Promise<{ accessToken: string } | null> {
  const client = options.client ?? oauthClient();
  const result = await database.transaction(async sql => {
    // Reconnect and disconnect lock the parent game before its credential.
    // Use the same order before holding a rotating refresh token.
    const game = await sql.query("SELECT id FROM linked_games WHERE id=$1 AND account_id=$2 FOR UPDATE", [gameId,accountId]);
    if (!game.rows[0]) return null;
    const { rows } = await sql.query<GrantRow>(`SELECT o.key_version,o.iv,o.ciphertext,o.tag,o.subject,o.reconnect_required,
      g.universe_id,a.roblox_user_id FROM linked_game_oauth o JOIN linked_games g ON g.id=o.game_id
      JOIN accounts a ON a.id=g.account_id WHERE g.id=$1 AND g.account_id=$2 FOR UPDATE OF o`, [gameId,accountId]);
    const row = rows[0]; if (!row) return null;
    if (row.reconnect_required) return { error: new OAuthError("reconnect_required") };
    const mark = async (error: OAuthError) => { await sql.query("UPDATE linked_game_oauth SET reconnect_required=true,updated_at=now() WHERE game_id=$1", [gameId]); return { error }; };
    let grant: AnalyticsOAuthGrant;
    try { grant = grantSchema.parse(JSON.parse(openSecret({ keyVersion:row.key_version,iv:row.iv,ciphertext:row.ciphertext,tag:row.tag },context(accountId,gameId),key))); }
    catch { return mark(new OAuthError("reconnect_required")); }
    if (grant.subject !== row.subject || grant.subject !== String(row.roblox_user_id) || grant.universeId !== Number(row.universe_id)
      || !grant.scopes.includes(ANALYTICS_SCOPE)) return mark(new OAuthError("reconnect_required"));
    if (!client) return { error: new OAuthError("unavailable") };
    let ciphertext = row.ciphertext;
    // A bounded Analytics Query operation can spend almost four minutes polling.
    // Leave five minutes for one complete query before the access token expires.
    if (Date.parse(grant.expiresAt) <= (options.now ?? Date.now()) + 300000) {
      try {
        const tokens = normalizedTokens(await authRequest(ROBLOX_OAUTH.token, new URLSearchParams({ grant_type:"refresh_token",
          refresh_token:grant.refresh_token,client_id:client.clientId,client_secret:client.clientSecret }),options),options.now ?? Date.now());
        grant = { ...grant, ...tokens };
        ciphertext = await writeGrant(sql,accountId,gameId,grant,key);
      } catch { return mark(new OAuthError("reconnect_required")); }
    }
    return { grant, ciphertext };
  });
  if (!result) return null;
  if ("error" in result) throw result.error;
  // Rotation is committed before this network request: resources failures cannot roll it back.
  try { await resourceOwners(client!,result.grant.access_token,result.grant.universeId,options); }
  catch (error) {
    if (error instanceof OAuthError && error.kind !== "unavailable") {
      // Do not mark a newer relink/refresh based on an older credential's response.
      await database.query(`UPDATE linked_game_oauth SET reconnect_required=true,updated_at=now()
        WHERE game_id=$1 AND ciphertext=$2`, [gameId,result.ciphertext]);
    }
    throw error;
  }
  return { accessToken:result.grant.access_token };
}
