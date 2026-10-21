// Runs in an Electron utility process so speech recognition never blocks the app.
// Whisper (ONNX, 8-bit) is downloaded once into the cache folder the main process sends.
import { env, pipeline } from '@huggingface/transformers'

type Job = { id: number; samples: Float32Array; language: string; cacheDir: string }
type Transcriber = (samples: Float32Array, options: object) => Promise<{ text: string }>

const MODEL = 'onnx-community/whisper-small'
const port = process.parentPort
let model: Promise<Transcriber> | null = null
const progress = new Map<string, { loaded: number; total: number }>()

function load(cacheDir: string): Promise<Transcriber> {
  env.cacheDir = cacheDir
  return pipeline('automatic-speech-recognition', MODEL, {
    dtype: 'q8',
    device: 'cpu',
    // One overall percentage across the model's files, for the "Downloading speech model" label.
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status !== 'progress' || !p.file || !p.total) return
      progress.set(p.file, { loaded: p.loaded ?? 0, total: p.total })
      const all = [...progress.values()]
      const percent = Math.floor((100 * all.reduce((s, f) => s + f.loaded, 0)) / all.reduce((s, f) => s + f.total, 0))
      port.postMessage({ type: 'progress', percent })
    }
  }) as unknown as Promise<Transcriber>
}

port.on('message', async ({ data }: { data: Job }) => {
  try {
    model ??= load(data.cacheDir)
    const transcribe = await model
    const out = await transcribe(data.samples, {
      language: data.language,
      task: 'transcribe',
      chunk_length_s: 30
    })
    port.postMessage({ type: 'result', id: data.id, text: out.text.trim() })
  } catch (err) {
    model = null // a failed download can be retried on the next recording
    port.postMessage({ type: 'error', id: data.id, message: (err as Error).message })
  }
})
