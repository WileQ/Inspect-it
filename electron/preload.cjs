const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inspectItDesktop', {
  getWindowState: () => ipcRenderer.invoke('inspect-it:get-window-state'),
  setExpanded: (value) => ipcRenderer.invoke('inspect-it:set-expanded', value),
  setBounds: (bounds) => ipcRenderer.invoke('inspect-it:set-bounds', bounds),
  focus: () => ipcRenderer.invoke('inspect-it:focus'),
  beginDrag: () => ipcRenderer.invoke('inspect-it:begin-drag'),
  dragBy: (dx, dy) => ipcRenderer.invoke('inspect-it:drag-by', dx, dy),
  endDrag: () => ipcRenderer.invoke('inspect-it:end-drag'),
  panelResizeBy: (dx, dy) => ipcRenderer.invoke('inspect-it:panel-resize-by', dx, dy),
  getAutoLaunch: () => ipcRenderer.invoke('inspect-it:get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('inspect-it:set-auto-launch', enabled),
  onModeChange: (handler) => {
    const listener = (_event, value) => handler(value);
    ipcRenderer.on('inspect-it-mode', listener);
    return () => ipcRenderer.removeListener('inspect-it-mode', listener);
  },
  ocr: {
    run: (bytes) => ipcRenderer.invoke('inspect-it:ocr', bytes)
  },
  ai: {
    chat: (payload) => ipcRenderer.invoke('inspect-it:ai-chat', payload),
    abort: (requestId) => ipcRenderer.invoke('inspect-it:ai-abort', requestId),
    onEvent: (handler) => {
      const listener = (_event, event) => handler(event);
      ipcRenderer.on('inspect-it:ai-event', listener);
      return () => ipcRenderer.removeListener('inspect-it:ai-event', listener);
    },
    getKey: () => ipcRenderer.invoke('inspect-it:ai-get-key'),
    setKey: (key) => ipcRenderer.invoke('inspect-it:ai-set-key', key),
    clearKey: () => ipcRenderer.invoke('inspect-it:ai-clear-key'),
    hasKey: () => ipcRenderer.invoke('inspect-it:ai-has-key')
  }
});
