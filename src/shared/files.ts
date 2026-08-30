import type { InspectionFile, InspectionFolder, InspectionItem } from './types.ts';
import { formatBytes } from './utils.ts';

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function isFolderItem(item: DataTransferItem): boolean {
  const asAny = item as DataTransferItem & {
    webkitGetAsEntry?: () => FileSystemEntry | null;
  };
  const entry = asAny.webkitGetAsEntry?.();
  return Boolean(entry && entry.isDirectory);
}

async function readDirectoryEntry(entry: FileSystemDirectoryEntry, parentPath: string): Promise<InspectionItem[]> {
  const reader = entry.createReader();
  const children: InspectionItem[] = [];
  const entries: FileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch.length) {
      break;
    }
    entries.push(...batch);
  }
  for (const child of entries) {
    if (child.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (child as FileSystemFileEntry).file(resolve, reject);
      });
      const path = `${parentPath}/${file.name}`.replace(/\/+/g, '/');
      children.push({
        kind: 'file',
        name: file.name,
        path,
        size: file.size,
        lastModified: file.lastModified,
        mimeType: file.type || 'application/octet-stream',
        file
      });
    } else if (child.isDirectory) {
      const nested = await readDirectoryEntry(child as FileSystemDirectoryEntry, `${parentPath}/${child.name}`.replace(/\/+/g, '/'));
      children.push({
        kind: 'folder',
        name: child.name,
        path: `${parentPath}/${child.name}`.replace(/\/+/g, '/'),
        children: nested
      });
    }
  }
  return children;
}

export async function itemsFromFileList(fileList: FileList): Promise<InspectionItem[]> {
  const files = Array.from(fileList);
  if (!files.length) {
    return [];
  }
  const relativeMode = files.some((file) => file.webkitRelativePath);
  if (!relativeMode) {
    return files.map((file) => ({
      kind: 'file',
      name: file.name,
      path: file.name,
      size: file.size,
      lastModified: file.lastModified,
      mimeType: file.type || 'application/octet-stream',
      file
    }));
  }
  const folders = new Map<string, InspectionFolder>();
  const ensureFolder = (path: string): InspectionFolder => {
    if (!folders.has(path)) {
      folders.set(path, {
        kind: 'folder',
        name: fileNameFromPath(path),
        path,
        children: []
      });
    }
    return folders.get(path)!;
  };
  const topLevel = new Set<string>();
  for (const file of files) {
    const segments = file.webkitRelativePath.split('/').filter(Boolean);
    if (!segments.length) {
      continue;
    }
    const relativePath = segments.join('/');
    topLevel.add(segments[0]);
    let parent: InspectionFolder | null = null;
    let currentPath = '';
    for (let index = 0; index < segments.length - 1; index += 1) {
      currentPath = currentPath ? `${currentPath}/${segments[index]}` : segments[index];
      const folder = ensureFolder(currentPath);
      if (parent && !parent.children.includes(folder)) {
        parent.children.push(folder);
      }
      parent = folder;
    }
    const item: InspectionFile = {
      kind: 'file',
      name: file.name,
      path: relativePath,
      size: file.size,
      lastModified: file.lastModified,
      mimeType: file.type || 'application/octet-stream',
      file
    };
    if (parent) {
      parent.children.push(item);
    } else {
      const rootFolder = ensureFolder(segments[0]);
      rootFolder.children.push(item);
    }
  }
  for (const folder of folders.values()) {
    const parentPath = folder.path.split('/').slice(0, -1).join('/');
    if (parentPath) {
      const parent = folders.get(parentPath);
      if (parent && !parent.children.includes(folder)) {
        parent.children.push(folder);
      }
    }
  }
  return [...topLevel].map((path) => folders.get(path)).filter((item): item is InspectionFolder => Boolean(item));
}

export async function itemsFromDropEvent(event: DragEvent): Promise<InspectionItem[]> {
  const dt = event.dataTransfer;
  if (!dt) {
    return [];
  }
  const items = Array.from(dt.items ?? []);
  const folders: InspectionItem[] = [];
  const files: File[] = [];
  for (const item of items) {
    const asAny = item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null };
    const entry = asAny.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      folders.push({
        kind: 'folder',
        name: entry.name,
        path: entry.name,
        children: await readDirectoryEntry(entry as FileSystemDirectoryEntry, entry.name)
      });
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }
  if (folders.length) {
    return folders;
  }
  return files.map((file) => ({
    kind: 'file',
    name: file.name,
    path: file.name,
    size: file.size,
    lastModified: file.lastModified,
    mimeType: file.type || 'application/octet-stream',
    file
  }));
}

export function describeItems(items: InspectionItem[]): string {
  const files = items.filter((item) => item.kind === 'file') as InspectionFile[];
  const folders = items.filter((item) => item.kind === 'folder') as InspectionFolder[];
  const urls = items.filter((item) => item.kind === 'url');
  const fileSize = files.reduce((acc, file) => acc + file.size, 0);
  return `${files.length} files, ${folders.length} folders, ${urls.length} urls, ${formatBytes(fileSize)}`;
}
