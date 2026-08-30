// Raw-content extraction for AI investigation mode.
//
// This is the ONLY place that pulls actual file text for the optional LLM
// layer. It is used exclusively when the user explicitly opts into raw-content
// analysis (after seeing the warning) and settings.allowRawContent is enabled.
//
// Rules:
//   - Never sends binary. Only text content (or PDF-extracted text) is included.
//   - Bounded: reads are capped and each object is clipped by the caller.
//   - Honest: binary/media/URL/folder content produces a clear note instead of
//     being silently omitted.
import type { InspectionItem } from '../types.ts';
import { extractPdfText } from '../pdf.ts';
import { readBytes } from '../analysis-utils.ts';
import type { RawContentInput } from './context.ts';

const MAX_READ_BYTES = 8 * 1024 * 1024;
const FOLDER_SAMPLE_FILES = 8;

const TEXT_EXTENSION_PATTERN =
  /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ini|toml|yaml|yml|xml|html?|eml|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|cpp|cxx|c|h|hpp|php|rb|sh|bat|ps1|sql|css|scss|less|properties|env|gradle|lock)$/i;

function isTextLikeName(name: string): boolean {
  if (TEXT_EXTENSION_PATTERN.test(name)) return true;
  return /^(dockerfile|makefile|gemfile|procfile|cmakelists\.txt)$/i.test(name);
}

function extension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function noteForBinary(name: string): string {
  const ext = extension(name);
  return ext ? `${ext.toUpperCase()} is a binary/media format; its raw content is not sent` : 'binary content is not sent';
}

async function textFromFile(file: InspectionItem & { kind: 'file' }): Promise<string> {
  const bytes = await readBytes(file, MAX_READ_BYTES);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return text.includes('\u0000') ? '' : text;
}

async function extractFileContent(file: InspectionItem & { kind: 'file' }, signal: AbortSignal): Promise<RawContentInput> {
  const ext = extension(file.name);
  if (ext === 'pdf') {
    try {
      const bytes = await readBytes(file, MAX_READ_BYTES);
      const extraction = await extractPdfText(bytes, { signal });
      return {
        targetName: file.name,
        content: extraction.text,
        note: 'text extracted from the PDF (the binary PDF itself is not sent)'
      };
    } catch {
      return { targetName: file.name, content: '', note: 'PDF text could not be extracted locally' };
    }
  }
  if (isTextLikeName(file.name)) {
    try {
      const text = await textFromFile(file);
      if (text.trim()) {
        return { targetName: file.name, content: text, note: 'file text' };
      }
      return { targetName: file.name, content: '', note: noteForBinary(file.name) };
    } catch {
      return { targetName: file.name, content: '', note: 'file could not be read' };
    }
  }
  return { targetName: file.name, content: '', note: noteForBinary(file.name) };
}

function collectTextFiles(item: InspectionItem, out: Array<InspectionItem & { kind: 'file' }>, limit: number): void {
  if (out.length >= limit) return;
  if (item.kind === 'file') {
    out.push(item);
    return;
  }
  if (item.kind === 'folder') {
    for (const child of item.children) collectTextFiles(child, out, limit);
  }
}

/**
 * Extract bounded raw text from one or more inspected objects. Returns one
 * entry per object; entries for binary/media carry an explanatory note and no
 * content. Reading is bounded (8 MB per file) and the caller clips each entry
 * to the configured budget before anything is sent.
 */
export async function extractRawContentForAi(items: InspectionItem[], signal: AbortSignal): Promise<RawContentInput[]> {
  const outputs: RawContentInput[] = [];
  for (const item of items) {
    if (item.kind === 'url') {
      outputs.push({
        targetName: item.name,
        content: '',
        note: 'website content is not sent; only the structured analysis is included'
      });
      continue;
    }
    if (item.kind === 'folder') {
      const files: Array<InspectionItem & { kind: 'file' }> = [];
      collectTextFiles(item, files, FOLDER_SAMPLE_FILES);
      if (!files.length) {
        outputs.push({
          targetName: item.name,
          content: '',
          note: 'no text-like files found to sample; only the structured folder analysis is included'
        });
        continue;
      }
      const sampled: RawContentInput[] = [];
      for (const file of files) {
        const entry = await extractFileContent(file, signal);
        if (entry.content.trim()) sampled.push(entry);
      }
      const content = sampled.map((entry) => `--- ${entry.targetName} ---\n${entry.content}`).join('\n\n');
      outputs.push({
        targetName: item.name,
        content,
        note: `sample of up to ${files.length} text file(s) inside the folder`
      });
      continue;
    }
    outputs.push(await extractFileContent(item, signal));
  }
  return outputs;
}
