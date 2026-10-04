import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { newSignInAttempt, oauthClient, type SignInAttempt } from "../accounts/roblox-oauth.ts";
import type { Account } from "../accounts/store.ts";
import type { Database } from "../history/database.ts";
import { exchangeAnalyticsAuthorization, OAuthError, type OAuthOptions } from "./oauth.ts";
import { saveOAuthLinkedGame } from "./store.ts";

export const ANALYTICS_CONNECTION_COOKIE = { name: "romanum_analytics_connect", path: "/auth/roblox", maxAge: 600 } as const;
const SETTINGS = "/profile/settings/games";
const input = z.object({ universeId: z.string().trim().regex(/^[1-9]\d{0,15}$/) }).strict();

/** Enabling this prepared flow is a separate app-scope/configuration decision. */
export function analyticsOAuthEnabled(environment: Record<string, string | undefined> = process.env): boolean {
  return environment.ROBLOX_ANALYTICS_OAUTH_ENABLED === "true" && oauthClient(environment) !== null;
}

/** No client credentials or user API keys are accepted by the connection start. */
export function connectionUniverseId(value: unknown): number | null {
  const parsed = input.safeParse(value);
  const id = parsed.success ? Number(parsed.data.universeId) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function newConnectionAttempt(accountId: string, universeId: number): SignInAttempt {
  return newSignInAttempt(`${SETTINGS}?oauthAccount=${accountId}&oauthGame=${universeId}`);
}

/** The signed attempt binds this grant to the account and requested game. */
export function connectionTarget(attempt: SignInAttempt): { accountId: string; universeId: number } | null {
  const url = new URL(attempt.next, "https://romanum.dev");
  const accountId = url.searchParams.get("oauthAccount");
  const universeId = connectionUniverseId({ universeId: url.searchParams.get("oauthGame") });
  if (url.pathname !== SETTINGS || [...url.searchParams.keys()].length !== 2 || !z.uuid().safeParse(accountId).success || universeId === null) return null;
  return { accountId: accountId!, universeId };
}

const same = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const result = (status: string) => `${SETTINGS}?connection=${status}#link-game`;

/** Does not sign in, replace the browser session, delete keys or revoke Roblox tokens. */
export async function completeAnalyticsConnection(requestUrl: string, attempt: SignInAttempt | null, account: Account | null, database: Database, key: Buffer, options: OAuthOptions & { redirectUri: string }): Promise<string> {
  if (!attempt) return result("expired");
  const target = connectionTarget(attempt), params = new URL(requestUrl).searchParams;
  const state = params.get("state");
  if (!target || !state || !same(state, attempt.state)) return result("failed");
  if (!account || account.id !== target.accountId) return result("wrong_account");
  if (params.get("error")) return result(params.get("error") === "access_denied" ? "cancelled" : "failed");
  const code = params.get("code"), client = options.client ?? oauthClient();
  if (!code || code.length > 2000) return result("failed");
  if (!client) return result("unavailable");
  try {
    const grant = await exchangeAnalyticsAuthorization(client, { code, verifier: attempt.verifier, nonce: attempt.nonce, redirectUri: options.redirectUri }, { robloxUserId: account.robloxUserId, universeId: target.universeId }, options);
    await saveOAuthLinkedGame(database, { accountId: account.id, universeId: target.universeId, grant }, key);
    return result("connected");
  } catch (error) {
    return result(error instanceof OAuthError ? error.kind === "unavailable" ? "unavailable" : "not_authorized" : "failed");
  }
}
