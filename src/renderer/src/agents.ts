export type Agent = {
  id: string
  name: string
  command: string
  color: string
  glyph: string
}

export const AGENTS: Agent[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude', color: '#d97757', glyph: '✳' },
  { id: 'codex', name: 'Codex CLI', command: 'codex', color: '#10a37f', glyph: '◎' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', color: '#4f8df5', glyph: '✦' },
  { id: 'shell', name: 'Shell', command: '$SHELL', color: '#a0a7b4', glyph: '›_' }
]

export const agentById = (id: string): Agent => AGENTS.find((a) => a.id === id) ?? AGENTS[0]

export const AGENT_MIME = 'application/x-agent-id'
