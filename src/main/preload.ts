import { contextBridge, ipcRenderer } from 'electron';
import type { OverlayApi } from '../shared/api';

const api: OverlayApi = {
  onUpdate: (cb) => {
    ipcRenderer.on('overlay:update', (_e, payload) => cb(payload));
  },
  onOpenAdvice: (cb) => {
    ipcRenderer.on('overlay:open-advice', () => cb());
  },
  ready: () => ipcRenderer.send('overlay:ready'),
  resize: (height) => ipcRenderer.send('overlay:resize', height),
  copy: (text) => ipcRenderer.send('overlay:copy', text),
  setExpanded: (expanded) => ipcRenderer.send('overlay:set-expanded', expanded),
  dismiss: (a) => ipcRenderer.send('overlay:dismiss', a),
  hide: () => ipcRenderer.send('overlay:hide'),
  menu: () => ipcRenderer.send('overlay:menu'),
};

contextBridge.exposeInMainWorld('tokenslayer', api);
