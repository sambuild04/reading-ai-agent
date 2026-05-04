import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__electronInvoke", (command: string, args: unknown) =>
  ipcRenderer.invoke("invoke", command, args),
);

contextBridge.exposeInMainWorld("__electronWindow", {
  setSize: (width: number, height: number) =>
    ipcRenderer.invoke("window:setSize", width, height),
  hide: () => ipcRenderer.invoke("window:hide"),
  show: () => ipcRenderer.invoke("window:show"),
});
