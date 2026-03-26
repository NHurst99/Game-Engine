const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('platform', {
  // Two-way: send and wait for reply
  invoke(channel, data) {
    return ipcRenderer.invoke(channel, data);
  },

  // One-way: fire and forget
  send(channel, data) {
    ipcRenderer.send(channel, data);
  },

  // Subscribe to push events from main process
  on(channel, handler) {
    const wrapped = (_event, ...args) => handler(...args);
    ipcRenderer.on(channel, wrapped);
    // Return unsubscribe function
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
