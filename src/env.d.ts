/// <reference types="vite/client" />

declare global {
  var __APP_VERSION__: string;
  var __APP_NAME__: string;
  var __APP_REPOSITORY_URL__: string;

  interface Window {
    inspectThisDesktop?: {
      getWindowState: () => Promise<{
        expanded: boolean;
        bubbleState: { x?: number; y?: number; width: number; height: number };
        panelSize?: { width: number; height: number };
        panelPosition?: { x?: number; y?: number };
      }>;
      setExpanded: (value: boolean) => Promise<{ expanded: boolean }>;
      setBounds: (bounds: { x?: number; y?: number; width?: number; height?: number }) => Promise<void>;
      focus: () => Promise<void>;
      beginDrag: () => Promise<{ x?: number; y?: number }>;
      dragBy: (dx: number, dy: number) => Promise<void>;
      endDrag: () => Promise<void>;
      panelResizeBy: (dx: number, dy: number) => Promise<void>;
      getAutoLaunch: () => Promise<boolean>;
      setAutoLaunch: (enabled: boolean) => Promise<boolean>;
      onModeChange: (handler: (mode: 'bubble' | 'panel') => void) => () => void;
      ai?: {
        chat: (payload: {
          requestId: string;
          baseUrl: string;
          model: string;
          messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
          timeoutMs: number;
          stream: boolean;
          organization?: string;
          project?: string;
          maxTokens?: number;
        }) => Promise<{ requestId: string }>;
        abort: (requestId: string) => Promise<boolean>;
        onEvent: (handler: (event: {
          requestId: string;
          type: 'delta' | 'done' | 'error';
          text?: string;
          content?: string;
          error?: { kind: string; message: string };
        }) => void) => () => void;
        getKey: () => Promise<string | null>;
        setKey: (key: string) => Promise<boolean>;
        clearKey: () => Promise<boolean>;
        hasKey: () => Promise<boolean>;
      };
    };
  }
}

export {};
