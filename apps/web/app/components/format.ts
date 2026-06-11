export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function formatDuration(startValue: string, endValue: string): string {
  const start = new Date(startValue).getTime();
  const end = new Date(endValue).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "-";
  }
  const duration = Math.max(0, end - start);
  if (duration < 1000) {
    return `${duration.toFixed(0)} ms`;
  }
  return `${(duration / 1000).toFixed(2)} s`;
}

export function formatUsage(usage: Record<string, number> | null | undefined): string {
  if (!usage) {
    return "";
  }
  return Object.entries(usage)
    .map(([key, value]) => `${key}: ${formatNumber(value)}`)
    .join(", ");
}

export function formatCost(cost: Record<string, number> | null | undefined, currency: string | null | undefined): string {
  if (!cost) {
    return "";
  }
  const suffix = currency ? ` ${currency}` : "";
  return Object.entries(cost)
    .map(([key, value]) => `${key}: ${formatNumber(value)}${suffix}`)
    .join(", ");
}

export function formatAggregateScores(scores: Record<string, number>): string {
  const entries = Object.entries(scores);
  if (entries.length === 0) {
    return "no scores";
  }
  return entries.map(([key, value]) => `${key}: ${formatNumber(value)}`).join(", ");
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 6,
  }).format(value);
}

export function formatComparisonScore(
  baselineValue: number | null,
  candidateValue: number | null,
  delta: number | null,
): string {
  const baseline = baselineValue === null ? "-" : formatNumber(baselineValue);
  const candidate = candidateValue === null ? "-" : formatNumber(candidateValue);
  const deltaValue = delta === null ? "-" : formatSignedNumber(delta);
  return `${baseline} -> ${candidate} (${deltaValue})`;
}

function formatSignedNumber(value: number): string {
  const formatted = formatNumber(value);
  if (value > 0) {
    return `+${formatted}`;
  }
  return formatted;
}

export function formatPayloadValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}
