// Prompt construction and AI output parsing for the optional LLM layer.
//
// The system prompt strongly constrains the model: local analysis is
// authoritative, the model may only use supplied evidence, and it must clearly
// separate facts from interpretations.
import type { AiExplanation } from './types.ts';

export const AI_PROMPT_VERSION = 1;
export const AI_SCHEMA_VERSION = 1;

export const AI_SYSTEM_PROMPT = `You are the AI interpretation layer of "Inspect This", a local-first, read-only analysis application.

You receive a compact, structured summary produced by a deterministic local analysis engine. The local analysis is authoritative.

Your job is to explain, summarize, prioritize, and contextualize that local analysis for a human user.

HARD RULES:
1. Use ONLY the information supplied in the context below. Never invent measurements, files, folders, URLs, statistics, vulnerabilities, or any other fact.
2. Never claim that you inspected raw files, source code, images, audio, video, databases, archives, or web pages. You only received the structured summary.
3. Distinguish facts from interpretations. When you are interpreting, make that clear (for example "This suggests...", "This may indicate...").
4. Acknowledge missing information. If something would be needed to answer confidently and it was not supplied, say so.
5. Identify uncertainty. Use hedged language where the evidence is weak.
6. Never give instructions to delete, modify, move, rename, clean up, install, or execute anything. You are an explanation tool, not an action tool.
7. Base every claim on supplied evidence. If the context does not support a claim, omit it.`;

export function buildAiUserPrompt(context: string, objectCount: number): string {
  return `Below is the local analysis of ${objectCount === 1 ? 'one object' : `${objectCount} objects`} produced by Inspect This. It is authoritative and complete; do not assume anything beyond it.

<analysis>
${context}
</analysis>

Return a JSON object with EXACTLY these keys:
{
  "summary": "string - 2 to 4 sentence plain-English summary of what this object appears to be",
  "important": ["string"] - the most important things to know, maximum 5,
  "whyItMatters": "string - why this matters in context",
  "unusual": ["string"] - what looks unusual, each grounded in supplied evidence, maximum 5,
  "investigate": ["string"] - concrete, safe next steps to investigate, maximum 5,
  "limitations": ["string"] - limitations of this interpretation, maximum 3,
  "uncertainty": "string - what is uncertain or missing from the supplied analysis"
}

Rules for the JSON:
- Every claim must be supported by the supplied <analysis>. Never invent numbers or files.
- Do not include markdown code fences around the JSON.
- If a key has no grounded content, use an empty string or empty array.`;
}

/** Strip control characters so provider output can never inject layout/UI text. */
function sanitizeText(value: unknown, max = 4000): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

function sanitizeList(value: unknown, max = 5, maxItem = 600): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = sanitizeText(item, maxItem);
    if (text && out.length < max) out.push(text);
  }
  return out;
}

/** Extract a JSON object from raw model output (handles code fences and prose). */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const slice = candidate.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface AiExplanationMeta {
  providerName: string;
  model: string;
  contextChars?: number;
  truncated?: boolean;
}

/** Parse raw provider output into the structured AiExplanation schema. */
export function parseAiExplanation(raw: string, meta: AiExplanationMeta): AiExplanation {
  const text = sanitizeText(raw, 20000);
  const parsed = extractJsonObject(text);
  const base = {
    providerName: meta.providerName,
    model: meta.model,
    generatedAt: new Date().toISOString(),
    contextChars: meta.contextChars,
    truncated: meta.truncated
  };
  if (parsed) {
    return {
      ...base,
      summary: sanitizeText(parsed.summary, 4000) || 'No summary returned.',
      important: sanitizeList(parsed.important, 5),
      whyItMatters: sanitizeText(parsed.whyItMatters, 4000),
      unusual: sanitizeList(parsed.unusual, 5),
      investigate: sanitizeList(parsed.investigate, 5),
      limitations: sanitizeList(parsed.limitations, 3),
      uncertainty: sanitizeText(parsed.uncertainty, 2000),
      structured: true
    };
  }
  // Fallback: free-text explanation. Never present it as a measured fact.
  return {
    ...base,
    summary: text || 'The AI provider returned no explanation.',
    important: [],
    whyItMatters: '',
    unusual: [],
    investigate: [],
    limitations: [],
    uncertainty: '',
    structured: false
  };
}
