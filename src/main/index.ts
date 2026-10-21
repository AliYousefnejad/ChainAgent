import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { loadToken, login, logout, request } from './auth'
import * as pty from './pty'
import { startHookServer } from './hooks'
import { createPlan, type PlanWindow } from './planner'
import { stopSpeech, transcribe } from './stt'

// /auth/* returns tokens, so the renderer may only reach it through the auth handlers.
// Normalize first so "/./auth/..." or "/%61uth/..." can't slip past the check.
function isAllowedPath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/')) return false
  try {
    return !decodeURIComponent(new URL(path, 'http://x').pathname).toLowerCase().startsWith('/auth/')
  } catch {
    return false
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0b0d12',
    title: 'ChainAgent',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs')
    }
  })

  // A (re)loaded or crashed page has no windows for the old sessions, so end them.
  // did-navigate fires only when a load commits, not for the blocked navigations below.
  win.webContents.on('did-navigate', pty.killAll)
  win.webContents.on('render-process-gone', pty.killAll)
  // A file or link dropped outside the canvas would navigate away and end every session.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // F11 toggles the full-screen focus view. Caught here, before the page and the menu, so it
  // works while typing in a terminal and the terminal never receives the key.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F11') return
    e.preventDefault()
    win.setFullScreen(!win.isFullScreen())
  })
  // Also covers leaving full screen another way, e.g. from the window manager.
  win.on('enter-full-screen', () => {
    win.setMenuBarVisibility(false)
    win.webContents.send('window:fullscreen', true)
  })
  win.on('leave-full-screen', () => {
    win.setMenuBarVisibility(true)
    win.webContents.send('window:fullscreen', false)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// One instance only: a second one would rewrite the hook settings file and the stored session.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.whenReady().then(async () => {
  loadToken()
  await startHookServer()
  ipcMain.handle('auth:login', (_e, email: string, password: string) => login(email, password))
  ipcMain.handle('auth:logout', () => logout())
  ipcMain.handle('api:request', (_e, method: string, path: string, body?: unknown) =>
    isAllowedPath(path) ? request(method, path, body) : { ok: false, status: 403, data: { message: 'Not allowed' } }
  )
  ipcMain.handle('pty:spawn', (e, id: string, agentId: string, cwd: string, cols: number, rows: number) =>
    pty.spawn(e.sender, id, agentId, cwd, cols, rows)
  )
  ipcMain.on('pty:write', (_e, id: string, data: string) => pty.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => pty.resize(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => pty.kill(id))
  ipcMain.handle('pty:deliver', (_e, id: string, text: string, submit: boolean) => pty.deliver(id, text, submit))
  ipcMain.handle('plan:create', (_e, task: string, windows: PlanWindow[], wires: { source: string; target: string }[], cwd: string) =>
    createPlan(task, windows, wires, cwd)
  )
  ipcMain.handle('stt:transcribe', (_e, samples: Float32Array, language: string) => transcribe(samples, language))
  ipcMain.handle('dialog:pickFolder', async (e) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, {
      title: 'Choose a folder for this session',
      defaultPath: app.getPath('home'),
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.on('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  pty.killAll()
  stopSpeech()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
