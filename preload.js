const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  create: (data) => ipcRenderer.invoke('create', data),
  select: (id) => ipcRenderer.send('select', id),
  rename: (id, name) => ipcRenderer.send('rename', { id, name }),
  toggle: (id) => ipcRenderer.send('toggle', id),
  tabMenu: (id) => ipcRenderer.send('tab-menu', id),
  navigate: (text) => ipcRenderer.send('navigate', text),
  nav: (action) => ipcRenderer.send('nav', action),
  overlay: (open) => ipcRenderer.send('overlay', open),
  setSettings: (s) => ipcRenderer.send('set-settings', s),
  hibernateOthers: () => ipcRenderer.send('hibernate-others'),
  onState: on('state'),
  onRenameRequest: on('rename-request'),
  onFocusUrl: on('focus-url'),
  onNewRequest: on('new-request'),
});
