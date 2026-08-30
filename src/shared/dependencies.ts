// Dependency relationship analysis across manifests and source imports.
// Static and read-only. No vulnerability claims are made (no vulnerability DB).
import type { InspectionFolder, InspectionItem, ObjectRelationship } from './types.ts';
import { parseXml, readText, extension, searchAll, normalizePath } from './analysis-utils.ts';

export interface ManifestDependencySet {
  path: string;
  manifestName: string;
  dependencies: Array<{ name: string; version?: string }>;
}

export interface InternalImport {
  from: string; // importing file path
  to: string;   // imported local file path (resolved within the tree)
  specifier: string;
}

export interface DependencyGraph {
  manifests: ManifestDependencySet[];
  duplicatedDependencies: Array<{ name: string; manifests: string[] }>;
  versionInconsistencies: Array<{ name: string; versions: Array<{ version: string; manifest: string }> }>;
  internalImports: InternalImport[];
  fanOut: Map<string, number>;
  fanIn: Map<string, number>;
}

function extractDependencies(fileName: string, text: string): Array<{ name: string; version?: string }> {
  const lower = fileName.toLowerCase();
  if (lower === 'package.json' || lower === 'composer.json') {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const entries: Array<[string, unknown]> = [];
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'require', 'require-dev']) {
        const value = parsed[section];
        if (value && typeof value === 'object') {
          for (const [name, version] of Object.entries(value as Record<string, unknown>)) {
            entries.push([name, version]);
          }
        }
      }
      return entries.map(([name, version]) => ({ name, version: typeof version === 'string' ? version : undefined }));
    } catch {
      return [];
    }
  }
  if (lower === 'requirements.txt') {
    return text
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, '').trim())
      .filter((line) => line && !line.startsWith('-'))
      .map((line) => {
        const match = line.match(/^([A-Za-z0-9_.-]+)\s*(==|>=|<=|~=|!=)\s*([^;\s]+)/);
        return match ? { name: match[1], version: match[3] } : { name: line.split(/[<>=!~;\s]/)[0] };
      });
  }
  if (lower === 'cargo.toml') {
    return searchAll(text, /^\s*([A-Za-z0-9_.-]+)\s*=\s*["'{]/gm).map((name) => ({ name }));
  }
  if (lower === 'go.mod') {
    return searchAll(text, /^\s*require\s+([^\s]+)/gm).map((name) => ({ name }));
  }
  if (lower === 'pom.xml') {
    try {
      const xml = parseXml(text) as Record<string, unknown>;
      const project = (xml.project ?? xml) as Record<string, unknown>;
      const deps = project.dependencies as Record<string, unknown> | undefined;
      const items = deps?.dependency;
      const array = Array.isArray(items) ? items : items ? [items] : [];
      return array.map((entry) => {
        const dep = entry as Record<string, unknown>;
        return { name: String(dep.artifactId ?? 'unknown'), version: dep.version ? String(dep.version) : undefined };
      });
    } catch {
      return [];
    }
  }
  if (lower === 'gemfile') {
    return searchAll(text, /^\s*gem\s+['"]([^'"]+)['"]/gm).map((name) => ({ name }));
  }
  return [];
}

function importSpecifiers(text: string): string[] {
  const specifiers = new Set<string>();
  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) specifiers.add(match[1]);
  for (const match of text.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.add(match[1]);
  for (const match of text.matchAll(/import\s+['"]([^'"]+)['"]/g)) specifiers.add(match[1]);
  return [...specifiers];
}

const sourceExtensions = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php', 'rb', 'swift', 'kt', 'kts', 'sh', 'sql', 'html', 'css']);
const manifestNames = new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'gemfile']);

function resolveLocalTarget(specifier: string, importerPath: string, allFiles: Map<string, string>): string | null {
  const normalized = normalizePath(specifier);
  if (normalized.startsWith('.') && !normalized.startsWith('../') && normalized !== '.' && normalized !== '..') {
    // Relative import: resolve against the importer's directory.
    const relative = normalized.replace(/^\.\//, '');
    const dir = normalizePath(importerPath).split('/').slice(0, -1).join('/');
    const base = normalizePath(`${dir}/${relative}`);
    const candidates = [
      base,
      base.replace(/\.(ts|js|tsx|jsx|py|rs|go)$/i, ''),
      `${base}/index`
    ];
    for (const candidate of candidates) {
      if (allFiles.has(candidate)) return candidate;
      if (allFiles.has(`${candidate}.ts`)) return `${candidate}.ts`;
      if (allFiles.has(`${candidate}.tsx`)) return `${candidate}.tsx`;
      if (allFiles.has(`${candidate}.js`)) return `${candidate}.js`;
      if (allFiles.has(`${candidate}.jsx`)) return `${candidate}.jsx`;
      if (allFiles.has(`${candidate}.py`)) return `${candidate}.py`;
      if (allFiles.has(`${candidate}.rs`)) return `${candidate}.rs`;
      if (allFiles.has(`${candidate}.go`)) return `${candidate}.go`;
      if (allFiles.has(`${candidate}.java`)) return `${candidate}.java`;
    }
  }
  return null;
}

/** Collect dependency + internal import relationships across a folder tree. */
export async function collectDependencyGraph(folder: InspectionFolder, options?: { signal?: AbortSignal; maxFiles?: number }): Promise<DependencyGraph> {
  const maxFiles = options?.maxFiles ?? 400;
  const files: Array<{ path: string; name: string; ext: string; text: string; size: number }> = [];
  const allFiles = new Map<string, string>();
  const stack: InspectionItem[] = [folder];
  let count = 0;
  while (stack.length && count < maxFiles) {
    const item = stack.pop()!;
    if (item.kind === 'file') {
      count += 1;
      const ext = extension(item.name);
      if (sourceExtensions.has(ext) || manifestNames.has(item.name.toLowerCase())) {
        const text = await readText(item, 512 * 1024);
        files.push({ path: normalizePath(item.path), name: item.name, ext, text, size: item.size });
        allFiles.set(normalizePath(item.path), item.name);
      }
      continue;
    }
    if (item.kind === 'folder') {
      for (const child of item.children) stack.push(child);
    }
  }
  const manifests: ManifestDependencySet[] = [];
  const packageVersions = new Map<string, Array<{ version: string; manifest: string }>>();
  for (const file of files) {
    if (!manifestNames.has(file.name.toLowerCase())) continue;
    const deps = extractDependencies(file.name, file.text);
    manifests.push({ path: file.path, manifestName: file.name, dependencies: deps });
    for (const dep of deps) {
      const entry = packageVersions.get(dep.name) ?? [];
      if (dep.version) entry.push({ version: dep.version, manifest: file.path });
      packageVersions.set(dep.name, entry);
    }
  }
  const duplicatedDependencies: Array<{ name: string; manifests: string[] }> = [];
  for (const [name, entries] of packageVersions) {
    const manifestPaths = [...new Set(entries.map((entry) => entry.manifest))];
    if (manifestPaths.length > 1) {
      duplicatedDependencies.push({ name, manifests: manifestPaths });
    }
  }
  const versionInconsistencies: Array<{ name: string; versions: Array<{ version: string; manifest: string }> }> = [];
  for (const [name, entries] of packageVersions) {
    const versions = entries.filter((entry) => entry.version);
    const uniqueVersions = new Set(versions.map((entry) => entry.version));
    if (uniqueVersions.size > 1) {
      versionInconsistencies.push({ name, versions });
    }
  }
  const internalImports: InternalImport[] = [];
  const fanOut = new Map<string, number>();
  const fanIn = new Map<string, number>();
  for (const file of files) {
    if (!sourceExtensions.has(file.ext)) continue;
    const specifiers = importSpecifiers(file.text);
    for (const specifier of specifiers) {
      if (specifier.startsWith('.') && (specifier.endsWith('/') || specifier.includes('*'))) continue;
      const target = resolveLocalTarget(specifier, file.path, allFiles);
      if (target && target !== file.path) {
        internalImports.push({ from: file.path, to: target, specifier });
        fanOut.set(file.path, (fanOut.get(file.path) ?? 0) + 1);
        fanIn.set(target, (fanIn.get(target) ?? 0) + 1);
      }
    }
  }
  return { manifests, duplicatedDependencies, versionInconsistencies, internalImports, fanOut, fanIn };
}

/** Convert the graph into ObjectRelationship records (for cross-object/multi-file views). */
export function dependencyRelationships(graph: DependencyGraph): ObjectRelationship[] {
  const relationships: ObjectRelationship[] = [];
  let index = 0;
  for (const dup of graph.duplicatedDependencies) {
    relationships.push({
      id: `dep-dup-${index++}`,
      type: 'shared-dependency',
      label: `Shared dependency ${dup.name}`,
      detail: `${dup.name} appears in ${dup.manifests.length} manifests`,
      objects: dup.manifests,
      evidenceIds: []
    });
  }
  for (const inconsistency of graph.versionInconsistencies) {
    relationships.push({
      id: `dep-version-${index++}`,
      type: 'shared-dependency',
      label: `Version conflict for ${inconsistency.name}`,
      detail: inconsistency.versions.map((entry) => `${entry.version} (${entry.manifest})`).join(', '),
      objects: inconsistency.versions.map((entry) => entry.manifest),
      evidenceIds: []
    });
  }
  return relationships;
}
