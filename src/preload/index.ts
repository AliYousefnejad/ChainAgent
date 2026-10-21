import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('api', {
  login: (email: string, password: string) => ipcRenderer.invoke('auth:login', email, password),
  logout: () => ipcRenderer.invoke('auth:logout'),
  request: (method: string, path: string, body?: unknown) => ipcRenderer.invoke('api:request', method, path, body),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openExternal: (url: string) => ipcRenderer.send('shell:openExternal', url),
  createPlan: (task: string, windows: unknown[], wires: unknown[], cwd: string) =>
    ipcRenderer.invoke('plan:create', task, windows, wires, cwd),
  transcribe: (samples: Float32Array, language: string) => ipcRenderer.invoke('stt:transcribe', samples, language),
  onSttProgress: (cb: (percent: number) => void) => listen('stt:progress', cb)
})

function listen<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('pty', {
  spawn: (id: string, agentId: string, cwd: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty:spawn', id, agentId, cwd, cols, rows),
  write: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
  resize: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id: string) => ipcRenderer.send('pty:kill', id),
  onData: (cb: (id: string, data: string) => void) => listen('pty:data', cb),
  onExit: (cb: (id: string, code: number) => void) => listen('pty:exit', cb),
  deliver: (id: string, text: string, submit: boolean) => ipcRenderer.invoke('pty:deliver', id, text, submit),
  onFinished: (cb: (id: string, text: string) => void) => listen('agent:finished', cb)
})
