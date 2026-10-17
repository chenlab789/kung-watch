const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kw', {
  onState: (fn) => ipcRenderer.on('state', (_, s) => fn(s)),
  onStats: (fn) => ipcRenderer.on('stats', (_, s) => fn(s)),
  onSound: (fn) => ipcRenderer.on('sound', (_, k) => fn(k)),
  send: (channel, data) => ipcRenderer.send(channel, data),
});
