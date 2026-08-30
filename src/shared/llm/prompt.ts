// Prompt construction and AI output parsing for the optional LLM layer.
//
// The system prompt strongly constrains the model: local analysis is
// authoritative, the model may only use supplied evidence, and it must clearly
// separate facts from interpretations.
import type { AiExplanation } from './types.ts';

export const AI_PROMPT_VERSION = 2;
export const AI_SCHEMA_VERSION = 2;

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

/**
 * System prompt for RAW-CONTENT investigation. The model is explicitly told it
 * is receiving actual extracted content (not just a summary) and is instructed
 * to investigate it like a careful analyst, quote short excerpts, redact
 * secrets, and never exceed the supplied content.
 */
export const AI_RAW_SYSTEM_PROMPT = `You are the deep-investigation layer of "Inspect This", a local-first, read-only analysis application.

You receive TWO inputs:
1. A structured analysis produced by a deterministic local engine. Treat its measurements as authoritative facts.
2. RAW OR EXTRACTED CONTENT from the object(s) being inspected - actual text such as document text, source code, logs, emails, or spreadsheet excerpts.

Your job is to investigate the actual content: identify what matters, what is unusual, what is suspicious, what is internally inconsistent, and what deserves a closer look.

HARD RULES:
1. Use ONLY the content and analysis supplied below. Never invent files, lines, numbers, statistics, or any other fact.
2. You may quote short excerpts (max ~200 characters each) from the supplied content to support a finding.
3. Distinguish OBSERVED from INFERRED. When you are interpreting, make it explicit (for example "This suggests...", "This may indicate...").
4. SECRETS: if the content contains credentials, API keys, passwords, tokens, or other secrets, do NOT reproduce them verbatim. Refer to them as "a credential/API key/password/token" and note where it appears instead.
5. Never give instructions to delete, modify, move, rename, clean up, install, or execute anything. You are an investigation tool, not an action tool.
6. Acknowledge what you could NOT see: truncated content, binary attachments, images, audio, or anything else not present in the supplied text.
7. Identify uncertainty explicitly. If the evidence is weak or the content was truncated, say so and avoid over-generalizing.`;

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

/** User prompt for raw-content investigation mode. */
export function buildAiRawUserPrompt(context: string, rawBlock: string, objectCount: number): string {
  return `Below is the local analysis PLUS actual extracted content of ${objectCount === 1 ? 'one object' : `${objectCount} objects`}.

The <analysis> block contains authoritative structured measurements from the local engine. The <raw-content> block contains actual text extracted from the object(s); it may be truncated.

<analysis>
${context}
</analysis>

<raw-content>
${rawBlock}
</raw-content>

Investigate the actual content carefully, like a forensic analyst. Return a JSON object with EXACTLY these keys:
{
  "summary": "string - 2 to 4 sentence plain-English summary of what this object is and what you found in its content",
  "important": ["string"] - the most important things to know, maximum 5,
  "whyItMatters": "string - why this matters in context",
  "unusual": ["string"] - what looks unusual, each grounded in supplied content or evidence, maximum 5,
  "contentFindings": ["string"] - concrete observations from the raw content, quoting or paraphrasing specific lines, maximum 6,
  "investigate": ["string"] - concrete, safe next steps to investigate, maximum 5,
  "questions": ["string"] - questions worth investigating further, maximum 5,
  "limitations": ["string"] - limitations of this interpretation, including any truncation, maximum 3,
  "uncertainty": "string - what is uncertain or missing from the supplied content"
}

Rules for the JSON:
- Every claim must be supported by the supplied <analysis> or <raw-content>. Never invent content you did not see.
- Do not reproduce secrets (credentials, API keys, passwords, tokens) verbatim; refer to them as credentials/keys instead.
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
  rawContentIncluded?: boolean;
  rawContentChars?: number;
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
    truncated: meta.truncated,
    rawContentIncluded: meta.rawContentIncluded,
    rawContentChars: meta.rawContentChars
  };
  if (parsed) {
    return {
      ...base,
      summary: sanitizeText(parsed.summary, 4000) || 'No summary returned.',
      important: sanitizeList(parsed.important, 5),
      whyItMatters: sanitizeText(parsed.whyItMatters, 4000),
      unusual: sanitizeList(parsed.unusual, 5),
      investigate: sanitizeList(parsed.investigate, 5),
      contentFindings: sanitizeList(parsed.contentFindings, 6),
      questions: sanitizeList(parsed.questions, 5),
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
