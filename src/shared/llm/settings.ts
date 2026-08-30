// LLM settings storage (non-secret) and API-key credential handling.
//
// Secret handling:
//  - Desktop (Electron): the API key is stored by the main process using
//    Electron safeStorage (OS-keychain-backed encryption) and is never sent to
//    the renderer except on explicit request. Requests are made by the main
//    process, so the key never appears in renderer memory.
//  - Browser: there is no OS keychain. The key is kept in the browser's local
//    storage (same mechanism most web apps use) and is only ever sent to the
//    configured provider endpoint. This is a documented limitation: browser
//    local storage is not encrypted; use the desktop app for sensitive keys.
import { storageGet, storageRemove, storageSet } from '../storage.ts';
import type { DesktopAiBridge, LlmSettings } from './types.ts';

export const AI_SETTINGS_STORAGE_KEY = 'inspect-this.ai-settings';
export const AI_KEY_STORAGE_KEY = 'inspect-this.ai-key';

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  enabled: false,
  autoRun: false,
  provider: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  organization: '',
  project: '',
  timeoutMs: 60000,
  stream: true,
  maxContextChars: 24000,
  allowRawContent: false,
  rawContentMaxChars: 20000
};

/** Convenience presets. Model names vary by provider; users edit them freely. */
export const PROVIDER_PRESETS: Record<string, { baseUrl: string; model: string }> = {
  OpenAI: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  Ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' },
  'LM Studio': { baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
  Custom: { baseUrl: '', model: '' }
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function normalizeLlmSettings(raw: unknown): LlmSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    enabled: Boolean(value.enabled),
    autoRun: Boolean(value.autoRun),
    provider: typeof value.provider === 'string' && value.provider ? value.provider : DEFAULT_LLM_SETTINGS.provider,
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : DEFAULT_LLM_SETTINGS.baseUrl,
    model: typeof value.model === 'string' ? value.model : '',
    organization: typeof value.organization === 'string' ? value.organization : '',
    project: typeof value.project === 'string' ? value.project : '',
    timeoutMs: clampInt(value.timeoutMs, DEFAULT_LLM_SETTINGS.timeoutMs, 3000, 300000),
    stream: value.stream !== false,
    maxContextChars: clampInt(value.maxContextChars, DEFAULT_LLM_SETTINGS.maxContextChars, 4000, 120000),
    allowRawContent: Boolean(value.allowRawContent),
    rawContentMaxChars: clampInt(value.rawContentMaxChars, DEFAULT_LLM_SETTINGS.rawContentMaxChars, 2000, 120000)
  };
}

export function loadLlmSettings(): LlmSettings {
  const raw = storageGet(AI_SETTINGS_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_LLM_SETTINGS };
  try {
    return normalizeLlmSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_LLM_SETTINGS };
  }
}

export function saveLlmSettings(settings: LlmSettings): void {
  storageSet(AI_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function desktopBridge(): DesktopAiBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { inspectThisDesktop?: { ai?: DesktopAiBridge } }).inspectThisDesktop?.ai;
  return bridge ?? null;
}

/** Retrieve the API key. Desktop: decrypted by the main process. Browser: local storage. */
export async function getApiKey(): Promise<string | null> {
  const bridge = desktopBridge();
  if (bridge) {
    try {
      return await bridge.getKey();
    } catch {
      return null;
    }
  }
  const stored = storageGet(AI_KEY_STORAGE_KEY);
  return stored && stored.trim() ? stored : null;
}

export async function setApiKey(key: string): Promise<void> {
  const bridge = desktopBridge();
  if (bridge) {
    await bridge.setKey(String(key ?? ''));
    return;
  }
  if (key) {
    storageSet(AI_KEY_STORAGE_KEY, key);
  } else {
    storageRemove(AI_KEY_STORAGE_KEY);
  }
}

export async function clearApiKey(): Promise<void> {
  const bridge = desktopBridge();
  if (bridge) {
    await bridge.clearKey();
    return;
  }
  storageRemove(AI_KEY_STORAGE_KEY);
}

export async function hasApiKey(): Promise<boolean> {
  const bridge = desktopBridge();
  if (bridge) {
    // Ask the main process without ever pulling the key into the renderer.
    try {
      return await bridge.hasKey();
    } catch {
      return false;
    }
  }
  const key = storageGet(AI_KEY_STORAGE_KEY);
  return Boolean(key && key.trim().length > 0);
}

/** True when AI is both enabled and configured with a key. */
export async function hasUsableAi(settings: LlmSettings): Promise<boolean> {
  return settings.enabled && Boolean(settings.baseUrl.trim()) && Boolean(settings.model.trim()) && (await hasApiKey());
}
