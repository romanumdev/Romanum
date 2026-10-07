import Link from "next/link";
import { MetricChange } from "./metric-change";
import { dailyMetricChange } from "@/lib/linked-games/changes";
import { ChartCard } from "@/components/charts/chart-card";
import { colorHex, type ChartSpec, type ValueFormat } from "@/lib/charts/spec";
import { asFractions, formatMetric, SYNCED_METRICS, type MetricUnit } from "@/lib/linked-games/metrics";
import type { LinkedGame, MetricPoint } from "@/lib/linked-games/store";

// The owner's private analytics for a game they linked. Only rendered for that account; never shown to anyone else.

const SOURCE = "Roblox Analytics Query API · your connected game";
const unitOf = (metric: string): MetricUnit => SYNCED_METRICS.find((item) => item.metric === metric)?.unit ?? "count";
/** Short labels fit at the ends of chart lines; the chart title and legend give the context. */
const labelOf = (metric: string) => SYNCED_METRICS.find((item) => item.metric === metric)?.short ?? metric;

/** Values as charts show them: rates as fractions, minutes to a tenth. */
function chartValues(metric: string, values: (number | null)[]): (number | null)[] {
  const unit = unitOf(metric);
  if (unit === "rate") return asFractions(values);
  if (unit === "minutes") return values.map((value) => (value === null ? null : Math.round(value * 10) / 10));
  return values;
}

const FORMAT: Record<MetricUnit, ValueFormat> = { count: "compact", robux: "compact", rate: "percent", minutes: "full" };

function lineChart(title: string, metrics: string[], data: Record<string, MetricPoint[]>): ChartSpec | null {
  const days = [...new Set(metrics.flatMap((metric) => (data[metric] ?? []).map((point) => point.day)))].sort();
  if (!days.length) return null;
  const palette = ["blue", "orange"] as const;
  return {
    kind: "line",
    title,
    source: SOURCE,
    size: "small",
    categories: days.map((day) => ({ key: String(Date.parse(`${day}T00:00:00Z`)), label: day })),
    series: metrics.map((metric) => {
      const byDay = new Map((data[metric] ?? []).map((point) => [point.day, point.value]));
      return { key: metric, label: labelOf(metric), format: FORMAT[unitOf(metric)], values: chartValues(metric, days.map((day) => byDay.get(day) ?? null)) };
    }),
    colors: Object.fromEntries(metrics.map((metric, i) => [metric, colorHex(palette[i % palette.length])])),
    colorBy: "series",
  };
}

export function PrivateAnalytics({ game, metrics }: { game: LinkedGame; metrics: Record<string, MetricPoint[]> }) {
  const charts = [
    lineChart("Players", ["DailyActiveUsers", "Visits"], metrics),
    lineChart("Retention", ["ForwardD1Retention", "ForwardD7Retention"], metrics),
    lineChart("Time played", ["AveragePlayTimeMinutesPerDAU", "AverageSessionLengthMinutes"], metrics),
    lineChart("Revenue", ["DailyRevenue"], metrics),
  ].filter((chart): chart is ChartSpec => chart !== null);

  return (
    <section id="your-analytics" aria-labelledby="your-analytics-heading" className="scroll-mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="your-analytics-heading" className="text-base font-semibold tracking-tight">
          Your analytics
        </h2>
        <p className="text-xs text-fg-subtle">
          Private to you ·{" "}
          <Link href={`/profile/settings/games#game-${game.id}`} className="rounded-sm text-fg-muted underline-offset-2 hover:text-fg hover:underline focus-visible:outline-2 focus-visible:outline-fg-muted">
            {game.collect && game.status === "active" ? "Manage" : "Collection off"}
          </Link>
        </p>
      </div>

      {charts.length ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            {SYNCED_METRICS.filter(({ metric }) => ["DailyActiveUsers", "AveragePlayTimeMinutesPerDAU", "ForwardD1Retention", "DailyRevenue"].includes(metric)).map(({ metric, label, unit }) => {
              const series = metrics[metric] ?? [];
              const latest = series.at(-1);
              const value = latest ? chartValues(metric, series.map((point) => point.value)).at(-1) : null;
              return (
                <div key={metric} className="min-w-0 rounded-xl border border-line bg-surface px-4 py-4">
                  <dt className="truncate text-xs text-fg-muted">{label}</dt>
                  <dd className="mt-2 text-xl font-semibold tabular-nums" title={latest ? `Roblox daily observation: ${latest.day}${latest.status ? ` (${latest.status})` : ""}` : "Not synced"}>
                    {formatMetric(value, unit)}
                    {latest?.status === "Projected" && <span className="ml-2 text-[11px] font-normal text-fg-subtle">Projected</span>}
                  </dd>
                  <MetricChange change={dailyMetricChange(series, unit)} />
                </div>
              );
            })}
          </dl>
          <details className="mt-4 rounded-xl border border-line px-4 py-3">
            <summary className="cursor-pointer text-sm text-fg-muted hover:text-fg">More daily metrics</summary>
            <dl className="mt-4 grid grid-cols-2 gap-4">
              {SYNCED_METRICS.filter(({ metric }) => !["DailyActiveUsers", "AveragePlayTimeMinutesPerDAU", "ForwardD1Retention", "DailyRevenue"].includes(metric)).map(({ metric, label, unit }) => {
                const series = metrics[metric] ?? [];
                const latest = series.at(-1);
                const value = latest ? chartValues(metric, series.map((point) => point.value)).at(-1) : null;
                return <div key={metric}><dt className="text-xs text-fg-muted">{label}</dt><dd className="mt-1 text-lg font-semibold tabular-nums" title={latest ? `Roblox daily observation: ${latest.day}${latest.status ? ` (${latest.status})` : ""}` : "Not synced"}>{formatMetric(value, unit)}{latest?.status === "Projected" && <span className="ml-2 text-[11px] font-normal text-fg-subtle">Projected</span>}</dd></div>;
              })}
            </dl>
          </details>
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            {charts.map((chart) => (
              <ChartCard key={chart.title} chart={chart} />
            ))}
          </div>
        </>
      ) : (
        <p role="status" className="mt-4 rounded-xl border border-line p-5 text-sm text-fg-muted">
          {game.collect && game.status === "active" ? "Syncing from Roblox. Check back in a minute." : "No metrics synced."}
        </p>
      )}
    </section>
  );
}
