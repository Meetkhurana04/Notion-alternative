const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nova', {
    login: () => ipcRenderer.invoke('login'),
    onCode: cb => ipcRenderer.on('code', (_, c) => cb(c)),
    repos: () => ipcRenderer.invoke('repos'),
    useRepo: (name, create) => ipcRenderer.invoke('useRepo', name, create),
    useFolder: () => ipcRenderer.invoke('useFolder'),
});
