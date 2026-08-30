// Bounded, deterministic LLM context builder.
//
// Converts one or more local AnalysisResults into a compact plain-text context
// that can be sent to an OpenAI-compatible provider. Guarantees:
//   - bounded size (character budget with truncation)
//   - prioritization (identity and key facts first, evidence preserved)
//   - deduplication (each evidence item appears once)
//   - evidence-first grounding (findings reference the EVIDENCE section)
//   - never contains API keys, raw binaries, or original files
import type { AnalysisResult, AnalysisSection, Evidence, Finding } from '../types.ts';
import { formatBytes } from '../utils.ts';

export interface AiContextBudget {
  /** Hard cap on the total context size in characters. */
  maxChars: number;
  /** Maximum fact rows included per object. */
  maxFactsPerObject: number;
  /** Maximum finding/anomaly rows across all objects. */
  maxFindings: number;
  /** Maximum evidence rows included. */
  maxEvidence: number;
  /** Maximum relationship rows. */
  maxRelationships: number;
  /** Maximum recommendation rows. */
  maxRecommendations: number;
  /** Maximum limitation rows. */
  maxLimitations: number;
  /** Maximum characters for any single value (long values are truncated). */
  maxValueChars: number;
}

export const DEFAULT_AI_BUDGET: AiContextBudget = {
  maxChars: 24000,
  maxFactsPerObject: 24,
  maxFindings: 14,
  maxEvidence: 20,
  maxRelationships: 12,
  maxRecommendations: 8,
  maxLimitations: 6,
  maxValueChars: 220
};

export interface BuiltAiContext {
  text: string;
  chars: number;
  truncated: boolean;
  counts: {
    objects: number;
    facts: number;
    findings: number;
    anomalies: number;
    relationships: number;
    evidence: number;
  };
}

const SEVERITY_WEIGHT: Record<Finding['severity'], number> = { high: 4, medium: 3, low: 2, info: 1 };

function clip(value: string, max: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function classifySection(section: AnalysisSection): 'facts' | 'statistics' | 'structure' {
  const id = section.id.toLowerCase();
  const title = section.title.toLowerCase();
  if (id.endsWith('-facts') || title === 'facts') return 'facts';
  if (/stat|deep|outlier/.test(id) || /statistic|deep|outlier/.test(title)) return 'statistics';
  return 'structure';
}

function evidenceMap(result: AnalysisResult): Map<string, Evidence> {
  const map = new Map<string, Evidence>();
  for (const item of result.evidence) map.set(item.id, item);
  for (const section of result.sections) {
    for (const item of section.items) {
      if (!map.has(item.id)) map.set(item.id, item);
    }
  }
  return map;
}

interface PendingLine {
  priority: number;
  order: number;
  text: string;
}

function push(lines: PendingLine[], priority: number, order: number, text: string): void {
  if (text) lines.push({ priority, order, text });
}

export interface RawContentInput {
  targetName: string;
  content: string;
  note?: string;
}

export interface BuiltRawContent {
  text: string;
  chars: number;
  truncated: boolean;
  includedObjects: number;
}

function clipRaw(value: string, max: number): string {
  const text = String(value ?? '').replace(/\r\n/g, '\n');
  if (text.length <= max) return text;
  const keep = Math.max(1, max - 80);
  return `${text.slice(0, keep)}\n\n[... content truncated at ${max} characters ...]`;
}

/**
 * Build the bounded raw-content block for AI investigation mode. Each object's
 * content is clipped to a fair share of the total budget so the request never
 * exceeds `maxChars`. This block is ONLY produced when the user explicitly
 * opts into raw-content analysis.
 */
export function buildRawContentBlock(inputs: RawContentInput[], maxChars: number): BuiltRawContent {
  const list = inputs.filter((input) => input && input.targetName);
  if (!list.length) return { text: '', chars: 0, truncated: false, includedObjects: 0 };
  const perObject = Math.max(200, Math.floor(maxChars / list.length));
  const blocks: string[] = [];
  let used = 0;
  let truncated = false;
  let included = 0;
  for (const input of list) {
    const body = clipRaw(input.content, perObject);
    const chars = body.length;
    const wasTruncated = input.content.length > perObject;
    if (wasTruncated) truncated = true;
    const parts: string[] = [];
    parts.push(`[RAW CONTENT] ${input.targetName} (${chars} chars${wasTruncated ? ', truncated' : ''})`);
    if (body.trim()) {
      parts.push('<content>');
      parts.push(body);
      parts.push('</content>');
      included += 1;
    } else if (input.note) {
      parts.push(`(no text included - ${input.note})`);
    }
    const block = `${parts.join('\n')}\n`;
    blocks.push(block);
    used += block.length;
  }
  return { text: blocks.join(''), chars: used, truncated, includedObjects: included };
}

/** Build the bounded context text from one or more local analysis results. */
export function buildAiContext(results: AnalysisResult[], budget: Partial<AiContextBudget> = {}): BuiltAiContext {
  const cfg: AiContextBudget = { ...DEFAULT_AI_BUDGET, ...budget };
  const lines: PendingLine[] = [];
  let order = 0;
  let factCount = 0;
  let statCount = 0;
  let structureCount = 0;

  for (const result of results) {
    const identity = result.identity;
    const facts: string[] = [];
    const statistics: string[] = [];
    const structure: string[] = [];
    for (const section of result.sections) {
      const kind = classifySection(section);
      for (const item of section.items) {
        const value = `${clip(item.label, 60)}: ${clip(item.value, cfg.maxValueChars)}`;
        if (kind === 'facts') facts.push(value);
        else if (kind === 'statistics') statistics.push(value);
        else structure.push(value);
      }
    }
    // Keep the first (most important) facts only.
    const factRows = facts.slice(0, cfg.maxFactsPerObject);
    const statRows = statistics.slice(0, Math.max(1, Math.ceil(cfg.maxFactsPerObject / 2)));
    const structureRows = structure.slice(0, Math.max(1, Math.ceil(cfg.maxFactsPerObject / 2)));
    factCount += factRows.length;
    statCount += statRows.length;
    structureCount += structureRows.length;

    push(lines, 10, order++, 'OBJECT');
    push(lines, 10, order++, `name: ${clip(identity.name, 120)}`);
    push(lines, 10, order++, `type: ${clip(identity.type, 60)}`);
    if (identity.format && identity.format !== identity.type) push(lines, 10, order++, `format: ${clip(identity.format, 60)}`);
    push(lines, 10, order++, `size: ${formatBytes(identity.size)}`);
    push(lines, 10, order++, `location: ${clip(identity.location, 160)}`);
    if (identity.modified && identity.modified !== 'Unknown') push(lines, 10, order++, `modified: ${clip(identity.modified, 80)}`);
    if (factRows.length) {
      push(lines, 20, order++, 'SUMMARY FACTS');
      for (const row of factRows) push(lines, 20, order++, `- ${row}`);
    }
    if (statRows.length) {
      push(lines, 30, order++, 'STATISTICS');
      for (const row of statRows) push(lines, 30, order++, `- ${row}`);
    }
    if (structureRows.length) {
      push(lines, 35, order++, 'STRUCTURE');
      for (const row of structureRows) push(lines, 35, order++, `- ${row}`);
    }
  }

  // Findings: prioritize by severity, then keep order stable.
  const findings = results.flatMap((result) =>
    result.important.map((finding) => ({ finding, kind: 'finding' as const, result }))
  );
  const anomalies = results.flatMap((result) =>
    result.unusual.map((finding) => ({ finding, kind: 'anomaly' as const, result }))
  );
  const allFindings = [...findings, ...anomalies].sort((a, b) => {
    const wa = SEVERITY_WEIGHT[a.finding.severity] ?? 1;
    const wb = SEVERITY_WEIGHT[b.finding.severity] ?? 1;
    return wb - wa;
  });

  const findingRows = allFindings.slice(0, cfg.maxFindings);
  const evidenceById = new Map<string, Evidence>();
  const evidenceOrder: string[] = [];
  const seenEvidence = new Set<string>();
  for (const { finding, result } of findingRows) {
    const map = evidenceMap(result);
    for (const id of finding.evidence) {
      if (seenEvidence.has(id)) continue;
      seenEvidence.add(id);
      const entry = map.get(id);
      if (entry) {
        evidenceById.set(id, entry);
        evidenceOrder.push(id);
      }
    }
  }

  const hasAnomalies = findingRows.some((row) => row.kind === 'anomaly');
  const hasFindings = findingRows.some((row) => row.kind === 'finding');
  if (hasFindings) {
    push(lines, 40, order++, 'FINDINGS');
    for (const { finding } of findingRows.filter((row) => row.kind === 'finding')) {
      push(lines, 40, order++, `- [${finding.severity}] ${clip(finding.title, 120)}: ${clip(finding.summary, cfg.maxValueChars)}`);
    }
  }
  if (hasAnomalies) {
    push(lines, 50, order++, 'ANOMALIES');
    for (const { finding } of findingRows.filter((row) => row.kind === 'anomaly')) {
      push(lines, 50, order++, `- [${finding.severity}] ${clip(finding.title, 120)}: ${clip(finding.summary, cfg.maxValueChars)}`);
    }
  }

  const relationships = results.flatMap((result) => result.relationships ?? []);
  if (relationships.length) {
    push(lines, 60, order++, 'RELATIONSHIPS');
    for (const rel of relationships.slice(0, cfg.maxRelationships)) {
      push(lines, 60, order++, `- ${clip(rel.label, 120)}: ${clip(rel.detail, cfg.maxValueChars)}`);
    }
  }

  const recommendations = results.flatMap((result) => result.recommendations);
  if (recommendations.length) {
    push(lines, 70, order++, 'RECOMMENDATIONS');
    for (const finding of recommendations.slice(0, cfg.maxRecommendations)) {
      push(lines, 70, order++, `- ${clip(finding.title, 120)}: ${clip(finding.summary, cfg.maxValueChars)}`);
    }
  }

  if (evidenceOrder.length) {
    push(lines, 80, order++, 'EVIDENCE');
    for (const id of evidenceOrder.slice(0, cfg.maxEvidence)) {
      const entry = evidenceById.get(id);
      if (entry) {
        push(lines, 80, order++, `- ${clip(entry.label, 60)}: ${clip(entry.value, cfg.maxValueChars)}`);
      }
    }
  }

  const limitations = results.flatMap((result) => result.limitations ?? []);
  if (limitations.length) {
    push(lines, 90, order++, 'LIMITATIONS');
    for (const limitation of limitations.slice(0, cfg.maxLimitations)) {
      push(lines, 90, order++, `- ${clip(limitation, cfg.maxValueChars)}`);
    }
  }

  // Greedy assembly in priority order until the budget is exhausted.
  const sorted = lines.sort((a, b) => a.priority - b.priority || a.order - b.order);
  const chunks: string[] = [];
  let used = 0;
  let truncated = false;
  for (const line of sorted) {
    const piece = `${line.text}\n`;
    if (used + piece.length > cfg.maxChars) {
      truncated = true;
      break;
    }
    chunks.push(piece);
    used += piece.length;
  }
  const text = chunks.join('');

  return {
    text,
    chars: used,
    truncated,
    counts: {
      objects: results.length,
      facts: factCount,
      findings: findingRows.filter((row) => row.kind === 'finding').length,
      anomalies: findingRows.filter((row) => row.kind === 'anomaly').length,
      relationships: relationships.length,
      evidence: evidenceOrder.length
    }
  };
}



