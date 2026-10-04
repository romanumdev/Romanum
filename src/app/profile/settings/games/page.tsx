import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { LinkedGames } from "@/components/account/linked-games";
import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { analyticsOAuthEnabled } from "@/lib/linked-games/connection";
import { linkedGameViews } from "@/lib/linked-games/view";

export const metadata: Metadata = { title: "Game settings" };
export const dynamic = "force-dynamic";

const CONNECTION_NOTICES: Record<string, string> = {
  connected: "Game connected through Roblox.", cancelled: "Connection cancelled. Your existing game connection and data were kept.", failed: "Could not connect through Roblox. Try again.", unavailable: "Roblox game authorization is not available right now. Your existing data was kept.", wrong_account: "Use the same Roblox account you signed in with to authorize this game.", not_authorized: "Roblox did not authorize analytics access for this game.", expired: "The connection attempt expired. Try again.",
};

export default async function GameSettingsPage({ searchParams }: { searchParams: Promise<{ connection?: string }> }) {
  const { connection } = await searchParams;
  const notice = connection ? CONNECTION_NOTICES[connection] : undefined;
  const account = await readAccount();
  const database = account ? await historyDatabase().catch(() => null) : null;
  const games = account && database ? await linkedGameViews(database, account.id) : null;
  return <>
    <Link href="/profile#games" className="inline-flex min-h-11 items-center gap-2 text-sm text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-fg/70"><ArrowLeft className="size-4" aria-hidden="true" />Your games</Link>
    <header className="mt-5 max-w-2xl">
      <p className="text-xs text-fg-muted">Settings</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Game data & sharing</h1>
      <p className="mt-3 text-sm leading-relaxed text-fg-muted">Manage Roblox connections, collection and AI access for each experience. Your analytics stay private unless you choose to contribute them.</p>
    </header>
    {notice && <p role="status" className="mt-4 text-sm text-fg-muted">{notice}</p>}
    {games ? <LinkedGames initial={games} settings oauthAvailable={analyticsOAuthEnabled()} /> : <p role="status" className="mt-6 rounded-xl border border-line p-5 text-sm text-fg-muted">{account ? "Game settings are unavailable. Try again later." : "Sign in with Roblox to manage game connections."}{!account && <Link href="/profile" className="ml-2 text-fg underline">Sign in</Link>}</p>}
  </>;
}
