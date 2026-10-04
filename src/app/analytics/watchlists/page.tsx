import type { Metadata } from "next";
import { AnalyticsWorkflowNavigation } from "@/components/analytics/navigation";
import { WatchlistsWorkspace } from "@/components/watchlists/watchlists-workspace";
export const metadata:Metadata={title:"Private game watches | Romanum",robots:{index:false,follow:false}};
export default function WatchlistsPage(){return <><h1 className="text-2xl font-semibold tracking-tight">Private game watches</h1><p className="mt-3 max-w-3xl text-sm leading-6 text-fg-muted">Save public games and peers, configure meaningful player changes, and review alerts here. Collection shares a bounded five-minute public collector: saving requests coverage, which depends on capacity and upstream availability. Your saved lists and notifications are private to your account or this browser’s guest identity.</p><AnalyticsWorkflowNavigation current="watchlists"/><WatchlistsWorkspace/></>;}
