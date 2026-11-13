const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.off(channel, fn);
};

contextBridge.exposeInMainWorld('landrop', {
  getState: () => ipcRenderer.invoke('state'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  chooseSaveDir: () => ipcRenderer.invoke('settings:chooseSaveDir'),

  // Dropped File objects -> real paths on disk (works for folders too).
  pathsFromFiles: (files) => Array.from(files).map((f) => webUtils.getPathForFile(f)).filter(Boolean),
  sendPaths: (peerId, paths) => ipcRenderer.invoke('send:paths', peerId, paths),
  pickAndSend: (peerId, kind) => ipcRenderer.invoke('send:pick', peerId, kind),
  cancel: (id) => ipcRenderer.invoke('transfer:cancel', id),
  respond: (id, accept, trust) => ipcRenderer.invoke('request:respond', id, accept, trust),
  addPeer: (address) => ipcRenderer.invoke('peer:add', address),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  webQr: () => ipcRenderer.invoke('web:qr'),
  resetPin: () => ipcRenderer.invoke('web:resetPin'),

  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:show', p),
  openSaveDir: () => ipcRenderer.invoke('shell:openSaveDir'),

  onPeers: on('peers'),
  onTransfer: on('transfer'),
  onIncoming: on('incoming'),
  onRequestClosed: on('request-closed'),
  onState: on('state'),
});
