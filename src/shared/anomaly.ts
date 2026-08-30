// Reusable local anomaly-analysis engine.
// All functions are deterministic and produce explainable numbers so that every
// anomaly finding can state: what was measured, the baseline, the deviation,
// and a confidence level.
import type { Finding } from './types.ts';
import { percent } from './utils.ts';

export type AnomalyConfidence = 'low' | 'medium' | 'high';

export interface Anomaly {
  id: string;
  label: string;
  measured: string;
  baseline: string;
  deviation: string;
  confidence: AnomalyConfidence;
  /** 0..1 heuristic strength used to pick severity. */
  strength: number;
  evidenceIds: string[];
}

export function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function median(values: number[]): number {
  const s = sorted(values);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - avg) ** 2)));
}

export function quantile(values: number[], q: number): number {
  const s = sorted(values);
  if (!s.length) return 0;
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (s[base + 1] === undefined) return s[base];
  return s[base] + rest * (s[base + 1] - s[base]);
}

export function zscore(value: number, values: number[]): number {
  const sd = stddev(values);
  if (!sd) return 0;
  return (value - mean(values)) / sd;
}

export function iqrBounds(values: number[]): { q1: number; q3: number; lower: number; upper: number } {
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const iqr = q3 - q1;
  return { q1, q3, lower: q1 - 1.5 * iqr, upper: q3 + 1.5 * iqr };
}

/** Median absolute deviation about the median (robust spread). */
export function mad(values: number[]): number {
  const med = median(values);
  return median(values.map((v) => Math.abs(v - med)));
}

export function skewness(values: number[]): number {
  const avg = mean(values);
  const sd = stddev(values);
  if (!sd || values.length < 3) return 0;
  const n = values.length;
  return (n / ((n - 1) * (n - 2))) * values.reduce((acc, v) => acc + ((v - avg) / sd) ** 3, 0) * n;
}

export function coefficientOfVariation(values: number[]): number {
  const avg = mean(values);
  if (!avg) return 0;
  return stddev(values) / Math.abs(avg);
}

/** Fraction of non-empty values equal to the most common value (0..1). */
export function constantRatio(values: string[]): number {
  const counts = new Map<string, number>();
  let total = 0;
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    total += 1;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  if (!total) return 0;
  const top = Math.max(...counts.values());
  return top / total;
}

/** Unique non-empty values / total non-empty values (0..1). */
export function uniqueRatio(values: string[]): number {
  const nonEmpty = values.filter((value) => value.trim().length > 0);
  if (!nonEmpty.length) return 0;
  return new Set(nonEmpty).size / nonEmpty.length;
}

export function missingRatio(values: string[]): number {
  if (!values.length) return 0;
  return values.filter((value) => value.trim().length === 0).length / values.length;
}

/** Duplicate share of non-empty values: fraction of values that are repeats. */
export function duplicateRatio(values: string[]): number {
  const nonEmpty = values.filter((value) => value.trim().length > 0);
  if (!nonEmpty.length) return 0;
  const counts = new Map<string, number>();
  for (const value of nonEmpty) counts.set(value, (counts.get(value) ?? 0) + 1);
  let repeated = 0;
  for (const count of counts.values()) {
    if (count > 1) repeated += count;
  }
  return repeated / nonEmpty.length;
}

export function histogram(values: number[], buckets = 8): { labels: string[]; counts: number[]; min: number; max: number } {
  if (!values.length) return { labels: [], counts: [], min: 0, max: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return { labels: [String(min)], counts: [values.length], min, max };
  const width = (max - min) / buckets;
  const counts = new Array(buckets).fill(0);
  for (const value of values) {
    const index = Math.min(buckets - 1, Math.floor((value - min) / width));
    counts[index] += 1;
  }
  const labels = counts.map((_, index) => {
    const low = min + index * width;
    const high = index === buckets - 1 ? max : low + width;
    return `${low.toFixed(1)}-${high.toFixed(1)}`;
  });
  return { labels, counts, min, max };
}

export interface Spike {
  index: number;
  count: number;
  baselineMean: number;
  z: number;
  confidence: AnomalyConfidence;
}

/**
 * Detect buckets that deviate strongly from the series mean.
 * A bucket is a spike when count > max(minCount, mean * k) and z > minZ.
 */
export function temporalSpikes(counts: number[], opts?: { k?: number; minZ?: number; minCount?: number }): Spike[] {
  const k = opts?.k ?? 3;
  const minZ = opts?.minZ ?? 2;
  const minCount = opts?.minCount ?? 3;
  const avg = mean(counts);
  const sd = stddev(counts);
  const spikes: Spike[] = [];
  counts.forEach((count, index) => {
    const z = sd ? (count - avg) / sd : 0;
    if (count >= minCount && count > avg * k && z >= minZ) {
      spikes.push({
        index,
        count,
        baselineMean: avg,
        z,
        confidence: z >= 4 ? 'high' : z >= 3 ? 'medium' : 'low'
      });
    }
  });
  return spikes;
}

export function makeAnomaly(anomaly: Anomaly): Anomaly {
  return anomaly;
}

export function anomalyToFinding(
  anomaly: Anomaly,
  title: string,
  severity: Finding['severity'],
  category: Finding['category'] = 'anomaly'
): Finding {
  return {
    id: anomaly.id,
    title,
    summary: `${anomaly.label}: ${anomaly.measured} (baseline ${anomaly.baseline}; ${anomaly.deviation}).`,
    severity,
    evidence: anomaly.evidenceIds,
    methodology: 'anomaly',
    confidence: anomaly.confidence,
    category,
    metrics: { strength: Number(anomaly.strength.toFixed(3)) }
  };
}

export function confidenceFor(condition: boolean, ifTrue: AnomalyConfidence, ifFalse: AnomalyConfidence): AnomalyConfidence {
  return condition ? ifTrue : ifFalse;
}

export function formatRatio(value: number): string {
  return percent(value);
}
