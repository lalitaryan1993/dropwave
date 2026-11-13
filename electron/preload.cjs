const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.off(channel, fn);
};

contextBridge.exposeInMainWorld('dropwave', {
  getState: () => ipcRenderer.invoke('state'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  chooseSaveDir: () => ipcRenderer.invoke('settings:chooseSaveDir'),

  // Dropped File objects -> real paths on disk (works for folders too).
  // Callers must pass an array of Files: a FileList does not survive contextBridge (it arrives empty).
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
  play: (opts) => ipcRenderer.invoke('player:open', opts),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  sendText: (peerId, text) => ipcRenderer.invoke('text:send', peerId, text),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  onText: on('text'),
  chatList: () => ipcRenderer.invoke('chat:list'),
  chatGet: (peerId) => ipcRenderer.invoke('chat:get', peerId),
  chatOpen: (peerId) => ipcRenderer.invoke('chat:open', peerId),
  chatSend: (peerId, text) => ipcRenderer.invoke('chat:send', peerId, text),
  chatClear: (peerId) => ipcRenderer.invoke('chat:clear', peerId),
  onChat: on('chat'),
  onChatRead: on('chat-read'),
  onOpenChat: on('open-chat'),
  pendingSend: () => ipcRenderer.invoke('send:pending'),
  pendingSendDone: () => ipcRenderer.invoke('send:pendingDone'),
  onSendRequest: on('send-request'),
  forgetKeys: () => ipcRenderer.invoke('security:forgetKeys'),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: on('update'),
  runChecks: () => ipcRenderer.invoke('diag:run'),
  fixCheck: (id) => ipcRenderer.invoke('diag:fix', id),

  onPeers: on('peers'),
  onTransfer: on('transfer'),
  onIncoming: on('incoming'),
  onRequestClosed: on('request-closed'),
  onState: on('state'),
});
