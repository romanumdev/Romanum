export const SLOT_MS = 300_000;
export type PublicSample = { universeId: number; slot: string; observedAt: string; playing: number };
export type WatchRule = { universeId: number; peerIds: number[]; direction: "up" | "down" | "either"; thresholdPercent: number; minimumPlayers: number; windowMinutes: 30 | 60 };
export type WatchEvidence = { currentMean: number; baselineMean: number; changePercent: number; peerChangePercent: number | null; signalPercent: number; absoluteChange: number; pairs: number; windowMinutes: number; currentFrom: string; currentTo: string; baselineFrom: string; baselineTo: string; peers: { universeId: number; currentMean: number; baselineMean: number; changePercent: number }[] };
export type Evaluation = { coverage: "ready" | "waiting" | "unavailable"; detail: string; crossed: boolean; recovered: boolean; evidence?: WatchEvidence };

/** Every five-minute offset must have a fresh actual observation in both windows.
 * The same UTC time yesterday controls time of day; peers use the same offsets.
 * Missing samples never become zero or rearm a threshold episode. */
export function evaluateRule(rule: WatchRule, samples: PublicSample[], slot: string, now: number): Evaluation {
  const end = Date.parse(slot);
  const waiting = (detail: string, unavailable = false): Evaluation => ({ coverage: unavailable ? "unavailable" : "waiting", detail, crossed: false, recovered: false });
  if (!Number.isFinite(end) || now - end > 2 * SLOT_MS || end > now) return waiting("Collection is stale. Alerts wait for fresh public observations.", true);
  const pairs = rule.windowMinutes / 5;
  const start = end - (pairs - 1) * SLOT_MS;
  const indexed = new Map(samples.filter(s => Number.isSafeInteger(s.playing) && s.playing >= 0 && Number.isFinite(Date.parse(s.observedAt)) && Date.parse(s.observedAt) <= now && Date.parse(s.observedAt) >= Date.parse(s.slot) && Date.parse(s.observedAt) < Date.parse(s.slot) + SLOT_MS).map(s => [`${s.universeId}:${Date.parse(s.slot)}`, s]));
  const means = [];
  for (const universeId of [rule.universeId, ...rule.peerIds]) {
    let current = 0; let baseline = 0;
    for (let offset = 0; offset < pairs; offset++) {
      const time = start + offset * SLOT_MS;
      const a = indexed.get(`${universeId}:${time}`);
      const b = indexed.get(`${universeId}:${time - 86_400_000}`);
      if (!a || !b) return waiting("Waiting for complete paired five-minute observations in this window and the same UTC window yesterday. Missing or unavailable samples suppress alerts.");
      current += a.playing; baseline += b.playing;
    }
    current /= pairs; baseline /= pairs;
    if (baseline < rule.minimumPlayers || baseline === 0) return waiting("The matched baseline is below the minimum player count; percentage alerts are suppressed.");
    means.push({ universeId, currentMean: current, baselineMean: baseline, changePercent: (current - baseline) / baseline * 100 });
  }
  const primary = means[0];
  const peers = means.slice(1);
  const peerChangePercent = peers.length ? peers.reduce((sum, peer) => sum + peer.changePercent, 0) / peers.length : null;
  const signalPercent = primary.changePercent - (peerChangePercent ?? 0);
  const magnitude = rule.direction === "up" ? signalPercent : rule.direction === "down" ? -signalPercent : Math.abs(signalPercent);
  const absoluteChange = Math.abs(primary.currentMean - primary.baselineMean);
  const evidence: WatchEvidence = { ...primary, peerChangePercent, signalPercent, absoluteChange, pairs, windowMinutes: rule.windowMinutes, currentFrom: new Date(start).toISOString(), currentTo: new Date(end + SLOT_MS).toISOString(), baselineFrom: new Date(start - 86_400_000).toISOString(), baselineTo: new Date(end + SLOT_MS - 86_400_000).toISOString(), peers };
  return { coverage: "ready", detail: "Complete paired public observations. Changes are descriptive, not evidence of revenue, retention or causation.", crossed: magnitude >= rule.thresholdPercent && absoluteChange >= rule.minimumPlayers, recovered: magnitude < rule.thresholdPercent * .8 || absoluteChange < rule.minimumPlayers * .8, evidence };
}
