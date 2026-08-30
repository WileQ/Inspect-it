import type { AnalysisResult, AnalysisSection, Evidence, Finding, InspectionFile, InspectionFolder, InspectionItem } from './types.ts';
import { digestHex, formatDate, formatNumber, percent, shortFingerprint } from './utils.ts';
import {
  ensureNotAborted,
  evidence,
  extension,
  finding,
  limitArray,
  normalizePath,
  parseXml,
  readText,
  searchAll,
  textSummary
} from './analysis-utils.ts';
import { temporalSpikes } from './anomaly.ts';

const sourceExtensions = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php', 'rb', 'swift', 'kt', 'kts', 'html', 'htm', 'css', 'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1']);
const logExtensions = new Set(['log', 'out', 'err', 'trace', 'svlog']);

type ManifestKind = 'package-json' | 'requirements' | 'pyproject' | 'cargo' | 'gomod' | 'pom' | 'gradle' | 'composer' | 'gemfile';

export interface ProjectSignals {
  sourceFiles: number;
  logFiles: number;
  manifestFiles: string[];
  languageCounts: Map<string, number>;
  todoCount: number;
  fixmeCount: number;
  largestFiles: Array<{ name: string; size: number; path: string }>;
  git?: GitSignals;
}

export interface GitSignals {
  branches: string[];
  commitCount: number;
  contributors: Array<[string, number]>;
  lastCommit?: string;
  branchHead?: string;
}

function identity(file: InspectionFile, analyzerName: string, fingerprint: string, format: string): AnalysisResult['identity'] {
  return {
    name: file.name,
    type: analyzerName,
    format,
    mimeType: file.mimeType || 'text/plain',
    size: file.size,
    location: file.path,
    created: formatDate(file.lastModified),
    modified: formatDate(file.lastModified),
    fingerprint: shortFingerprint(fingerprint)
  };
}

function buildResult(
  file: InspectionFile,
  analyzerId: string,
  analyzerName: string,
  format: string,
  fingerprint: string,
  capabilities: string[],
  limitations: string[],
  sections: AnalysisSection[],
  evidenceList: Evidence[],
  important: Finding[],
  unusual: Finding[],
  recommendations: Finding[],
  sourceSummary: string,
  extra?: { visualizations?: AnalysisResult['visualizations']; relationships?: AnalysisResult['relationships'] }
): AnalysisResult {
  return {
    objectKind: 'file',
    analyzerId,
    analyzerName,
    capabilities,
    limitations,
    targetName: file.name,
    identity: identity(file, analyzerName, fingerprint, format),
    sections,
    important,
    unusual,
    recommendations,
    evidence: evidenceList,
    progressLabel: `${analyzerName} complete`,
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary,
    ...(extra?.visualizations ? { visualizations: extra.visualizations } : {}),
    ...(extra?.relationships ? { relationships: extra.relationships } : {})
  };
}

function isManifestName(name: string): boolean {
  const lower = name.toLowerCase();
  return [
    'package.json',
    'requirements.txt',
    'pyproject.toml',
    'cargo.toml',
    'go.mod',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'composer.json',
    'gemfile'
  ].includes(lower);
}

function manifestKind(file: InspectionFile): ManifestKind | null {
  const lower = file.name.toLowerCase();
  if (lower === 'package.json') return 'package-json';
  if (lower === 'requirements.txt') return 'requirements';
  if (lower === 'pyproject.toml') return 'pyproject';
  if (lower === 'cargo.toml') return 'cargo';
  if (lower === 'go.mod') return 'gomod';
  if (lower === 'pom.xml') return 'pom';
  if (lower === 'build.gradle' || lower === 'build.gradle.kts') return 'gradle';
  if (lower === 'composer.json') return 'composer';
  if (lower === 'gemfile') return 'gemfile';
  return null;
}

function normalizeLine(line: string): string {
  return line.replace(/\b\d+\b/g, '#').replace(/\s+/g, ' ').trim();
}

function commentStyle(extensionName: string): RegExp[] {
  switch (extensionName) {
    case 'py':
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'rb':
    case 'toml':
    case 'ini':
      return [/^\s*#/];
    case 'html':
    case 'htm':
    case 'xml':
      return [/^\s*<!--/];
    default:
      return [/^\s*\/\//, /^\s*\/\*/, /^\s*\*/];
  }
}

function countCommentLines(lines: string[], ext: string): number {
  const patterns = commentStyle(ext);
  return lines.filter((line) => patterns.some((pattern) => pattern.test(line))).length;
}

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((total, pattern) => total + (text.match(pattern)?.length ?? 0), 0);
}

function detectLanguage(file: InspectionFile): string {
  const ext = extension(file.name);
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'TypeScript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'JavaScript';
    case 'py':
      return 'Python';
    case 'rs':
      return 'Rust';
    case 'go':
      return 'Go';
    case 'java':
      return 'Java';
    case 'c':
      return 'C';
    case 'cc':
    case 'cpp':
    case 'h':
    case 'hpp':
      return 'C++';
    case 'cs':
      return 'C#';
    case 'php':
      return 'PHP';
    case 'rb':
      return 'Ruby';
    case 'swift':
      return 'Swift';
    case 'kt':
    case 'kts':
      return 'Kotlin';
    case 'html':
    case 'htm':
      return 'HTML';
    case 'css':
      return 'CSS';
    case 'sql':
      return 'SQL';
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'ps1':
      return 'Shell';
    default:
      return 'Text';
  }
}

function codePatterns(ext: string): { functions: RegExp[]; classes: RegExp[]; imports: RegExp[] } {
  switch (ext) {
    case 'py':
      return {
        functions: [/^\s*def\s+\w+\s*\(/gm],
        classes: [/^\s*class\s+\w+/gm],
        imports: [/^\s*import\s+\w+/gm, /^\s*from\s+\w+/gm]
      };
    case 'rs':
      return {
        functions: [/^\s*fn\s+\w+/gm],
        classes: [/^\s*struct\s+\w+/gm, /^\s*enum\s+\w+/gm, /^\s*trait\s+\w+/gm],
        imports: [/^\s*use\s+/gm, /^\s*mod\s+\w+/gm]
      };
    case 'go':
      return {
        functions: [/^\s*func\s+(?:\([^)]+\)\s*)?\w+/gm],
        classes: [/^\s*type\s+\w+\s+struct/gm],
        imports: [/^\s*import\s*\(/gm, /^\s*import\s+"/gm]
      };
    case 'java':
    case 'cs':
    case 'c':
    case 'cc':
    case 'cpp':
    case 'h':
    case 'hpp':
    case 'php':
    case 'rb':
    case 'swift':
    case 'kt':
    case 'kts':
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return {
        functions: [/^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/gm, /^\s*\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/gm, /^\s*(?:public|private|protected)?\s*(?:static\s+)?\w+[<\w,\s>]*\s+\w+\s*\(/gm],
        classes: [/^\s*class\s+\w+/gm, /^\s*(?:struct|interface|enum|trait)\s+\w+/gm],
        imports: [/^\s*import\s+/gm, /^\s*from\s+/gm, /^\s*using\s+/gm, /^\s*#include\s+/gm, /^\s*require\s*\(/gm]
      };
    default:
      return {
        functions: [/^\s*function\s+\w+/gm, /^\s*def\s+\w+/gm, /^\s*fn\s+\w+/gm],
        classes: [/^\s*class\s+\w+/gm],
        imports: [/^\s*import\s+/gm, /^\s*from\s+/gm, /^\s*require\s*\(/gm]
      };
  }
}

export interface FunctionMetric {
  name: string;
  startLine: number;
  endLine: number;
  lines: number;
  cyclomatic: number;
  nesting: number;
}

function isPythonLike(ext: string): boolean {
  return ext === 'py';
}

function decisionCount(span: string): number {
  const matches = span.match(/\b(?:if|elif|for|while|case|catch|except|switch)\b/g) ?? [];
  const operators = span.match(/&&|\|\||\?\?|\belse if\b/g) ?? [];
  const ternaries = span.match(/\?[^:]+:/g) ?? [];
  return matches.length + operators.length + ternaries.length;
}

function braceDepth(line: string): number {
  let depth = 0;
  for (const char of line) {
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
  }
  return depth;
}

function functionStartPatterns(ext: string): RegExp[] {
  if (isPythonLike(ext)) {
    return [/^\s*def\s+\w+\s*\(/];
  }
  if (ext === 'rs') {
    return [/^\s*fn\s+\w+/];
  }
  if (ext === 'go') {
    return [/^\s*func\s+(?:\([^)]*\)\s*)?\w+/];
  }
  return [/^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/];
}

/** Approximate per-function metrics via brace/indent scanning. Heuristic, not AST. */
export function analyzeFunctionMetrics(text: string, ext: string): FunctionMetric[] {
  const lines = text.split(/\r?\n/);
  const patterns = functionStartPatterns(ext);
  const metrics: FunctionMetric[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const startMatch = patterns.some((pattern) => pattern.test(line));
    if (!startMatch) continue;
    const nameMatch = line.match(/(?:function|def|fn|func)\s+([A-Za-z_$][\w$]*)/);
    const name = nameMatch ? nameMatch[1] : `line ${index + 1}`;
    let endLine = index;
    if (isPythonLike(ext)) {
      const bodyIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
      let inBody = false;
      for (let scan = index + 1; scan < lines.length; scan += 1) {
        const current = lines[scan];
        const trimmed = current.trim();
        if (!trimmed) continue;
        const indent = current.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (!inBody) {
          if (indent > bodyIndent) inBody = true;
          else continue;
        }
        if (indent <= bodyIndent && !trimmed.startsWith('#')) {
          endLine = scan - 1;
          break;
        }
        endLine = scan;
      }
    } else {
      let balance = 0;
      let started = false;
      for (let scan = index; scan < lines.length; scan += 1) {
        const current = lines[scan];
        const depth = braceDepth(current);
        balance += depth;
        if (depth > 0) started = true;
        if (started && balance <= 0 && scan > index) {
          endLine = scan;
          break;
        }
        endLine = scan;
      }
    }
    const span = lines.slice(index, endLine + 1).join('\n');
    const nesting = isPythonLike(ext)
      ? Math.max(0, ...span.split(/\r?\n/).map((l) => l.match(/^(\s*)/)?.[1]?.length ?? 0)) - (lines[index].match(/^(\s*)/)?.[1]?.length ?? 0)
      : Math.max(0, ...span.split(/\r?\n/).map(braceDepth));
    metrics.push({
      name,
      startLine: index + 1,
      endLine: endLine + 1,
      lines: endLine - index + 1,
      cyclomatic: 1 + decisionCount(span),
      nesting
    });
    index = endLine;
  }
  return metrics;
}

function detectManifestDependencies(file: InspectionFile, text: string): { name: string; directDependencies: string[]; devDependencies: string[] } {
  const lower = file.name.toLowerCase();
  if (lower === 'package.json') {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const deps = Object.keys((parsed.dependencies as Record<string, unknown>) ?? {});
      const devDeps = Object.keys((parsed.devDependencies as Record<string, unknown>) ?? {});
      return { name: 'package.json', directDependencies: deps, devDependencies: devDeps };
    } catch {
      return { name: 'package.json', directDependencies: [], devDependencies: [] };
    }
  }
  if (lower === 'requirements.txt') {
    const deps = text.split(/\r\n|\n|\r/).map((line) => line.replace(/#.*/, '').trim()).filter((line) => line && !line.startsWith('-'));
    return { name: 'requirements.txt', directDependencies: deps, devDependencies: [] };
  }
  if (lower === 'pyproject.toml') {
    const deps = searchAll(text, /^\s*([A-Za-z0-9_.-]+)\s*=\s*["'][^"']+["']/gm);
    return { name: 'pyproject.toml', directDependencies: deps, devDependencies: [] };
  }
  if (lower === 'cargo.toml') {
    const deps = searchAll(text, /^\s*([A-Za-z0-9_.-]+)\s*=\s*["'{]/gm);
    return { name: 'Cargo.toml', directDependencies: deps, devDependencies: [] };
  }
  if (lower === 'go.mod') {
    const deps = searchAll(text, /^\s*require\s+([^\s]+)\s+/gm);
    return { name: 'go.mod', directDependencies: deps, devDependencies: [] };
  }
  if (lower === 'pom.xml') {
    const xml = parseXml(text) as Record<string, unknown>;
    const project = (xml.project ?? xml['maven-project'] ?? xml) as Record<string, unknown>;
    const dependencies = project.dependencies as Record<string, unknown> | undefined;
    const items = dependencies?.dependency;
    const array = Array.isArray(items) ? items : items ? [items] : [];
    const deps = array.map((entry) => {
      const dep = entry as Record<string, unknown>;
      return `${String(dep.groupId ?? 'unknown')}:${String(dep.artifactId ?? 'unknown')}`;
    });
    return { name: 'pom.xml', directDependencies: deps, devDependencies: [] };
  }
  if (lower === 'build.gradle' || lower === 'build.gradle.kts') {
    const deps = searchAll(text, /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s*\(?['"]([^'"]+)['"]\)?/gm);
    return { name: lower, directDependencies: deps, devDependencies: [] };
  }
  if (lower === 'composer.json') {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const deps = Object.keys((parsed.require as Record<string, unknown>) ?? {});
      const devDeps = Object.keys((parsed['require-dev'] as Record<string, unknown>) ?? {});
      return { name: 'composer.json', directDependencies: deps, devDependencies: devDeps };
    } catch {
      return { name: 'composer.json', directDependencies: [], devDependencies: [] };
    }
  }
  if (lower === 'gemfile') {
    const deps = searchAll(text, /^\s*gem\s+['"]([^'"]+)['"]/gm);
    return { name: 'Gemfile', directDependencies: deps, devDependencies: [] };
  }
  return { name: lower, directDependencies: [], devDependencies: [] };
}

function analyzeManifest(file: InspectionFile, text: string, fingerprint: string): AnalysisResult {
  const kind = manifestKind(file) ?? 'package-json';
  const parsed = detectManifestDependencies(file, text);
  const total = parsed.directDependencies.length + parsed.devDependencies.length;
  const evidenceList: Evidence[] = [
    evidence('manifest-file', 'Manifest', parsed.name),
    evidence('manifest-dependencies', 'Direct dependencies', formatNumber(parsed.directDependencies.length)),
    evidence('manifest-dev-dependencies', 'Development dependencies', formatNumber(parsed.devDependencies.length)),
    evidence('manifest-total', 'Total dependencies', formatNumber(total))
  ];
  const sections: AnalysisSection[] = [
    { id: 'manifest-facts', title: 'Facts', items: evidenceList },
    {
      id: 'manifest-structure',
      title: 'Structure',
      items: [
        ...limitArray(parsed.directDependencies, 12).map((value, index) => evidence(`manifest-dep-${index}`, `Dependency ${index + 1}`, value)),
        ...limitArray(parsed.devDependencies, 12).map((value, index) => evidence(`manifest-dev-${index}`, `Dev dependency ${index + 1}`, value))
      ]
    }
  ];
  const unusual: Finding[] = [];
  if (parsed.directDependencies.length === 0) {
    unusual.push(finding('manifest-empty', 'No direct dependencies detected', 'The manifest does not declare direct runtime dependencies.', 'info', ['manifest-dependencies']));
  }
  const recommendations: Finding[] = [];
  if (parsed.devDependencies.length > 0) {
    recommendations.push(finding('manifest-dev-review', 'Review development dependencies', 'Development-only packages are present and may be worth auditing separately.', 'low', ['manifest-dev-dependencies']));
  }
  return buildResult(
    file,
    'manifest',
    'Dependency manifest analyzer',
    kind,
    fingerprint,
    ['dependencies', 'metadata', 'relationships'],
    ['Read-only static parsing only'],
    sections,
    evidenceList,
    [],
    unusual,
    recommendations,
    `${formatNumber(total)} dependencies declared`
  );
}

function analyzeLogLines(file: InspectionFile, text: string, fingerprint: string): AnalysisResult {
  const lines = text.split(/\r\n|\n|\r/);
  const totalLines = lines.length;
  const severityCounts = new Map<string, number>();
  const requestIds = new Set<string>();
  const normalizedErrors = new Map<string, number>();
  const stackTraces: string[] = [];
  let currentStack: string[] = [];
  for (const line of lines) {
    const severity = /\b(error|fatal|panic)\b/i.test(line) ? 'error'
      : /\bwarn(ing)?\b/i.test(line) ? 'warning'
      : /\binfo\b/i.test(line) ? 'info'
      : /\bdebug\b/i.test(line) ? 'debug'
      : null;
    if (severity) {
      severityCounts.set(severity, (severityCounts.get(severity) ?? 0) + 1);
    }
    const requestMatch = line.match(/\b(?:request[_-]?id|trace[_-]?id|correlation[_-]?id)\s*[:=]\s*([A-Za-z0-9_-]+)/i);
    if (requestMatch) {
      requestIds.add(requestMatch[1]);
    }
    if (/^\s+at\s+/.test(line) || /^\s*File\s+"/.test(line)) {
      currentStack.push(line.trim());
    } else if (currentStack.length) {
      if (currentStack.length >= 2) {
        stackTraces.push(currentStack.join('\n'));
      }
      currentStack = [];
    }
    if (severity === 'error') {
      const normalized = normalizeLine(line);
      normalizedErrors.set(normalized, (normalizedErrors.get(normalized) ?? 0) + 1);
    }
  }
  if (currentStack.length >= 2) {
    stackTraces.push(currentStack.join('\n'));
  }
  const errorCount = severityCounts.get('error') ?? 0;
  const warningCount = severityCounts.get('warning') ?? 0;
  const infoCount = severityCounts.get('info') ?? 0;
  const debugCount = severityCounts.get('debug') ?? 0;
  const errorRatio = totalLines ? errorCount / totalLines : 0;
  const mostCommonError = [...normalizedErrors.entries()].sort((left, right) => right[1] - left[1])[0];
  const bucketSize = 100;
  const buckets: number[] = [];
  for (let index = 0; index < lines.length; index += bucketSize) {
    const slice = lines.slice(index, index + bucketSize);
    buckets.push(slice.filter((line) => /\b(error|fatal|panic)\b/i.test(line)).length);
  }
  const spikes = temporalSpikes(buckets, { k: 3, minZ: 2, minCount: 3 });
  const spike = spikes[0];
  const evidenceList: Evidence[] = [
    evidence('log-lines', 'Total lines', formatNumber(totalLines)),
    evidence('log-errors', 'Errors', formatNumber(errorCount)),
    evidence('log-warnings', 'Warnings', formatNumber(warningCount)),
    evidence('log-info', 'Info', formatNumber(infoCount)),
    evidence('log-debug', 'Debug', formatNumber(debugCount)),
    evidence('log-request-ids', 'Request IDs', formatNumber(requestIds.size)),
    evidence('log-stack-traces', 'Stack traces', formatNumber(stackTraces.length)),
    evidence('log-severity-dist', 'Severity distribution', `errors ${errorCount}, warnings ${warningCount}, info ${infoCount}, debug ${debugCount}`)
  ];
  if (spike) {
    evidenceList.push(evidence('log-spike-at', 'Error spike at', `bucket ${spike.index + 1} (lines ${spike.index * bucketSize + 1}-${(spike.index + 1) * bucketSize})`));
    evidenceList.push(evidence('log-spike-z', 'Spike z-score', spike.z.toFixed(2)));
  }
  const sections: AnalysisSection[] = [
    { id: 'log-facts', title: 'Facts', items: evidenceList },
    {
      id: 'log-errors-section',
      title: 'Structure',
      items: mostCommonError ? [evidence('log-common-error', 'Most common error', `${mostCommonError[0]} (${mostCommonError[1]} times)`)] : [evidence('log-common-error-none', 'Most common error', 'No repeated error pattern detected')]
    },
    {
      id: 'log-deep',
      title: 'Deep analysis',
      items: [
        evidence('log-severity-dist', 'Severity distribution', `errors ${errorCount}, warnings ${warningCount}, info ${infoCount}, debug ${debugCount}`),
        spike
          ? evidence('log-spike-at', 'Error spike at', `bucket ${spike.index + 1} (lines ${spike.index * bucketSize + 1}-${(spike.index + 1) * bucketSize}), ${spike.count} errors, z=${spike.z.toFixed(2)}`)
          : evidence('log-spike-none', 'Error spikes', 'No significant error spikes detected')
      ]
    }
  ];
  const unusual: Finding[] = [];
  if (errorRatio > 0.1) {
    unusual.push(finding('log-error-rate', 'High error rate', `Errors account for ${percent(errorRatio)} of log lines.`, 'medium', ['log-errors']));
  }
  if (spike) {
    unusual.push({
      id: 'log-spike',
      title: 'Error spike',
      summary: `Bucket ${spike.index + 1} contains ${spike.count} error entries (baseline mean ${spike.baselineMean.toFixed(1)} per bucket, z=${spike.z.toFixed(2)}).`,
      severity: 'medium',
      evidence: ['log-spike-at', 'log-spike-z', 'log-errors'],
      methodology: 'anomaly',
      confidence: spike.confidence,
      category: 'anomaly',
      metrics: { bucket: spike.index, count: spike.count, z: Number(spike.z.toFixed(2)) }
    });
  }
  if (stackTraces.length > 0) {
    unusual.push(finding('log-stack-trace', 'Stack traces present', 'One or more multi-line stack traces were detected.', 'low', ['log-stack-traces']));
  }
  return buildResult(
    file,
    'log',
    'Log analyzer',
    'log',
    fingerprint,
    ['timestamps', 'severity', 'errors', 'warnings', 'request-ids', 'stack-traces'],
    ['Read-only log parsing only'],
    sections,
    evidenceList,
    [],
    unusual,
    [],
    `${formatNumber(totalLines)} lines`,
    {
      visualizations: [
        {
          id: 'log-error-timeline',
          kind: 'timeline',
          title: 'Errors over time (per 100 lines)',
          labels: buckets.map((_, index) => String(index + 1)),
          values: buckets,
          unit: 'errors'
        }
      ]
    }
  );
}

function analyzeSourceCode(file: InspectionFile, text: string, fingerprint: string): AnalysisResult {
  const ext = extension(file.name);
  const lines = text.split(/\r\n|\n|\r/);
  const totalLines = lines.length;
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const commentLines = countCommentLines(lines, ext);
  const patterns = codePatterns(ext);
  const functions = countMatches(text, patterns.functions);
  const classes = countMatches(text, patterns.classes);
  const imports = countMatches(text, patterns.imports);
  const todoCount = searchAll(text, /\b(TODO|FIXME|HACK|XXX)\b/gi).length;
  const longestLine = lines.reduce((longest, line) => (line.length > longest.length ? line : longest), '');
  const repeatedLines = new Map<string, number>();
  for (const line of nonEmptyLines) {
    const normalized = normalizeLine(line);
    repeatedLines.set(normalized, (repeatedLines.get(normalized) ?? 0) + 1);
  }
  const duplicateLines = [...repeatedLines.values()].filter((count) => count > 5).reduce((acc, count) => acc + count - 1, 0);
  const maxRun = lines.reduce(
    (state, line) => {
      if (line.trim().length === 0 || /^\s*(?:\/\/|#|\/\*|\*|<!--)/.test(line)) {
        return { current: 0, max: state.max };
      }
      const current = state.current + 1;
      return { current, max: Math.max(state.max, current) };
    },
    { current: 0, max: 0 }
  ).max;
  const language = detectLanguage(file);
  const functionMetrics = analyzeFunctionMetrics(text, ext);
  const maxCyclomatic = functionMetrics.length ? Math.max(...functionMetrics.map((metric) => metric.cyclomatic)) : 0;
  const avgCyclomatic = functionMetrics.length ? functionMetrics.reduce((acc, metric) => acc + metric.cyclomatic, 0) / functionMetrics.length : 0;
  const maxFunctionLines = functionMetrics.length ? Math.max(...functionMetrics.map((metric) => metric.lines)) : 0;
  const mostComplex = [...functionMetrics].sort((left, right) => right.cyclomatic - left.cyclomatic)[0];
  const evidenceList: Evidence[] = [
    evidence('code-language', 'Language', language),
    evidence('code-lines', 'Lines', formatNumber(totalLines)),
    evidence('code-non-empty', 'Non-empty lines', formatNumber(nonEmptyLines.length)),
    evidence('code-comments', 'Comment lines', formatNumber(commentLines)),
    evidence('code-functions', 'Functions', formatNumber(functions)),
    evidence('code-classes', 'Classes', formatNumber(classes)),
    evidence('code-imports', 'Imports', formatNumber(imports)),
    evidence('code-todos', 'TODO/FIXME markers', formatNumber(todoCount)),
    evidence('code-longest-line', 'Longest line', `${longestLine.length} characters`),
    evidence('code-max-cyclomatic', 'Highest cyclomatic complexity', formatNumber(maxCyclomatic)),
    evidence('code-avg-cyclomatic', 'Average cyclomatic complexity', avgCyclomatic.toFixed(2)),
    evidence('code-max-function-lines', 'Longest function', formatNumber(maxFunctionLines) + ' lines')
  ];
  const complexityEvidence = functionMetrics
    .sort((left, right) => right.cyclomatic - left.cyclomatic)
    .slice(0, 6)
    .map((metric, index) =>
      evidence(`code-fn-${index}`, metric.name, `cyclomatic ${metric.cyclomatic}, ${metric.lines} lines, depth ${metric.nesting} (lines ${metric.startLine}-${metric.endLine})`)
    );
  const sections: AnalysisSection[] = [
    { id: 'code-facts', title: 'Facts', items: evidenceList.slice(0, 10) },
    ...(complexityEvidence.length ? [{ id: 'code-complexity', title: 'Function complexity', items: complexityEvidence }] : []),
    {
      id: 'code-structure',
      title: 'Structure',
      items: [
        evidence('code-summary', 'Summary', textSummary(text)),
        evidence('code-density', 'Comment ratio', percent(totalLines ? commentLines / totalLines : 0)),
        evidence('code-max-run', 'Longest uninterrupted block', formatNumber(maxRun))
      ]
    }
  ];
  const unusual: Finding[] = [];
  if (mostComplex && mostComplex.cyclomatic >= 10) {
    unusual.push({
      id: 'code-complex-function',
      title: 'High-complexity function',
      summary: `Function ${mostComplex.name} has cyclomatic complexity ${mostComplex.cyclomatic} (file average ${avgCyclomatic.toFixed(1)}, max lines ${mostComplex.lines}).`,
      severity: 'medium',
      evidence: ['code-max-cyclomatic', 'code-fn-0'],
      methodology: 'anomaly',
      confidence: 'high',
      category: 'quality',
      metrics: { cyclomatic: mostComplex.cyclomatic, lines: mostComplex.lines }
    });
  }
  if (mostComplex && maxFunctionLines >= 100) {
    unusual.push({
      id: 'code-large-function',
      title: 'Oversized function',
      summary: `Function ${mostComplex.name} spans ${maxFunctionLines} lines.`,
      severity: 'low',
      evidence: ['code-max-function-lines', 'code-fn-0'],
      methodology: 'heuristic',
      confidence: 'medium',
      category: 'quality'
    });
  }
  if (todoCount > 0) {
    unusual.push(finding('code-todo', 'TODO/FIXME markers present', 'The file contains deferred work markers.', 'low', ['code-todos']));
  }
  if (maxRun > 200) {
    unusual.push(finding('code-large-block', 'Large contiguous block', 'The file contains a long uninterrupted block of code or text.', 'low', ['code-max-run']));
  }
  if (duplicateLines > 0) {
    unusual.push(finding('code-repeat', 'Repeated lines', 'Repeated line patterns were detected in the file.', 'low', ['code-lines']));
  }
  const recommendations: Finding[] = [];
  if (functions > 20 && totalLines > 500) {
    recommendations.push(finding('code-review', 'Review large source file', 'Large source files can benefit from smaller units with clearer boundaries.', 'low', ['code-lines']));
  }
  return buildResult(
    file,
    'code',
    'Source code analyzer',
    language,
    fingerprint,
    ['lines', 'comments', 'imports', 'functions', 'classes', 'markers'],
    ['Static inspection only; no code execution'],
    sections,
    evidenceList,
    [],
    unusual,
    recommendations,
    `${formatNumber(totalLines)} lines`
  );
}

function detectManifestOrSource(file: InspectionFile, text: string): 'manifest' | 'log' | 'code' | null {
  if (isManifestName(file.name) || manifestKind(file)) {
    return 'manifest';
  }
  const ext = extension(file.name);
  const logHints = text.split(/\r\n|\n|\r/).slice(0, 200).filter((line) => /^\s*(?:\[[^\]]+\]\s*)?(?:\d{4}[-/]\d{2}[-/]\d{2}|\w{3}\s+\d{1,2}|\d{2}:\d{2}:\d{2}).*(?:error|warn|info|debug|fatal|panic)/i.test(line)).length;
  if (logExtensions.has(ext) || /(?:log|error|trace|debug|access|audit)/i.test(file.name) || logHints >= 2) {
    return 'log';
  }
  const codeHints = /\b(?:function|class|def|fn|import|export|package|namespace|struct|interface|impl|const|let|var|#include)\b/.test(text);
  if (sourceExtensions.has(ext) || codeHints) {
    return 'code';
  }
  return null;
}

function walkFolder(item: InspectionItem, visit: (file: InspectionFile) => void): void {
  if (item.kind === 'file') {
    visit(item);
    return;
  }
  if (item.kind !== 'folder') {
    return;
  }
  for (const child of item.children) {
    walkFolder(child, visit);
  }
}

function findGitFolder(folder: InspectionFolder): InspectionFolder | null {
  const stack: InspectionFolder[] = [folder];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.name === '.git') {
      return current;
    }
    for (const child of current.children) {
      if (child.kind === 'folder') {
        stack.push(child);
      }
    }
  }
  return null;
}

function findFileByPath(folder: InspectionFolder, relativePath: string): InspectionFile | null {
  const target = normalizePath(relativePath).replace(/^\.?\//, '');
  let found: InspectionFile | null = null;
  walkFolder(folder, (file) => {
    const normalized = normalizePath(file.path).replace(/^\.?\//, '');
    if (!found && (normalized === target || normalized.endsWith(`/${target}`))) {
      found = file;
    }
  });
  return found;
}

async function readFolderText(folder: InspectionFolder, relativePath: string): Promise<string> {
  const file = findFileByPath(folder, relativePath);
  if (!file) return '';
  return readText(file, 256 * 1024);
}

function collectGitRefNames(folder: InspectionFolder): string[] {
  const names = new Set<string>();
  walkFolder(folder, (file) => {
    const normalized = normalizePath(file.path);
    const match = normalized.match(/\.git\/refs\/heads\/(.+)$/i);
    if (match) {
      names.add(match[1]);
    }
  });
  return [...names];
}

async function analyzeGitSignals(folder: InspectionFolder): Promise<GitSignals | null> {
  const gitFolder = findGitFolder(folder);
  if (!gitFolder) {
    return null;
  }
  const head = await readFolderText(gitFolder, 'HEAD');
  const branchHead = head.match(/ref:\s*refs\/heads\/(.+)/)?.[1]?.trim();
  const branches = new Set<string>(collectGitRefNames(gitFolder));
  if (branchHead) {
    branches.add(branchHead);
  }
  let logText = await readFolderText(gitFolder, 'logs/HEAD');
  for (const branch of branches) {
    logText += `\n${await readFolderText(gitFolder, `logs/refs/heads/${branch}`)}`;
  }
  const logLines = logText.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0);
  const contributors = new Map<string, number>();
  let lastCommit: string | undefined;
  for (const line of logLines) {
    // Reflog format: "<old> <new> Name <email> <unix-ts> <tz>\t<message>"
    const tabIndex = line.indexOf('\t');
    const meta = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
    const authorMatch = meta.match(/\s([^<\s]+)\s+<[^>]+>\s+\d+\s+[+-]\d+/);
    if (authorMatch) {
      contributors.set(authorMatch[1], (contributors.get(authorMatch[1]) ?? 0) + 1);
    }
    const timestampMatch = meta.match(/\s(\d+)\s+[+-]\d+$/);
    if (timestampMatch) {
      lastCommit = new Date(Number(timestampMatch[1]) * 1000).toISOString();
    }
  }
  return {
    branches: [...branches].sort(),
    commitCount: logLines.length,
    contributors: [...contributors.entries()].sort((left, right) => right[1] - left[1]).slice(0, 10),
    lastCommit,
    branchHead
  };
}

export async function collectProjectSignals(folder: InspectionFolder): Promise<ProjectSignals> {
  const signals: ProjectSignals = {
    sourceFiles: 0,
    logFiles: 0,
    manifestFiles: [],
    languageCounts: new Map(),
    todoCount: 0,
    fixmeCount: 0,
    largestFiles: []
  };
  const largest: Array<{ name: string; size: number; path: string }> = [];
  const visit = async (file: InspectionFile): Promise<void> => {
    const ext = extension(file.name);
    if (sourceExtensions.has(ext)) {
      signals.sourceFiles += 1;
      signals.languageCounts.set(detectLanguage(file), (signals.languageCounts.get(detectLanguage(file)) ?? 0) + 1);
    }
    if (logExtensions.has(ext) || /(?:log|trace|error|debug|access|audit)/i.test(file.name)) {
      signals.logFiles += 1;
    }
    if (isManifestName(file.name)) {
      signals.manifestFiles.push(file.path);
    }
    largest.push({ name: file.name, size: file.size, path: file.path });
    if (sourceExtensions.has(ext) || logExtensions.has(ext) || isManifestName(file.name)) {
      const text = await readText(file, 256 * 1024);
      signals.todoCount += searchAll(text, /\bTODO\b/gi).length;
      signals.fixmeCount += searchAll(text, /\bFIXME\b/gi).length;
    }
  };
  const stack: InspectionItem[] = [folder];
  const work: Array<Promise<void>> = [];
  while (stack.length) {
    const item = stack.pop()!;
    if (item.kind === 'file') {
      work.push(visit(item));
      continue;
    }
    if (item.kind !== 'folder') {
      continue;
    }
    for (const child of item.children) {
      stack.push(child);
    }
  }
  await Promise.all(work);
  largest.sort((left, right) => right.size - left.size);
  signals.largestFiles = largest.slice(0, 10);
  signals.git = await analyzeGitSignals(folder) ?? undefined;
  return signals;
}

export async function analyzeCodeFile(file: InspectionFile, options: { signal: AbortSignal }): Promise<AnalysisResult | null> {
  ensureNotAborted(options.signal);
  const text = await readText(file, 512 * 1024);
  const kind = detectManifestOrSource(file, text);
  if (!kind) {
    return null;
  }
  const fingerprint = await digestHex(new TextEncoder().encode(`${file.name}|${file.size}|${text.slice(0, 1024)}`));
  if (kind === 'manifest') {
    return analyzeManifest(file, text, fingerprint);
  }
  if (kind === 'log') {
    return analyzeLogLines(file, text, fingerprint);
  }
  return analyzeSourceCode(file, text, fingerprint);
}
