import { XMLParser } from 'fast-xml-parser';
import type { AnalysisSection, Evidence, Finding, InspectionFile } from './types.ts';
import { formatNumber } from './utils.ts';

export function evidence(id: string, label: string, value: string): Evidence {
  return { id, label, value };
}

export function finding(id: string, title: string, summary: string, severity: Finding['severity'], evidenceIds: string[]): Finding {
  return { id, title, summary, severity, evidence: evidenceIds };
}

export function sections(items: Array<{ id: string; title: string; items: Evidence[] }>): AnalysisSection[] {
  return items;
}

export function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Analysis cancelled', 'AbortError');
  }
}

export async function readBytes(source: File | InspectionFile, limit?: number): Promise<Uint8Array> {
  const file = source instanceof File ? source : source.file;
  const blob = limit ? file.slice(0, limit) : file;
  return new Uint8Array(await blob.arrayBuffer());
}

export async function readText(source: File | InspectionFile, limitBytes = 2 * 1024 * 1024): Promise<string> {
  const bytes = await readBytes(source, limitBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function countLines(text: string): number {
  return text.length ? text.split(/\r\n|\n|\r/).length : 0;
}

export function tokenizeWords(text: string): string[] {
  return text.match(/\b[\p{L}\p{N}_-]+\b/gu) ?? [];
}

export function isLikelyBinary(bytes: Uint8Array): boolean {
  if (!bytes.length) {
    return false;
  }
  let suspicious = 0;
  const sample = Math.min(bytes.length, 4096);
  for (let index = 0; index < sample; index += 1) {
    const value = bytes[index];
    if (value === 0) {
      return true;
    }
    if (value < 7 || (value > 13 && value < 32)) {
      suspicious += 1;
    }
  }
  return suspicious / sample > 0.3;
}

export function looksLikeText(name: string): boolean {
  return /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ini|toml|yaml|yml|xml|html|htm|js|jsx|ts|tsx|py|rs|go|java|cs|cpp|c|h|hpp|php|rb|sh|sql|css|scss|less|swift|kt|kts|gradle|properties|env)$/i.test(name);
}

export function extension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

export function nameWithoutExt(name: string): string {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(0, index) : name;
}

export function parseXml(text: string): unknown {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true,
    processEntities: false,
    parseTagValue: true,
    trimValues: true
  });
  return parser.parse(text);
}

export function extractLinksFromHtml(html: string): string[] {
  const links = new Set<string>();
  for (const match of html.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) {
    links.add(match[1]);
  }
  return [...links];
}

export function extractHeadingsFromHtml(html: string): string[] {
  const headings: string[] = [];
  for (const match of html.matchAll(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis)) {
    headings.push(match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  }
  return headings;
}

export function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, ' ');
}

export function base64Decode(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
}

export function formatRatio(numerator: number, denominator: number): string {
  if (!denominator) {
    return '0.00';
  }
  return (numerator / denominator).toFixed(2);
}

export function safeNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((acc, next) => acc + next, 0) / values.length : 0;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

export function q(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const base = Math.floor(position);
  const rest = position - base;
  return sorted[base + 1] === undefined ? sorted[base] : sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

export function limitArray<T>(items: T[], max = 20): T[] {
  return items.slice(0, max);
}

export function textSummary(text: string): string {
  const lines = countLines(text);
  const words = tokenizeWords(text).length;
  return `${formatNumber(lines)} lines, ${formatNumber(words)} words`;
}

export function searchAll(text: string, pattern: RegExp): string[] {
  const matches = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    if (match[1]) {
      matches.add(match[1]);
    } else {
      matches.add(match[0]);
    }
  }
  return [...matches];
}

export function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\+/g, '/').replace(/\/+/g, '/');
}

export function isUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

export function isProbablyUrlText(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split(/\r\n|\n|\r/, 1)[0];
  return isUrl(firstLine) ? firstLine : null;
}
