import { join } from 'node:path'
import { app, BrowserWindow, utilityProcess, type UtilityProcess } from 'electron'

type Reply = { text?: string; error?: string }

let worker: UtilityProcess | null = null
let nextId = 1
const pending = new Map<number, (reply: Reply) => void>()

function startWorker(): UtilityProcess {
  const child = utilityProcess.fork(join(__dirname, 'stt-worker.js'), [], { serviceName: 'ChainAgent speech' })
  child.on('message', (m: { type: string; id?: number; text?: string; message?: string; percent?: number }) => {
    if (m.type === 'progress') {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('stt:progress', m.percent)
      return
    }
    pending.get(m.id!)?.(m.type === 'result' ? { text: m.text } : { error: m.message })
    pending.delete(m.id!)
  })
  child.on('exit', () => {
    worker = null
    for (const reply of pending.values()) reply({ error: 'The speech engine stopped. Try again.' })
    pending.clear()
  })
  return child
}

// language: Whisper's language name, e.g. 'english' or 'persian'.
export function transcribe(samples: Float32Array, language: string): Promise<Reply> {
  worker ??= startWorker()
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    worker!.postMessage({ id, samples, language, cacheDir: join(app.getPath('userData'), 'models') })
  })
}

export function stopSpeech(): void {
  worker?.kill()
}
