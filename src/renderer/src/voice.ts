// Records the microphone as 16 kHz mono samples, the format Whisper expects.
// Call the returned function to stop and get the audio.
export async function startRecording(): Promise<() => Promise<Float32Array>> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  })
  const context = new AudioContext({ sampleRate: 16000 })
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  processor.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
  source.connect(processor)
  processor.connect(context.destination)

  return async () => {
    processor.disconnect()
    source.disconnect()
    stream.getTracks().forEach((track) => track.stop())
    await context.close()
    const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
    let offset = 0
    for (const chunk of chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    return samples
  }
}
