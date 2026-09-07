// Read-only Git metadata analysis for individual files inside .git.
// Never executes git, never runs hooks, never mutates anything. Operates only
// on the bytes of the file being inspected; repository-wide facts that cannot
// be derived from a single file (e.g. dangling object checks) are reported as
// limitations instead of fabricated findings.
import type { AnalysisResult, Evidence, Finding, InspectionFile } from './types.ts';
import { evidence, ensureNotAborted } from './analysis-utils.ts';
import { formatNumber } from './utils.ts';

const HASH_RE = /^[0-9a-f]{40}$/;

function gitRelativePath(pathValue: string): string | null {
  const normalized = pathValue.replace(/\\/g, '/');
  const idx = normalized.indexOf('/.git/');
  if (idx < 0) return null;
  const rel = normalized.slice(idx + '/.git/'.length);
  return rel || null;
}

function buildResult(file: InspectionFile, format: string, items: Evidence[], unusual: Finding[], limitations: string[], summary: string): AnalysisResult {
  return {
    objectKind: 'file',
    analyzerId: 'git',
    analyzerName: 'Git metadata analyzer',
    capabilities: ['metadata', 'reflog', 'refs'],
    limitations: limitations.length ? limitations : ['Read-only metadata inspection'],
    targetName: file.name,
    identity: {
      name: file.name,
      type: 'git metadata',
      format,
      mimeType: file.mimeType,
      size: file.size,
      location: file.path,
      fingerprint: String(file.size)
    },
    sections: [{ id: 'git-facts', title: 'Facts', items }],
    important: [],
    unusual,
    recommendations: [],
    evidence: items,
    progressLabel: 'Git metadata analysis complete',
    cacheKey: String(file.size),
    generatedAt: new Date().toISOString(),
    sourceSummary: summary
  };
}

function analyzeReflog(file: InspectionFile, text: string): AnalysisResult | null {
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0);
  const items: Evidence[] = [
    evidence('git-lines', 'Reflog entries', formatNumber(lines.length))
  ];
  const unusual: Finding[] = [];
  let malformed = 0;
  const tsAnomalies: string[] = [];
  const now = Date.now() / 1000;
  const futureWindow = 365 * 24 * 60 * 60;
  for (const line of lines) {
    const tabIndex = line.indexOf('\t');
    const meta = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
    const valid = meta.match(/^[0-9a-f]{40} [0-9a-f]{40} .* <.*> (-?\d+) [+-]\d{4}$/);
    if (!valid) {
      malformed += 1;
      continue;
    }
    const ts = Number(valid[1]);
    if (ts < 0) tsAnomalies.push('negative timestamp ' + ts);
    else if (ts > now + futureWindow) tsAnomalies.push('far-future timestamp ' + ts);
  }
  if (malformed > 0) {
    items.push(evidence('git-malformed', 'Malformed lines', formatNumber(malformed)));
    unusual.push({
      id: 'git-reflog-malformed',
      title: 'Malformed reflog lines',
      summary: malformed + ' reflog line(s) could not be parsed as <old> <new> author <email> <ts> <tz>.',
      severity: 'low',
      evidence: ['git-malformed'],
      methodology: 'heuristic',
      confidence: 'high',
      category: 'quality',
      metrics: { malformed }
    });
  }
  if (tsAnomalies.length) {
    items.push(evidence('git-timestamp-anomalies', 'Timestamp anomalies', tsAnomalies.slice(0, 3).join(', ')));
    unusual.push({
      id: 'git-reflog-timestamp-anomaly',
      title: 'Reflog timestamp anomalies',
      summary: tsAnomalies.length + ' reflog timestamp(s) are negative or in the far future (' + tsAnomalies.slice(0, 2).join(', ') + ').',
      severity: 'medium',
      evidence: ['git-timestamp-anomalies'],
      methodology: 'anomaly',
      confidence: 'high',
      category: 'metadata',
      metrics: { anomalies: tsAnomalies.length }
    });
  }
  return buildResult(file, 'Git reflog', items, unusual, [], lines.length + ' reflog entries');
}

function analyzeRef(file: InspectionFile, text: string): AnalysisResult | null {
  const target = text.trim();
  const items: Evidence[] = [evidence('git-ref-target', 'Ref target', target || '(empty)')];
  const unusual: Finding[] = [];
  const limitations: string[] = [];
  if (!HASH_RE.test(target)) {
    unusual.push({
      id: 'git-ref-malformed',
      title: 'Malformed ref target',
      summary: 'The ref does not contain a valid 40-character object hash.',
      severity: 'low',
      evidence: ['git-ref-target'],
      methodology: 'heuristic',
      confidence: 'high',
      category: 'quality'
    });
  }
  limitations.push('Dangling/unreachable-object checks require the repository object store, which is not available for an isolated ref file.');
  return buildResult(file, 'Git ref', items, unusual, limitations, '1 ref');
}

export async function analyzeGitMetadataFile(file: InspectionFile, options: { signal: AbortSignal }): Promise<AnalysisResult | null> {
  ensureNotAborted(options.signal);
  const rel = gitRelativePath(file.path);
  if (!rel) return null;
  if (file.size > 2 * 1024 * 1024) return null;
  const bytes = new Uint8Array(await file.file.slice(0, 2 * 1024 * 1024).arrayBuffer());
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (rel.startsWith('logs/')) return analyzeReflog(file, text);
  if (rel.startsWith('refs/')) return analyzeRef(file, text);
  if (rel === 'HEAD') {
    const trimmed = text.trim();
    const items: Evidence[] = [evidence('git-head', 'HEAD', trimmed || '(empty)')];
    const unusual: Finding[] = [];
    if (/^ref:\s+refs\/heads\//.test(trimmed)) {
      // symbolic HEAD
    } else if (HASH_RE.test(trimmed)) {
      // detached HEAD
    } else {
      unusual.push({ id: 'git-head-malformed', title: 'Malformed HEAD', summary: 'HEAD is neither a symbolic ref nor a detached object hash.', severity: 'low', evidence: ['git-head'], methodology: 'heuristic', confidence: 'high', category: 'quality' });
    }
    return buildResult(file, 'Git HEAD', items, unusual, [], 'HEAD metadata');
  }
  return null;
}