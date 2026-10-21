import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { startRecording } from './voice'

export type Target = { id: string; label: string; color: string }
type Props = {
  targets: Target[]
  chainStart: string | undefined
  busy: string // non-empty while planning or a plan runs; shown instead of the hint
  onSend: (text: string, target: string) => Promise<string | null> // returns an error message
  onPlan: (text: string, target: string) => Promise<string | null>
}

// Whisper here doesn't detect the language by itself (it falls back to English), so it's chosen.
const LANGUAGES = [
  { code: 'english', label: 'EN' },
  { code: 'persian', label: 'FA' }
]
const LANGUAGE_KEY = 'chainagent.voiceLanguage'
const AUTO = 'auto'

function savedLanguage(): number {
  try {
    return Math.max(0, LANGUAGES.findIndex((l) => l.code === localStorage.getItem(LANGUAGE_KEY)))
  } catch {
    return 0
  }
}

const MicIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
  </svg>
)
const SendIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)

export default function PromptBar({ targets, chainStart, busy, onSend, onPlan }: Props) {
  const [text, setText] = useState('')
  const [choice, setChoice] = useState(AUTO)
  const [planMode, setPlanMode] = useState(false)
  const [message, setMessage] = useState('')
  const [language, setLanguage] = useState(savedLanguage)
  const [voice, setVoice] = useState<'idle' | 'recording' | 'working'>('idle')
  const stopRef = useRef<(() => Promise<Float32Array>) | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const target = choice !== AUTO && targets.some((t) => t.id === choice) ? choice : chainStart
  const startLabel = targets.find((t) => t.id === chainStart)?.label

  useEffect(() => window.api.onSttProgress((p) => setMessage(`Downloading speech model ${p}%…`)), [])

  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  const submit = async () => {
    if (!text.trim() || !target || busy) return
    const error = await (planMode ? onPlan : onSend)(text.trim(), target)
    setMessage(error ?? '')
    if (!error) setText('')
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const toggleVoice = async () => {
    if (voice === 'working') return
    if (voice === 'idle') {
      try {
        stopRef.current = await startRecording()
        setVoice('recording')
        setMessage('Listening… click the mic again to stop')
      } catch {
        setMessage('Microphone not available. Check that one is connected and allowed.')
      }
      return
    }
    setVoice('working')
    setMessage('Transcribing…')
    const samples = await stopRef.current!()
    const result = await window.api.transcribe(samples, LANGUAGES[language].code)
    setVoice('idle')
    if (result.error) return setMessage(`Voice failed: ${result.error}`)
    setMessage(result.text ? '' : 'No speech heard.')
    if (result.text) setText((t) => (t ? `${t} ${result.text}` : result.text!))
    inputRef.current?.focus()
  }

  const cycleLanguage = () => {
    const next = (language + 1) % LANGUAGES.length
    setLanguage(next)
    try {
      localStorage.setItem(LANGUAGE_KEY, LANGUAGES[next].code)
    } catch {
      // Not remembered; still used for this session.
    }
  }

  const disabled = !targets.length

  return (
    <div className="prompt-wrap">
      <div className={planMode ? 'prompt-bar plan' : 'prompt-bar'}>
        <div className="prompt-inner">
          <div className="prompt-top">
            <label className="prompt-target">
              <span>To</span>
              <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={disabled}>
                <option value={AUTO}>{startLabel ? `${startLabel} (chain start)` : 'No agents yet'}</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className={planMode ? 'plan-switch on' : 'plan-switch'}
              role="switch"
              aria-checked={planMode}
              title="Plan: split the task into sub-tasks for the agents on the canvas"
              onClick={() => setPlanMode(!planMode)}
            >
              <span className="plan-knob" /> Plan
            </button>
            <button className="lang-chip" title="Voice language (click to switch)" onClick={cycleLanguage}>
              {LANGUAGES[language].label}
            </button>
          </div>
          <div className="prompt-row">
            <textarea
              ref={inputRef}
              rows={1}
              value={text}
              placeholder={
                disabled ? 'Drag an agent onto the canvas first' : planMode ? 'Describe the whole task — it will be split into steps…' : 'Ask the chain…'
              }
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={disabled}
            />
            <button
              className={`round-btn mic ${voice}`}
              title={voice === 'recording' ? 'Stop and transcribe' : 'Speak your prompt'}
              aria-label="Voice input"
              onClick={toggleVoice}
            >
              <MicIcon />
            </button>
            <button
              className="round-btn send"
              title={planMode ? 'Create plan' : 'Send'}
              aria-label={planMode ? 'Create plan' : 'Send'}
              onClick={submit}
              disabled={disabled || !text.trim() || !!busy}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
      {(busy || message) && <div className="prompt-message">{busy || message}</div>}
    </div>
  )
}
