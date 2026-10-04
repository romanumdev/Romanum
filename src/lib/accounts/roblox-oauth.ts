import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

// Sign in with Roblox: the OAuth 2.0 authorization code flow with PKCE, state and an OpenID Connect nonce, on
// Roblox's documented endpoints (create.roblox.com/docs/cloud/auth/oauth2-reference). Romanum asks only for
// `openid profile`, reads who signed in, and keeps none of Roblox's tokens.

export const ROBLOX_OAUTH = {
  issuer: "https://apis.roblox.com/oauth/",
  authorize: "https://apis.roblox.com/oauth/v1/authorize",
  token: "https://apis.roblox.com/oauth/v1/token",
  userinfo: "https://apis.roblox.com/oauth/v1/userinfo",
} as const;

const SCOPES = "openid profile";
const TIMEOUT_MS = 10_000;
/** Allowance for clock differences when checking the ID token's expiry. */
const CLOCK_SKEW_SECONDS = 120;

export type OAuthClient = { clientId: string; clientSecret: string };

/** The Roblox OAuth app registered for Romanum, or null when sign-in isn't set up. */
export function oauthClient(env: Record<string, string | undefined> = process.env): OAuthClient | null {
  const clientId = env.ROBLOX_CLIENT_ID?.trim();
  const clientSecret = env.ROBLOX_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** One sign-in attempt's secrets, kept in a short-lived cookie until Roblox sends the person back. */
export type SignInAttempt = { state: string; verifier: string; nonce: string; next: string };

const randomValue = () => randomBytes(32).toString("base64url");

/** A path on this site to return to after signing in. Anything else, including another site, becomes /profile. */
export function safeNextPath(value: string | null | undefined): string {
  return typeof value === "string" && value.length <= 200 && /^\/(?![/\\])[\x21-\x7e]*$/.test(value) ? value : "/profile";
}

export function newSignInAttempt(next: string | null | undefined): SignInAttempt {
  return { state: randomValue(), verifier: randomValue(), nonce: randomValue(), next: safeNextPath(next) };
}

/** The cookie that carries a sign-in attempt to Roblox's redirect back, and the only path it's sent to. */
export const SIGN_IN_COOKIE = { name: "romanum_sign_in", path: "/auth/roblox", maxAge: 600 } as const;

const attemptValue = z.object({
  state: z.string().regex(/^[\w-]{43}$/),
  verifier: z.string().regex(/^[\w-]{43}$/),
  nonce: z.string().regex(/^[\w-]{43}$/),
  next: z.string().max(200),
});

export const encodeAttempt = (attempt: SignInAttempt) => Buffer.from(JSON.stringify(attempt)).toString("base64url");

export function decodeAttempt(value: string | null | undefined): SignInAttempt | null {
  if (!value || value.length > 1000) return null;
  try {
    const attempt = attemptValue.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return { ...attempt, next: safeNextPath(attempt.next) };
  } catch {
    return null;
  }
}

/** Where Roblox sends people back to. It must exactly match a redirect URL registered on the OAuth app. */
export function callbackUrl(requestUrl: string, env: Record<string, string | undefined> = process.env): string {
  return env.ROBLOX_REDIRECT_URI?.trim() || new URL("/auth/roblox/callback", requestUrl).toString();
}

/** Where to send the person to sign in on Roblox. */
export function authorizationUrl(client: OAuthClient, attempt: SignInAttempt, redirectUri: string): string {
  const url = new URL(ROBLOX_OAUTH.authorize);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    response_type: "code",
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export type RobloxProfile = { userId: number; username: string; displayName: string; pictureUrl: string | null };

/** Why a sign-in failed, for logs. Never includes a code or token. */
export class SignInError extends Error {
  reason: string;
  constructor(reason: string) {
    super(`Roblox sign-in failed: ${reason}.`);
    this.name = "SignInError";
    this.reason = reason;
  }
}

const tokenResponse = z.object({ access_token: z.string().min(1).max(16384), id_token: z.string().min(1).max(32768) }).passthrough();
export type CapturedOAuthTokens = z.infer<typeof tokenResponse>;
const idTokenClaims = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  nonce: z.string().optional(),
  // A Roblox user ID, small enough to stay exact as a JavaScript number.
  sub: z.string().regex(/^[1-9]\d{0,14}$/),
});
const userInfo = z.object({
  sub: z.string(),
  name: z.string().nullish(),
  nickname: z.string().nullish(),
  preferred_username: z.string().nullish(),
  picture: z.string().nullish(),
});

function readIdToken(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new SignInError("malformed ID token");
  try {
    return idTokenClaims.parse(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    throw new SignInError("malformed ID token");
  }
}

const trimmed = (value: string | null | undefined, max: number) => {
  const text = value?.trim();
  return text ? text.slice(0, max) : null;
};

/** Roblox serves headshots from its CDN over HTTPS; anything else isn't shown. */
function headshotUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 500) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "rbxcdn.com" || url.hostname.endsWith(".rbxcdn.com")) ? url.toString() : null;
  } catch {
    return null;
  }
}

async function send(request: typeof fetch, url: string, init: RequestInit, step: string): Promise<unknown> {
  let response: Response;
  try {
    response = await request(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new SignInError(`${step} unreachable`);
  }
  if (!response.ok) throw new SignInError(`${step} returned ${response.status}`);
  return response.json().catch(() => {
    throw new SignInError(`${step} returned invalid JSON`);
  });
}

/**
 * Exchanges the authorization code for tokens and returns who signed in. The ID token comes straight from Roblox's
 * token endpoint over TLS, which OpenID Connect accepts in place of checking its signature (Core 3.1.3.7). Its
 * issuer, audience, expiry and nonce are still checked, and its subject must match Roblox's userinfo response.
 */
export async function completeSignIn(
  client: OAuthClient,
  input: { code: string; verifier: string; nonce: string; redirectUri: string },
  options: { fetch?: typeof fetch; now?: number; captureTokens?: (tokens: CapturedOAuthTokens, profile: RobloxProfile) => void | Promise<void> } = {},
): Promise<RobloxProfile> {
  const request = options.fetch ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  const tokens = tokenResponse.safeParse(
    await send(request, ROBLOX_OAUTH.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body }, "token endpoint"),
  );
  if (!tokens.success) throw new SignInError("unexpected token response");

  const claims = readIdToken(tokens.data.id_token);
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (claims.iss !== ROBLOX_OAUTH.issuer) throw new SignInError("ID token from an unexpected issuer");
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(client.clientId)) throw new SignInError("ID token for another app");
  if (claims.exp + CLOCK_SKEW_SECONDS < now) throw new SignInError("expired ID token");
  if (claims.nonce !== input.nonce) throw new SignInError("ID token nonce mismatch");

  const info = userInfo.safeParse(
    await send(request, ROBLOX_OAUTH.userinfo, { headers: { authorization: `Bearer ${tokens.data.access_token}`, accept: "application/json" } }, "userinfo endpoint"),
  );
  if (!info.success) throw new SignInError("unexpected userinfo response");
  if (info.data.sub !== claims.sub) throw new SignInError("userinfo for another user");

  const username = trimmed(info.data.preferred_username, 100) ?? claims.sub;
  const profile: RobloxProfile = {
    userId: Number(claims.sub),
    username,
    displayName: trimmed(info.data.name, 100) ?? trimmed(info.data.nickname, 100) ?? username,
    pictureUrl: headshotUrl(info.data.picture),
  };
  // Optional server-only capture runs only after the identity and nonce checks.
  await options.captureTokens?.(tokens.data, profile);
  return profile;
}
