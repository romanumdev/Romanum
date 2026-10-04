import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readAccount } from "@/lib/accounts/session";
import { callbackUrl, oauthClient } from "@/lib/accounts/roblox-oauth";
import { signAttempt } from "@/lib/accounts/sign-in-cookie";
import { historyDatabase } from "@/lib/history/database";
import { isCrossSite } from "@/lib/guest";
import { requestOrigin, verificationResponse, verifyTurnstile } from "@/lib/turnstile";
import { secretsKey } from "@/lib/secrets";
import { analyticsOAuthEnabled, ANALYTICS_CONNECTION_COOKIE, connectionUniverseId, newConnectionAttempt } from "@/lib/linked-games/connection";
import { authorizationUrl } from "@/lib/linked-games/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET() { redirect("/profile/settings/games#link-game"); }

/** Explicit optional authorization, separate from ordinary account sign-in. */
export async function POST(request: Request) {
  if (isCrossSite(request) || (request.headers.has("origin") && request.headers.get("origin") !== requestOrigin(request))) return Response.json({ error: "Request rejected." }, { status: 403, headers });
  const account = await readAccount();
  if (!account) return Response.json({ error: "Sign in to connect a game." }, { status: 401, headers });
  if (!analyticsOAuthEnabled() || !(await historyDatabase().catch(() => null))) return Response.json({ error: "Connecting through Roblox is being set up." }, { status: 503, headers });
  const universeId = connectionUniverseId(await request.json().catch(() => null));
  if (universeId === null) return Response.json({ error: "Enter the game's universe ID." }, { status: 400, headers });
  try { await verifyTurnstile(request, "roblox_signin"); }
  catch (error) { return verificationResponse(error) ?? Response.json({ error: "Connection unavailable." }, { status: 503, headers }); }
  const attempt = newConnectionAttempt(account.id, universeId);
  (await cookies()).set(ANALYTICS_CONNECTION_COOKIE.name, signAttempt(attempt, await secretsKey()), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: ANALYTICS_CONNECTION_COOKIE.path, maxAge: ANALYTICS_CONNECTION_COOKIE.maxAge });
  return Response.json({ url: authorizationUrl(oauthClient()!, attempt, callbackUrl(request.url)) }, { headers });
}
