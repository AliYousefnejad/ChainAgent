import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { startRecording } from './voice'
import { AGENTS } from './agents'
import type { AgentType } from './api'

export type Target = { id: string; label: string; color: string }
type Props = {
  targets: Target[]
  chainStart: string | undefined
  busy: string // non-empty while planning or a plan runs; shown instead of the hint
  onSend: (text: string, target: string) => Promise<string | null> // returns an error message
  onPlan: (text: string, target: string) => Promise<string | null>
  onTeam: (text: string, allowed: AgentType[]) => Promise<string | null>
  panel?: ReactNode // the plan or team panel, stacked right above the box whatever its height
}

type Mode = 'send' | 'plan' | 'team'
const MODES: { id: Mode; label: string; title: string }[] = [
  { id: 'send', label: 'Send', title: 'Send the prompt into the chain' },
  { id: 'plan', label: 'Plan', title: 'Split the task into steps for the windows on the canvas' },
  { id: 'team', label: 'Team', title: 'Let Claude design a new team of agents for the task' }
]
const PLACEHOLDER: Record<Mode, string> = {
  send: 'Ask the chain…',
  plan: 'Describe the whole task. It will be split into steps…',
  team: 'Describe the task. Claude will design a team of agents for it…'
}
const TEAM_KEY = 'chainagent.teamAgents'
const ALL_TYPES = AGENTS.map((a) => a.id as AgentType)

// Agent types Claude may use for a team. Claude always stays: it leads the team.
function savedTeamTypes(): AgentType[] {
  try {
    const saved = JSON.parse(localStorage.getItem(TEAM_KEY) ?? 'null')
    if (Array.isArray(saved) && saved.includes('claude')) return saved.filter((t) => ALL_TYPES.includes(t))
  } catch {
    // Fall back to every type.
  }
  return ALL_TYPES
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

export default function PromptBar({ targets, chainStart, busy, onSend, onPlan, onTeam, panel }: Props) {
  const [text, setText] = useState('')
  const [choice, setChoice] = useState(AUTO)
  const [mode, setMode] = useState<Mode>('send')
  const [teamTypes, setTeamTypes] = useState(savedTeamTypes)
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

  const toggleType = (type: AgentType) => {
    if (type === 'claude') return
    const next = teamTypes.includes(type) ? teamTypes.filter((t) => t !== type) : [...teamTypes, type]
    setTeamTypes(next)
    try {
      localStorage.setItem(TEAM_KEY, JSON.stringify(next))
    } catch {
      // Not remembered; still used for this session.
    }
  }

  const submit = async () => {
    if (!text.trim() || busy || (mode !== 'team' && !target)) return
    const error =
      mode === 'team' ? await onTeam(text.trim(), teamTypes) : await (mode === 'plan' ? onPlan : onSend)(text.trim(), target!)
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

  // Team mode builds its own windows, so it works on an empty canvas.
  const disabled = !targets.length && mode !== 'team'

  return (
    <div className="prompt-wrap">
      {panel}
      <div className={mode === 'send' ? 'prompt-bar' : 'prompt-bar plan'}>
        <div className="prompt-inner">
          <div className="prompt-top">
            {mode === 'team' ? (
              <div className="team-types" title="Agent types Claude may use for the team">
                <span>Use</span>
                {AGENTS.map((a) => (
                  <button
                    key={a.id}
                    className={teamTypes.includes(a.id as AgentType) ? 'type-chip on' : 'type-chip'}
                    style={{ '--accent': a.color } as React.CSSProperties}
                    aria-pressed={teamTypes.includes(a.id as AgentType)}
                    title={a.id === 'claude' ? 'Claude always leads the team' : `Allow ${a.name}`}
                    onClick={() => toggleType(a.id as AgentType)}
                  >
                    {a.glyph} {a.name.replace(' CLI', '').replace(' Code', '')}
                  </button>
                ))}
              </div>
            ) : (
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
            )}
            <div className="mode-switch" role="radiogroup" aria-label="Prompt mode">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  role="radio"
                  aria-checked={mode === m.id}
                  className={mode === m.id ? 'on' : ''}
                  title={m.title}
                  onClick={() => setMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
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
                disabled ? 'Drag an agent onto the canvas first, or switch to Team' : PLACEHOLDER[mode]
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
              title={mode === 'team' ? 'Design a team' : mode === 'plan' ? 'Create plan' : 'Send'}
              aria-label={mode === 'team' ? 'Design a team' : mode === 'plan' ? 'Create plan' : 'Send'}
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
