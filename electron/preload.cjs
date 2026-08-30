const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inspectThisDesktop', {
  getWindowState: () => ipcRenderer.invoke('inspect-this:get-window-state'),
  setExpanded: (value) => ipcRenderer.invoke('inspect-this:set-expanded', value),
  setBounds: (bounds) => ipcRenderer.invoke('inspect-this:set-bounds', bounds),
  focus: () => ipcRenderer.invoke('inspect-this:focus'),
  beginDrag: () => ipcRenderer.invoke('inspect-this:begin-drag'),
  dragBy: (dx, dy) => ipcRenderer.invoke('inspect-this:drag-by', dx, dy),
  endDrag: () => ipcRenderer.invoke('inspect-this:end-drag'),
  panelResizeBy: (dx, dy) => ipcRenderer.invoke('inspect-this:panel-resize-by', dx, dy),
  getAutoLaunch: () => ipcRenderer.invoke('inspect-this:get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('inspect-this:set-auto-launch', enabled),
  onModeChange: (handler) => {
    const listener = (_event, value) => handler(value);
    ipcRenderer.on('inspect-this-mode', listener);
    return () => ipcRenderer.removeListener('inspect-this-mode', listener);
  },
  ai: {
    chat: (payload) => ipcRenderer.invoke('inspect-this:ai-chat', payload),
    abort: (requestId) => ipcRenderer.invoke('inspect-this:ai-abort', requestId),
    onEvent: (handler) => {
      const listener = (_event, event) => handler(event);
      ipcRenderer.on('inspect-this:ai-event', listener);
      return () => ipcRenderer.removeListener('inspect-this:ai-event', listener);
    },
    getKey: () => ipcRenderer.invoke('inspect-this:ai-get-key'),
    setKey: (key) => ipcRenderer.invoke('inspect-this:ai-set-key', key),
    clearKey: () => ipcRenderer.invoke('inspect-this:ai-clear-key'),
    hasKey: () => ipcRenderer.invoke('inspect-this:ai-has-key')
  }
});
