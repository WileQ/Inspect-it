// Cross-object relationship detection for multi-object inspections.
// Produces a relationship model (ObjectRelationship[]) that can later power a
// graph UI. Read-only.
import type { InspectionItem, InspectionFile, ObjectRelationship } from './types.ts';
import { findExactDuplicates, imageHashOf, imageSimilarity } from './duplicates.ts';
import { readText } from './analysis-utils.ts';
import { formatBytes } from './utils.ts';

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|bmp|tiff)$/i;

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function stem(name: string): string {
  const base = basename(name);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot).toLowerCase() : base.toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[^\w\s-]/g, '\\$&');
}

export interface RelationshipOptions {
  signal?: AbortSignal;
  maxFiles?: number;
}

export async function findCrossObjectRelationships(items: InspectionItem[], options?: RelationshipOptions): Promise<ObjectRelationship[]> {
  const maxFiles = options?.maxFiles ?? 60;
  const files = items.filter((item): item is InspectionFile => item.kind === 'file').slice(0, maxFiles);
  const relationships: ObjectRelationship[] = [];
  const push = (rel: Omit<ObjectRelationship, 'id'>, index: number) => {
    relationships.push({ id: `rel-${rel.type}-${index}`, ...rel });
  };
  let index = 0;

  // 1) Same filename (different paths).
  const byName = new Map<string, string[]>();
  for (const file of files) {
    const name = basename(file.name);
    const group = byName.get(name) ?? [];
    group.push(file.path);
    byName.set(name, group);
  }
  for (const [name, paths] of byName) {
    if (paths.length > 1) {
      push({
        type: 'same-name',
        label: `Same filename "${name}"`,
        detail: `${paths.length} files share the name "${name}"`,
        objects: paths,
        evidenceIds: []
      }, index++);
    }
  }

  // 2) Same size (potential duplicates).
  const bySize = new Map<number, string[]>();
  for (const file of files) {
    if (file.size === 0) continue;
    const group = bySize.get(file.size) ?? [];
    group.push(file.path);
    bySize.set(file.size, group);
  }
  for (const [size, paths] of bySize) {
    if (paths.length > 1) {
      push({
        type: 'same-size',
        label: `Same size ${formatBytes(size)}`,
        detail: `${paths.length} files are exactly ${formatBytes(size)}`,
        objects: paths,
        evidenceIds: []
      }, index++);
    }
  }

  // 3) Exact duplicates (hash).
  if (files.length >= 2) {
    const groups = await findExactDuplicates(
      files.map((file) => ({ name: file.name, size: file.size, path: file.path, file: file.file })),
      { limit: 40 }
    );
    for (const group of groups.slice(0, 5)) {
      push({
        type: 'duplicate',
        label: `Duplicate files (${group.method})`,
        detail: `${group.copies} copies, ${formatBytes(group.wastedBytes)} wasted; representative: ${group.representative}`,
        objects: group.paths,
        evidenceIds: []
      }, index++);
    }
  }

  // 4) Text references between files (sampled).
  const stems = new Map<string, string[]>();
  for (const file of files) {
    const s = stem(file.name);
    if (s.length >= 3) {
      const group = stems.get(s) ?? [];
      group.push(file.path);
      stems.set(s, group);
    }
  }
  const stemSet = new Set(stems.keys());
  let scanned = 0;
  for (const file of files) {
    if (scanned >= 20) break;
    scanned += 1;
    if (file.size > 512 * 1024) continue;
    let text: string;
    try {
      text = await readText(file, 64 * 1024);
    } catch {
      continue;
    }
    for (const otherStem of stemSet) {
      const regex = new RegExp(`\\b${escapeRegExp(otherStem)}\\b`, 'i');
      if (regex.test(text)) {
        const targets = stems.get(otherStem) ?? [];
        for (const target of targets) {
          if (target === file.path) continue;
          push({
            type: 'reference',
            label: `${basename(file.name)} references ${basename(target)}`,
            detail: `"${otherStem}" appears in ${file.path}`,
            objects: [file.path, target],
            evidenceIds: []
          }, index++);
        }
      }
    }
  }

  // 5) Similar images (perceptual hash).
  const imageFiles = files.filter((file) => IMAGE_EXTENSIONS.test(file.name));
  if (imageFiles.length >= 2) {
    const hashes: Array<{ path: string; hash: bigint | null; name: string }> = [];
    for (const file of imageFiles.slice(0, 20)) {
      try {
        const bytes = new Uint8Array(await file.file.slice(0, 8 * 1024 * 1024).arrayBuffer());
        const hash = await imageHashOf(bytes);
        hashes.push({ path: file.path, hash, name: file.name });
      } catch {
        hashes.push({ path: file.path, hash: null, name: file.name });
      }
    }
    for (let a = 0; a < hashes.length; a += 1) {
      for (let b = a + 1; b < hashes.length; b += 1) {
        if (hashes[a].hash === null || hashes[b].hash === null) continue;
        const similarity = imageSimilarity(hashes[a].hash!, hashes[b].hash!);
        if (similarity >= 0.85) {
          push({
            type: 'similar-image',
            label: `Visually similar images (${Math.round(similarity * 100)}%)`,
            detail: `${basename(hashes[a].path)} and ${basename(hashes[b].path)} have similar perceptual hashes`,
            objects: [hashes[a].path, hashes[b].path],
            evidenceIds: []
          }, index++);
        }
      }
    }
  }

  return relationships.slice(0, 40);
}
