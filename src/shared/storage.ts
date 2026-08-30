const memory = new Map<string, string>();

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

export function storageGet(key: string): string | null {
  if (hasLocalStorage()) {
    return localStorage.getItem(key);
  }
  return memory.get(key) ?? null;
}

export function storageSet(key: string, value: string): void {
  if (hasLocalStorage()) {
    localStorage.setItem(key, value);
    return;
  }
  memory.set(key, value);
}

export function storageRemove(key: string): void {
  if (hasLocalStorage()) {
    localStorage.removeItem(key);
    return;
  }
  memory.delete(key);
}
