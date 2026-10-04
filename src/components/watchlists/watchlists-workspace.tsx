"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { WatchInput, Watchlist } from "@/lib/watchlists/store";
import type { WatchEvidence } from "@/lib/watchlists/rules";
type Notification = {id:string;watchlist_id:string;observed_at:string;title:string;evidence:WatchEvidence;acknowledged_at:string|null};
const field="mt-1 block min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-fg focus-visible:outline-2 focus-visible:outline-white";
const action="min-h-11 rounded-lg border border-line px-3 text-sm hover:bg-surface focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50";
async function request(url:string,method="GET",payload?:unknown) {
  const response=await fetch(url,{method,cache:"no-store",...(payload?{headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}:{})});
  const data=await response.json();if(!response.ok) throw new Error(data.error??"Watchlists unavailable.");return data;
}
function WatchForm({watch,onSave,onCancel,busy,contextual=false}:{contextual?:boolean;watch?:Watchlist;onSave:(settings:WatchInput)=>Promise<void>;onCancel?:()=>void;busy:boolean}) {
  const [error,setError]=useState("");
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setError("");const data=new FormData(event.currentTarget);
    const peers=String(data.get("peers")??"").trim();
    const settings={name:String(data.get("name")),universeId:Number(data.get("universe")),peerIds:peers?peers.split(",").map(id=>Number(id.trim())):[],enabled:data.get("enabled")==="on",direction:String(data.get("direction")) as WatchInput["direction"],thresholdPercent:Number(data.get("threshold")),minimumPlayers:Number(data.get("minimum")),windowMinutes:Number(data.get("window")) as 30|60};
    if(!Number.isSafeInteger(settings.universeId)||settings.universeId<=0||settings.peerIds.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(settings.peerIds).size!==settings.peerIds.length||settings.peerIds.includes(settings.universeId)||settings.peerIds.length>5){setError("Use a positive universe ID and up to five distinct peer universe IDs.");return;}
    try{await onSave(settings);}catch(error){setError(error instanceof Error?error.message:"Unable to save.");}
  }
  return <form onSubmit={submit} className="mt-4 space-y-4">
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm">Direction<select name="direction" defaultValue={watch?.direction??"either"} className={field}><option value="either">Either direction</option><option value="up">Increase</option><option value="down">Decrease</option></select></label>
      <label className="text-sm">Alert threshold ({watch?.peerIds.length?"percentage points vs peers":"%"})<input name="threshold" type="number" min={5} max={500} required defaultValue={watch?.thresholdPercent??20} className={field}/></label>
    </div>
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={watch?.enabled??true}/>Enable in-app alerts</label>
    <p className="text-xs text-fg-muted">Alerts compare recorded players with yesterday. Missing observations delay alerts.</p>
    <details open={!watch} className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-sm">Advanced settings</summary>
      <div className="mt-3 space-y-4">
        {contextual ? <><input type="hidden" name="name" value={watch?.name??""}/><input type="hidden" name="universe" value={watch?.universeId??""}/></> : <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">Name<input name="name" required maxLength={100} defaultValue={watch?.name} className={field}/></label><label className="text-sm">Public game universe ID<input name="universe" type="number" min={1} max={Number.MAX_SAFE_INTEGER} required defaultValue={watch?.universeId} className={field}/></label></div>}
        <label className="block text-sm">Peer universe IDs (optional, up to five)<input name="peers" maxLength={100} defaultValue={watch?.peerIds.join(", ")} className={field}/></label>
        <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">Minimum players<input name="minimum" type="number" min={1} max={1_000_000} required defaultValue={watch?.minimumPlayers??25} className={field}/></label><label className="text-sm">Matched window<select name="window" defaultValue={watch?.windowMinutes??30} className={field}><option value={30}>30 minutes</option><option value={60}>60 minutes</option></select></label></div>
        <p className="text-xs leading-5 text-fg-muted">Compare mean concurrent players with the same UTC time yesterday. With peers, subtract their mean percentage change and apply the threshold in percentage points. Each baseline and the game&apos;s absolute change must meet the minimum player count. Every five-minute pair must be present. Missing samples never count as zero.</p>
      </div>
    </details>
    {error&&<p role="alert" className="text-sm text-fg-muted">{error}</p>}
    <div className="flex gap-2"><button disabled={busy} className={action}>{busy?"Saving…":watch?"Save settings":"Save game and rule"}</button>{onCancel&&<button type="button" onClick={onCancel} className={action}>Cancel</button>}</div>
  </form>;
}
export function WatchlistsWorkspace({ universeId }: { universeId?: number }) {
  const [watches,setWatches]=useState<Watchlist[]>([]);const [notifications,setNotifications]=useState<Notification[]>([]);const [error,setError]=useState("");const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false);const [editing,setEditing]=useState<string|null>(null);const [creating,setCreating]=useState(false);
  const refresh=useCallback(async()=>{try{const [saved,alerts]=await Promise.all([request("/api/watchlists"),request("/api/watchlists/notifications")]);setWatches(saved.watchlists);setNotifications(alerts.notifications);setError("");}catch(error){setError(error instanceof Error?error.message:"Watchlists unavailable.");}finally{setLoading(false);}},[]);
  useEffect(()=>{
    let active=true;
    Promise.all([request("/api/watchlists"),request("/api/watchlists/notifications")]).then(([saved,alerts])=>{if(active){setWatches(saved.watchlists);setNotifications(alerts.notifications);setError("");}}).catch(error=>{if(active)setError(error instanceof Error?error.message:"Watchlists unavailable.");}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[]);
  useEffect(()=>{
    const update=()=>{void refresh();};
    window.addEventListener("romanum:watches-updated",update);
    return ()=>window.removeEventListener("romanum:watches-updated",update);
  },[refresh]);
  async function save(settings:WatchInput,watch?:Watchlist){setBusy(true);try{await request(watch?`/api/watchlists/${watch.id}`:"/api/watchlists",watch?"PUT":"POST",watch?{revision:watch.revision,settings}:settings);setEditing(null);setCreating(false);await refresh();window.dispatchEvent(new Event("romanum:watches-updated"));}finally{setBusy(false);}}
  async function toggle(watch:Watchlist){
    const {name,universeId,peerIds,direction,thresholdPercent,minimumPlayers,windowMinutes}=watch;
    try{await save({name,universeId,peerIds,direction,thresholdPercent,minimumPlayers,windowMinutes,enabled:!watch.enabled},watch);}catch(error){setError(error instanceof Error?error.message:"Unable to update alerts.");}
  }
  async function remove(id:string){setBusy(true);try{await request(`/api/watchlists/${id}`,"DELETE");await refresh();window.dispatchEvent(new Event("romanum:watches-updated"));}catch(error){setError(error instanceof Error?error.message:"Unable to remove watchlist.");}finally{setBusy(false);}}
  async function acknowledge(id:string){setBusy(true);try{await request(`/api/watchlists/notifications/${id}`,"POST");await refresh();}catch(error){setError(error instanceof Error?error.message:"Unable to acknowledge notification.");}finally{setBusy(false);}}
  const visibleWatches = watches.filter(watch => universeId === undefined || watch.universeId === universeId);
  const visibleNotifications = notifications.filter(notification => universeId === undefined || visibleWatches.some(watch => watch.id === notification.watchlist_id));
  return <div className="mt-4 space-y-4">
    <div className="flex flex-wrap gap-2">{universeId === undefined && <button className={action} onClick={()=>setCreating(!creating)} disabled={busy}>{creating?"Close new watch":"Watch a game"}</button>}<button className={action} onClick={refresh} disabled={busy}>Refresh watches and alerts</button></div>
    {error&&<p role="alert" className="text-sm text-fg-muted">{error}</p>}{loading&&<p role="status" className="text-sm text-fg-muted">Loading private watches…</p>}
    {creating&&<section className="rounded-xl border border-line p-4"><h2 className="font-medium">Save game and peers privately</h2><WatchForm busy={busy} onSave={settings=>save(settings)}/></section>}
    {!loading&&!error&&!visibleWatches.length&&<p className="text-sm text-fg-muted">No saved games yet. Save from a public game page or enter its universe ID here. Guests can save without spending credits. Guest work stays with this browser&apos;s signed identity.</p>}
    <div className="space-y-4">{visibleWatches.map(watch=><section key={watch.id} className="rounded-xl border border-line p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-medium"><Link href={`/analytics/games/${watch.universeId}`} className="underline">{watch.name}</Link></h2><p className="mt-1 text-xs text-fg-muted">{watch.enabled?"Alerts enabled":"Alerts paused"} · {watch.coverage} · {watch.windowMinutes}-minute matched window · {watch.thresholdPercent}{watch.peerIds.length?"pp versus peers":"%"} threshold</p>{watch.peerIds.length>0&&<p className="mt-2 text-xs text-fg-muted">Peers: {watch.peerIds.map((id,index)=><span key={id}>{index>0?", ":""}<Link href={`/analytics/games/${id}`} className="underline">{id}</Link></span>)}</p>}<p className="mt-2 max-w-3xl text-sm text-fg-muted">{watch.detail}</p></div><div className="flex flex-wrap gap-2"><button className={action} disabled={busy} aria-pressed={watch.enabled} onClick={()=>toggle(watch)}>{watch.enabled?"Pause alerts":"Enable alerts"}</button><button className={action} disabled={busy} onClick={()=>setEditing(editing===watch.id?null:watch.id)}>Settings</button><button className={action} disabled={busy} onClick={()=>remove(watch.id)}>Remove</button></div></div>{editing===watch.id&&<WatchForm key={watch.revision} contextual={universeId !== undefined} watch={watch} busy={busy} onCancel={()=>setEditing(null)} onSave={settings=>save(settings,watch)}/>}</section>)}</div>
    <section className="border-t border-line pt-6"><h2 className="text-lg font-medium">Alerts</h2><p className="mt-2 text-xs text-fg-muted">The most recent 100 notifications remain until their watchlist is removed. Acknowledging marks a notification read. The same threshold episode emits once and rearms only after a complete window falls below 80% of the threshold.</p>{!visibleNotifications.length&&<p className="mt-4 text-sm text-fg-muted">No notifications yet. A new saved game needs complete matched windows, including yesterday’s observations.</p>}<div className="mt-4 space-y-3">{visibleNotifications.map(notification=><article key={notification.id} className="rounded-xl border border-line p-4"><h3 className="text-sm font-medium">{notification.title}</h3><p className="mt-1 text-xs text-fg-muted">Observed {new Date(notification.observed_at).toLocaleString()} · {notification.acknowledged_at?"Acknowledged":"Unread"}</p><p className="mt-2 text-sm text-fg-muted">Mean public players: {notification.evidence.baselineMean.toFixed(1)} → {notification.evidence.currentMean.toFixed(1)} ({notification.evidence.changePercent.toFixed(1)}%). {notification.evidence.peerChangePercent!==null?`Peers: ${notification.evidence.peerChangePercent.toFixed(1)}%; difference: ${notification.evidence.signalPercent.toFixed(1)} percentage points.`:""}</p><p className="mt-2 text-xs text-fg-muted">{notification.evidence.pairs} paired five-minute observations · current {notification.evidence.currentFrom} to {notification.evidence.currentTo} · yesterday {notification.evidence.baselineFrom} to {notification.evidence.baselineTo}. These public changes do not establish causes, revenue or retention.</p>{!notification.acknowledged_at&&<button className={`${action} mt-3`} disabled={busy} onClick={()=>acknowledge(notification.id)}>Acknowledge</button>}</article>)}</div></section>
  </div>;
}
