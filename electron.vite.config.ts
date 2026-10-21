import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // The speech worker is a second entry, started as an Electron utility process.
    build: { rolldownOptions: { input: { index: 'src/main/index.ts', 'stt-worker': 'src/main/stt-worker.ts' } } }
  },
  // Preloads can't be ESM when sandboxed; .cjs keeps it CommonJS even with the sandbox off.
  preload: {
    build: { rolldownOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    plugins: [react()]
  }
})
