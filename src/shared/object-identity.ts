// Filename + content identity checks for single-file analysis.
//
// Everything here is read-only and treats all bytes as inert data:
// - filenameChecks(): conservative filename/path anomaly heuristics (double
//   extensions, executable-looking suffixes, RTL/bidi/control characters,
//   overlong names). Benign international names are never flagged.
// - contentIdentityChecks(): magic/header sniffing used to detect extension/
//   content mismatches and trivially-truncated containers. It never decodes
//   or executes payloads and never claims a precise format from weak evidence.
import type { Evidence, Finding } from './types.ts';
import { evidence } from './analysis-utils.ts';

/* ------------------------------------------------------------------ */
/* Filename anomalies                                                 */
/* ------------------------------------------------------------------ */

const EXEC_SUFFIXES = new Set(['exe', 'com', 'bat', 'cmd', 'scr', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'jar', 'dll', 'msi', 'hta', 'cpl', 'lnk', 'apk', 'app']);
const NOTABLE_MIDDLE_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'ps1', 'vbs', 'sh', 'py', 'js', 'jar', 'dll', 'msi',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'pdf', 'doc', 'docx', 'xls', 'xlsx',
  'csv', 'json', 'xml', 'db', 'sqlite', 'sql', 'html', 'htm', 'php', 'txt', 'md', 'log', 'bak', 'dat', 'img', 'iso'
]);
const BENIGN_COMPOUND_SUFFIXES = new Set(['tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst', 'zip.gz', 'csv.gz', 'log.gz', 'txt.gz', 'json.gz', 'jsonl.gz']);

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function basenameOf(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

/** Human-readable description for a suspicious control/bidi code point. */
function describeCodePoint(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  const names: Record<number, string> = {
    0x202a: 'LEFT-TO-RIGHT EMBEDDING', 0x202b: 'RIGHT-TO-LEFT EMBEDDING',
    0x202c: 'POP DIRECTIONAL FORMATTING', 0x202d: 'LEFT-TO-RIGHT OVERRIDE',
    0x202e: 'RIGHT-TO-LEFT OVERRIDE', 0x200e: 'LEFT-TO-RIGHT MARK',
    0x200f: 'RIGHT-TO-LEFT MARK', 0x2066: 'LEFT-TO-RIGHT ISOLATE',
    0x2067: 'RIGHT-TO-LEFT ISOLATE', 0x2068: 'FIRST STRONG ISOLATE',
    0x2069: 'POP DIRECTIONAL ISOLATE'
  };
  const known = names[code] ? ` ${names[code]}` : '';
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}${known}`;
}

export interface IdentityChecks {
  evidence: Evidence[];
  findings: Finding[];
}

export function filenameChecks(name: string): IdentityChecks {
  const base = basenameOf(name);
  const evidenceList: Evidence[] = [];
  const findings: Finding[] = [];

  // 1) Executable-looking double extensions (classic malware masquerade).
  const parts = base.split('.');
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (lowerParts.length >= 3 && EXEC_SUFFIXES.has(lowerParts[lowerParts.length - 1])) {
    const label = 'filename-exec-double-ext';
    const value = `"${base}" ends in a double extension with an executable suffix (.${lowerParts[lowerParts.length - 1]})`;
    evidenceList.push(evidence(label, 'Filename', value));
    findings.push({
      id: 'filename-exec-double-extension',
      title: 'Executable-looking double extension',
      summary: `"${base}" combines an ordinary-looking extension with a final executable suffix (.${lowerParts[lowerParts.length - 1]}).`,
      severity: 'medium',
      evidence: [label],
      methodology: 'heuristic',
      confidence: 'high',
      category: 'other'
    });
  } else if (lowerParts.length >= 3 && !BENIGN_COMPOUND_SUFFIXES.has(lowerParts.slice(-2).join('.'))) {
    // 2) Ambiguous multi-extension names (e.g. data.csv.json.txt, script.py.txt.md).
    const middle = lowerParts.slice(1, -1).filter((part) => NOTABLE_MIDDLE_EXTENSIONS.has(part));
    if (middle.length) {
      const label = 'filename-multi-ext';
      const value = `"${base}" has ${lowerParts.length - 1} extensions (${middle.join(', ')})`;
      evidenceList.push(evidence(label, 'Filename', value));
      findings.push({
        id: 'filename-multiple-extensions',
        title: 'Ambiguous multiple extensions',
        summary: `"${base}" contains several extension-like segments; the real type may be misleading.`,
        severity: 'low',
        evidence: [label],
        methodology: 'heuristic',
        confidence: 'medium',
        category: 'other'
      });
    }
  }

  // 3) RTL/bidi/control characters (spoofing vectors).
  const suspicious: string[] = [];
  for (const char of base) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x202a || code === 0x202b || code === 0x202c || code === 0x202d || code === 0x202e ||
        code === 0x200e || code === 0x200f || code === 0x2066 || code === 0x2067 || code === 0x2068 || code === 0x2069 ||
        code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      suspicious.push(describeCodePoint(char));
    }
  }
  if (suspicious.length) {
    const label = 'filename-control-chars';
    const value = `${suspicious.join(', ')} present in "${base}"`;
    evidenceList.push(evidence(label, 'Filename', value));
    findings.push({
      id: 'filename-control-characters',
      title: 'Unicode control/bidi characters in filename',
      summary: `The filename contains ${suspicious.length} control/bidi character(s) (${suspicious.slice(0, 3).join(', ')}), which can be used to spoof what a file really is.`,
      severity: 'low',
      evidence: [label],
      methodology: 'heuristic',
      confidence: 'high',
      category: 'other'
    });
  }

  // 4) Overlong names (path-length pressure).
  if (base.length > 200) {
    const label = 'filename-long';
    const value = `${base.length} characters`;
    evidenceList.push(evidence(label, 'Filename length', value));
    findings.push({
      id: 'filename-overlong',
      title: 'Unusually long filename',
      summary: `The filename is ${base.length} characters, close to common filesystem limits.`,
      severity: 'info',
      evidence: [label],
      methodology: 'anomaly',
      confidence: 'high',
      category: 'other',
      metrics: { length: base.length }
    });
  }

  return { evidence: evidenceList, findings };
}

/* ------------------------------------------------------------------ */
/* Content identity (magic sniffing + trivial truncation)             */
/* ------------------------------------------------------------------ */

interface DetectedFormat {
  id: string;
  label: string;
  ext: string; // canonical extension (lowercase, no dot)
}

function hasBytes(head: Uint8Array, offset: number, bytes: number[]): boolean {
  if (offset + bytes.length > head.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (head[offset + index] !== bytes[index]) return false;
  }
  return true;
}

function asciiAt(head: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > head.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (head[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function readUint32LE(head: Uint8Array, offset: number): number {
  return head[offset] + head[offset + 1] * 0x100 + head[offset + 2] * 0x10000 + head[offset + 3] * 0x1000000;
}

function readUint32BE(head: Uint8Array, offset: number): number {
  return head[offset] * 0x1000000 + head[offset + 1] * 0x10000 + head[offset + 2] * 0x100 + head[offset + 3];
}

/** Detect a small set of strongly signatured formats from the head bytes. */
export function detectContentFormats(head: Uint8Array): DetectedFormat[] {
  const out: DetectedFormat[] = [];
  const add = (id: string, label: string, ext: string) => out.push({ id, label, ext });
  if (hasBytes(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) add('png', 'PNG image', 'png');
  if (hasBytes(head, 0, [0xff, 0xd8, 0xff])) add('jpeg', 'JPEG image', 'jpg');
  if (asciiAt(head, 0, 'GIF8')) add('gif', 'GIF image', 'gif');
  if (asciiAt(head, 0, 'RIFF') && asciiAt(head, 8, 'WEBP')) add('webp', 'WebP image', 'webp');
  if (asciiAt(head, 0, 'BM') && head.length >= 18) add('bmp', 'BMP image', 'bmp');
  if (asciiAt(head, 0, '%PDF-')) add('pdf', 'PDF document', 'pdf');
  if (hasBytes(head, 0, [0x50, 0x4b, 0x03, 0x04]) || hasBytes(head, 0, [0x50, 0x4b, 0x05, 0x06]) || hasBytes(head, 0, [0x50, 0x4b, 0x07, 0x08])) add('zip', 'ZIP archive', 'zip');
  if (hasBytes(head, 0, [0x1f, 0x8b])) add('gzip', 'gzip stream', 'gz');
  if (head.length >= 262 && asciiAt(head, 257, 'ustar')) add('tar', 'tar archive', 'tar');
  if (hasBytes(head, 0, [0x7f, 0x45, 0x4c, 0x46])) add('elf', 'ELF executable', 'elf');
  if (asciiAt(head, 0, 'MZ') && head.length >= 64) add('pe', 'PE executable', 'exe');
  if (asciiAt(head, 0, 'RIFF')) {
    if (asciiAt(head, 8, 'WAVE')) add('wav', 'WAV audio (RIFF/WAVE)', 'wav');
    else if (asciiAt(head, 8, 'AVI ')) add('avi', 'AVI video (RIFF/AVI)', 'avi');
    else add('riff', 'RIFF container', 'riff');
  }
  if (asciiAt(head, 0, 'ID3')) add('id3', 'MP3 with ID3 tag', 'mp3');
  if (head.length >= 3 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && head[1] !== 0xfe && head[1] !== 0xff) add('mp3sync', 'MPEG audio frame', 'mp3');
  if (asciiAt(head, 0, 'fLaC')) add('flac', 'FLAC audio', 'flac');
  if (asciiAt(head, 0, 'OggS')) add('ogg', 'Ogg container', 'ogg');
  if (hasBytes(head, 0, [0x1a, 0x45, 0xdf, 0xa3])) add('ebml', 'Matroska/WebM (EBML)', 'mkv');
  if (head.length >= 12 && asciiAt(head, 4, 'ftyp')) add('mp4', 'MP4/MOV media', 'mp4');
  if (asciiAt(head, 0, 'SQLite format 3')) add('sqlite', 'SQLite database', 'sqlite');
  return out;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const MEDIA_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'ogg', 'mp4', 'm4a', 'mov', 'mkv', 'webm', 'avi']);
const STRONG_EXTENSIONS = new Set(['pdf', 'zip', 'gz', 'gzip', 'tar', 'sqlite', 'db']);
const TEXTUAL_CLAIM_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'log', 'ini', 'yaml', 'yml', 'toml', 'html', 'htm']);

function truncatedNotes(head: Uint8Array, totalSize: number): Array<{ id: string; label: string; value: string }> {
  const notes: Array<{ id: string; label: string; value: string }> = [];
  // RIFF (WAV/AVI): declared chunk size = file length - 8.
  if (asciiAt(head, 0, 'RIFF') && head.length >= 8) {
    const declared = readUint32LE(head, 4);
    if (declared > 0 && totalSize < 8 + declared) {
      notes.push({ id: 'content-truncated', label: 'Container', value: `RIFF declares ${declared} content bytes but only ${Math.max(0, totalSize - 8)} are present` });
    }
  }
  // ID3v2: tag size is syncsafe at bytes 6..10.
  if (asciiAt(head, 0, 'ID3') && head.length >= 10) {
    const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    if (size > 0 && totalSize < 10 + size) {
      notes.push({ id: 'content-truncated', label: 'Container', value: `ID3 tag declares ${size} bytes but the file is only ${totalSize} bytes` });
    }
  }
  // MP4/MOV: box size at bytes 0..4.
  if (head.length >= 8 && asciiAt(head, 4, 'ftyp')) {
    const box = readUint32BE(head, 0);
    if (box > 0 && totalSize < box) {
      notes.push({ id: 'content-truncated', label: 'Container', value: `MP4 box declares ${box} bytes but the file is only ${totalSize} bytes` });
    }
  }
  // Ogg: first page length from the segment table.
  if (asciiAt(head, 0, 'OggS') && head.length >= 28) {
    const segCount = head[26];
    const tableEnd = 27 + segCount;
    if (head.length >= tableEnd) {
      let pageLen = tableEnd;
      for (let index = 27; index < tableEnd; index += 1) pageLen += head[index];
      if (pageLen > totalSize) {
        notes.push({ id: 'content-truncated', label: 'Container', value: `first Ogg page spans ${pageLen} bytes but the file is only ${totalSize} bytes` });
      }
    }
  }
  // PNG: chunk walk (declared chunk length must fit inside the file).
  if (hasBytes(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    let offset = 8;
    let sawEnd = false;
    while (offset + 8 <= head.length) {
      const length = readUint32BE(head, offset);
      if (length < 0 || offset + 12 + length > totalSize) {
        if (!sawEnd) {
          notes.push({ id: 'content-truncated', label: 'Container', value: `PNG chunk at offset ${offset} declares ${length} bytes beyond the end of the file` });
        }
        break;
      }
      const type = String.fromCharCode(head[offset + 4], head[offset + 5], head[offset + 6], head[offset + 7]);
      offset += 12 + length;
      if (type === 'IEND') { sawEnd = true; break; }
    }
    if (!sawEnd && totalSize > 8 && offset <= totalSize && offset <= head.length) {
      // Reached the end of the head without IEND: only suspicious when we hold
      // the whole file (small file) or when the head already covers the end.
      if (totalSize <= head.length) {
        notes.push({ id: 'content-no-end', label: 'Container', value: 'PNG image has no IEND chunk (truncated or corrupt)' });
      }
    }
  }
  return notes;
}

export function contentIdentityChecks(name: string, head: Uint8Array, totalSize: number): IdentityChecks {
  const evidenceList: Evidence[] = [];
  const findings: Finding[] = [];
  if (!head.length || totalSize <= 0) return { evidence: evidenceList, findings };
  const base = basenameOf(name);
  const ext = extensionOf(base);
  const detected = detectContentFormats(head);

  if (detected.length) {
    const primary = detected[0];
    evidenceList.push(evidence('content-detected', 'Detected format', `${primary.label} (${primary.id})`));
  }

  const claimed = ext;
  const canonicalByExt = new Map<string, string>([
    ['png', 'png'], ['jpg', 'jpeg'], ['jpeg', 'jpeg'], ['gif', 'gif'], ['webp', 'webp'], ['bmp', 'bmp'],
    ['pdf', 'pdf'], ['zip', 'zip'], ['gz', 'gzip'], ['gzip', 'gzip'], ['tar', 'tar'],
    ['mp3', 'id3'], ['wav', 'wav'], ['avi', 'avi'], ['flac', 'flac'], ['ogg', 'ogg'],
    ['mkv', 'ebml'], ['webm', 'ebml'], ['mp4', 'mp4'], ['mov', 'mp4'], ['m4a', 'mp4'], ['sqlite', 'sqlite'], ['db', 'sqlite']
  ]);

  // A) Extension/content mismatch when the sniffed type conflicts with the
  //    claimed extension (applies to image/media/strong and textual claims).
  const isClaim = IMAGE_EXTENSIONS.has(claimed) || MEDIA_EXTENSIONS.has(claimed) || STRONG_EXTENSIONS.has(claimed) || TEXTUAL_CLAIM_EXTENSIONS.has(claimed);
  if (isClaim && detected.length) {
    const matching = detected.some((format) => format.ext === claimed || (claimed === 'jpg' && format.ext === 'jpg') || (claimed === 'gz' && format.ext === 'gz'));
    const isGenericClaim = claimed === 'txt' || claimed === 'dat' || claimed === 'bin' || claimed === 'log' || claimed === 'bak' || claimed === 'md' || claimed === 'csv' || claimed === 'json' || claimed === 'xml';
    if (!matching || (isGenericClaim && (detected[0].ext === 'png' || detected[0].ext === 'jpeg' || detected[0].ext === 'gif' || detected[0].ext === 'zip' || detected[0].ext === 'gzip' || detected[0].ext === 'pdf' || detected[0].ext === 'elf' || detected[0].ext === 'exe'))) {
      const primary = detected[0];
      const label = 'content-ext-mismatch';
      evidenceList.push(evidence(label, 'Extension/content mismatch', `${primary.label} content inside a .${claimed} file`));
      findings.push({
        id: 'content-extension-mismatch',
        title: 'Extension does not match content',
        summary: `The file is named ".${claimed}" but its content is detected as ${primary.label}.`,
        severity: 'medium',
        evidence: ['content-detected', label],
        methodology: 'fact',
        confidence: 'high',
        category: 'other'
      });
    }
  }

  // B) Claimed signature absent (file claims a magic-identified format but the
  //    head shows none of it).
  if (IMAGE_EXTENSIONS.has(claimed) || MEDIA_EXTENSIONS.has(claimed) || claimed === 'pdf' || claimed === 'zip' || claimed === 'gz' || claimed === 'gzip' || claimed === 'tar') {
    const expected = canonicalByExt.get(claimed);
    const matchesExpected = expected ? detected.some((format) => format.id === expected || (expected === 'jpeg' && format.id === 'jpeg')) : true;
    const looksBinary = head.some((value) => value === 0) || head.length < 16 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(String.fromCharCode(...head.slice(0, Math.min(head.length, 64))));
    if (!matchesExpected && !detected.length && looksBinary) {
      const label = 'content-ext-unrecognized';
      evidenceList.push(evidence(label, 'Content', `No ${claimed.toUpperCase()} signature found in the first bytes`));
      findings.push({
        id: 'content-extension-unrecognized',
        title: `Content does not validate as ${claimed.toUpperCase()}`,
        summary: `The extension claims ${claimed.toUpperCase()} but no matching signature was found in the file head; the content may be corrupt, random, or mislabeled.`,
        severity: 'low',
        evidence: [label],
        methodology: 'heuristic',
        confidence: 'medium',
        category: 'other'
      });
    }
  }

  // C) Trivially-truncated containers.
  for (const note of truncatedNotes(head, totalSize)) {
    evidenceList.push(evidence(note.id === 'content-no-end' ? 'content-no-end' : 'content-truncated', note.label, note.value));
    if (note.id === 'content-no-end') {
      findings.push({
        id: 'content-container-truncated',
        title: 'Truncated or corrupt container',
        summary: note.value,
        severity: 'medium',
        evidence: ['content-no-end'],
        methodology: 'fact',
        confidence: 'high',
        category: 'structure'
      });
    } else {
      findings.push({
        id: 'content-container-truncated',
        title: 'Truncated or corrupt container',
        summary: note.value,
        severity: 'medium',
        evidence: ['content-truncated'],
        methodology: 'fact',
        confidence: 'high',
        category: 'structure'
      });
    }
  }

  // D) Executable-format content (informational; never executed).
  const executableFormat = detected.find((format) => format.id === 'elf' || format.id === 'pe');
  if (executableFormat) {
    const label = 'content-executable-format';
    evidenceList.push(evidence(label, 'Executable format', executableFormat.label));
    findings.push({
      id: 'content-executable-format',
      title: 'Executable-format content detected',
      summary: `${executableFormat.label} header detected. Content is treated as inert data and is never executed.`,
      severity: 'info',
      evidence: [label, 'content-detected'],
      methodology: 'fact',
      confidence: 'high',
      category: 'other'
    });
  }

  return { evidence: evidenceList, findings };
}