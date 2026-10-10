'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  defaultGames: () => ipcRenderer.invoke('games:defaults'),
  getState: () => ipcRenderer.invoke('state:get'),
  toggleRecording: () => ipcRenderer.invoke('recording:toggle'),
  createClip: (seconds) => ipcRenderer.invoke('clip:create', seconds),
  listClips: () => ipcRenderer.invoke('clips:list'),
  deleteClip: (file) => ipcRenderer.invoke('clips:delete', file),
  renameClip: (file, name) => ipcRenderer.invoke('clips:rename', file, name),
  trimClip: (opts) => ipcRenderer.invoke('clips:trim', opts),
  showInFolder: (file) => ipcRenderer.invoke('clips:show', file),
  openClipsFolder: () => ipcRenderer.invoke('clips:open-folder'),
  listScreens: () => ipcRenderer.invoke('screens:list'),
  listProcesses: () => ipcRenderer.invoke('processes:list'),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),

  rendererReady: () => ipcRenderer.send('renderer:ready'),

  onState: on('state'),
  onClipSaved: on('clip:saved'),
  onClipsChanged: on('clips:changed'),
  onExportProgress: on('export:progress'),
  onToast: on('toast'),
  onNavigate: on('navigate'),
  pathToUrl: (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:'),
});
