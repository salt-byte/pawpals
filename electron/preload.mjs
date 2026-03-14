import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pawpalsDesktop", {
  platform: process.platform,
  isDesktop: true,
  startDeployment: () => ipcRenderer.send("pawpals:start-deployment"),
  getDeploymentStatus: () => ipcRenderer.invoke("pawpals:get-deployment-status"),
});
