"use client";
import Link from "next/link";
import { useState } from "react";

export function SaveWatchlistButton({universeId,name}:{universeId:number;name?:string}) {
  const [status,setStatus] = useState<"idle"|"saving"|"saved">("idle");
  const [error,setError] = useState("");
  async function save() {
    setStatus("saving");setError("");
    try {
      const response=await fetch("/api/watchlists",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({universeId,name:(name??`Game ${universeId}`).slice(0,100)})});
      const data=await response.json();
      if(!response.ok) throw new Error(data.error??"Unable to save this game.");
      setStatus("saved");
    }catch(error){setError(error instanceof Error?error.message:"Unable to save this game.");setStatus("idle");}
  }
  return <div className="mt-3 text-sm"><button type="button" onClick={save} disabled={status!=="idle"} className="min-h-11 rounded-lg border border-line px-3 hover:bg-surface disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-white">{status==="saving"?"Saving…":status==="saved"?"Saved privately":"Save game to watchlist"}</button>{status==="saved"&&<Link href="/analytics/watchlists" className="ml-3 underline">Configure peers and alerts</Link>}{error&&<p role="alert" className="mt-2 text-fg-muted">{error}</p>}</div>;
}
