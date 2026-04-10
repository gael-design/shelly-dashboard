'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize:     () => ipcRenderer.invoke('win:minimize'),
  hide:         () => ipcRenderer.invoke('win:hide'),
  close:        () => ipcRenderer.invoke('win:close'),
  toggleWidget: () => ipcRenderer.invoke('win:toggle-widget'),
  getMode:      () => ipcRenderer.invoke('win:get-mode'),
  onModeChange: (cb) => {
    const handler = (_e, mode) => cb(mode);
    ipcRenderer.on('mode-changed', handler);
    return () => ipcRenderer.removeListener('mode-changed', handler);
  },
});
