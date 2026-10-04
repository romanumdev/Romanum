"use client";
import { useState } from "react";
import { EChart } from "@/components/charts/echart";
import type { createHistoryComparisonService } from "@/lib/analytics/history-comparison";
import type { createHistoryPeerService } from "@/lib/analytics/peer-selection";
type Comparison = Awaited<ReturnType<ReturnType<typeof createHistoryComparisonService>["compare"]>>;
type Peers = Awaited<ReturnType<ReturnType<typeof createHistoryPeerService>["peers"]>>;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const control = "rounded border border-line bg-bg px-3 py-2 text-sm";
export function CompetitorComparison({ initialUniverseIds = [], initialDays = 7 }: { initialUniverseIds?: number[]; initialDays?: number }) {
  const [ids, setIds] = useState(initialUniverseIds.join(",")), [days, setDays] = useState(initialDays);
  const [result, setResult] = useState<Comparison | null>(null), [peers, setPeers] = useState<Peers | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [indexed, setIndexed] = useState(false);
  async function read(kind: "compare" | "peers") {
    setBusy(true); setError(""); setResult(null); setPeers(null);
    try {
      const normalized = ids.split(",").map(id => id.trim()).join(",");
      const response = await fetch(`/api/history/${kind}?${kind === "compare" ? "universeIds=" + normalized : "universeId=" + normalized.split(",")[0]}&days=${days}`);
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      if (kind === "compare") setResult(data); else setPeers(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not read history."); }
    finally { setBusy(false); }
  }
  const name = (id: number) => result?.games.find(game => game.universeId === id)?.game?.name ?? `Universe ${id}`;
  return <section className="mt-6 space-y-5" aria-label="Public competitor comparison">
    <p className="text-sm text-fg-muted">Compare recorded concurrent players for 2-5 public games over the same UTC window. Find peers using the first ID. No account required.</p>
    <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void read("compare"); }}>
      <label className="flex flex-col gap-1 text-sm">Universe IDs, separated by commas<input className={control} value={ids} onChange={event => setIds(event.target.value)} placeholder="123,456" required /></label>
      <label className="flex flex-col gap-1 text-sm">Days<input type="number" className={`${control} w-20`} min={1} max={30} value={days} onChange={event => setDays(Number(event.target.value))} required /></label>
      <button className={control} disabled={busy}>Compare</button><button className={control} disabled={busy || !ids.trim()} type="button" onClick={() => void read("peers")}>Suggest peers</button>
    </form>
    {busy && <p role="status">Reading recorded observations...</p>}{error && <p role="alert">{error}</p>}
    {peers && <div className="space-y-3"><p>{peers.target ? `Peers for ${peers.target.name}` : "No recorded chart sample for this game in this period."} {peers.slot && `Collection run: ${peers.slot}`}</p>
      {peers.peers.map(peer => <div key={peer.universeId} className="rounded border border-line p-3"><button className="underline" onClick={() => { setIds(`${peers.target!.universeId},${peer.universeId}`); setPeers(null); }}>{peer.name} - compare</button><p className="text-sm">{peer.genre ?? "Unknown genre"} / {peer.playing.toLocaleString()} recorded CCU / {peer.reason}</p><p className="text-xs">Retrieved {peer.observedAt}; {peer.placements.map(item => `${item.chart} #${item.rank}`).join(", ")}</p></div>)}
      {peers.limitations.map(item => <p key={item} className="text-xs text-fg-muted">{item}</p>)}</div>}
    {result && <>
      <p className="text-sm">Requested: {result.from} to {result.to}. Shared observations: {result.coverage.allGamesPairedSlots}/{result.coverage.requestedSlots} ({pct(result.coverage.allGamesPairedFractionOfRequestedSlots)}). {result.status.replaceAll("_", " ")}.</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Game</th><th>Valid samples</th><th>Requested coverage</th><th>Recorded retrieval span</th></tr></thead><tbody>{result.games.map(game => <tr key={game.universeId}><td className="py-2">{name(game.universeId)}</td><td>{game.coverage.validSamples}; {game.coverage.gaps} returned gaps</td><td>{pct(game.coverage.validFractionOfRequestedSlots)}</td><td>{game.recordedSpan ? `${game.recordedSpan.from} to ${game.recordedSpan.to}` : "No observations"}</td></tr>)}</tbody></table></div>
      {result.sameWindow.status === "compared" ? <>
        <label className="text-sm"><input type="checkbox" checked={indexed} onChange={event => setIndexed(event.target.checked)} /> Show index (first shared observation = 100)</label>
        <EChart label={indexed ? "Recorded concurrent players indexed from the first shared observation" : "Recorded concurrent players on shared collection slots"} height={320} build={() => ({ tooltip: { trigger: "axis" }, legend: { data: result.sameWindow.games.map(game => name(game.universeId)) }, grid: { left: 65, right: 20, top: 40, bottom: 50 }, xAxis: { type: "time" }, yAxis: { type: "value", name: indexed ? "Index" : "CCU" }, series: result.sameWindow.games.map(game => {
          const values = new Map(game.series!.map(point => [point.slot, indexed ? point.index : point.playing]));
          const step = result.intervalSeconds * 1000, start = Math.floor(Date.parse(result.from) / step) * step;
          return { name: name(game.universeId), type: "line", connectNulls: false, showSymbol: true, data: Array.from({ length: result.coverage.requestedSlots }, (_, index) => { const time = start + index * step; return [time, values.get(new Date(time).toISOString()) ?? null]; }) };
        }) })} />
        <p className="text-xs">Shared run span: {result.sameWindow.span?.from} to {result.sameWindow.span?.to}. Gaps remain blank.</p>
        {result.sameWindow.games.map(game => <p key={game.universeId} className="text-sm">{name(game.universeId)}: {game.absoluteChange?.toLocaleString()} CCU change; {game.percentChange === null ? "zero baseline: percentage and index unavailable" : `${game.percentChange?.toFixed(1)}% endpoint change`}.</p>)}
      </> : <p>Too little shared evidence for an all-game growth chart. Inspect each pair below.</p>}
      {result.pairs.map(pair => <div key={pair.universeIds.join(",")} className="rounded border border-line p-3 text-sm"><p>{pair.universeIds.map(name).join(" vs ")}: {pair.status.replaceAll("_", " ")}; {pair.coverage.pairedSlots} matching slots, {pct(pair.coverage.pairedFractionOfRequestedSlots)} of requested period; overlap {pair.coverage.overlapFraction === null ? "unavailable" : pct(pair.coverage.overlapFraction)}.</p><p>{pair.observedPlayerCounts?.description ?? pair.reasons.map(reason => reason.replaceAll("_", " ")).join(", ")}</p><p>{pair.coverage.pairedSlotSpan?.from} to {pair.coverage.pairedSlotSpan?.to}</p>{pair.growth && <p>Same-pair endpoint changes: {pair.growth.left?.absoluteChange} vs {pair.growth.right?.absoluteChange} CCU. Pair windows can differ.</p>}</div>)}
      <details><summary>Recorded discovery placements and retrieval evidence</summary><div className="max-h-80 overflow-auto text-xs">{result.slots.flatMap(slot => slot.observations.filter(point => Object.keys(point.chartRanks).length).map(point => <p key={`${slot.slot}:${point.universeId}`}>{name(point.universeId)} / run {slot.slot} / retrieved {point.observedAt} / {Object.entries(point.chartRanks).map(([chart, rank]) => `${chart} #${rank}`).join(", ")}</p>))}</div><p className="text-xs">Absent placement is unknown. Game updates are not recorded.</p></details>
      <details><summary>Evidence and limits</summary>{result.limitations.map(item => <p key={item} className="mt-2 text-xs text-fg-muted">{item}</p>)}</details>
    </>}
  </section>;
}
