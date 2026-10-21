import { homedir } from 'node:os'
import type { WebContents } from 'electron'
import { spawn as spawnPty, type IPty } from 'node-pty'
import { AGENTS } from '../renderer/src/agents'
import { HOOK_SECRET, hookSettingsPath } from './hooks'

type Session = { pty: IPty; dispose: () => void }
const sessions = new Map<string, Session>()

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

// Returns an error message, or null when the session is running.
export function spawn(wc: WebContents, id: string, agentId: string, cwd: string, cols: number, rows: number): string | null {
  if (sessions.has(id)) return null
  const agent = AGENTS.find((a) => a.id === agentId)
  if (!agent) return `Unknown agent "${agentId}"`

  // Login + interactive shell so the user's PATH (.zshrc / .bashrc) finds the CLI.
  const shell = process.env.SHELL || '/bin/bash'
  // Claude gets the canvas Stop hook on top of the user's own settings (hooks from --settings merge).
  const command = agent.id === 'claude' ? `${agent.command} --settings ${shellQuote(hookSettingsPath)}` : agent.command
  const args = agent.id === 'shell' ? ['-l', '-i'] : ['-l', '-i', '-c', `exec ${command}`]
  const hookEnv = agent.id === 'claude' ? { CHAINAGENT_NODE: id, CHAINAGENT_SECRET: HOOK_SECRET } : {}
  try {
    const pty = spawnPty(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || homedir(),
      env: { ...process.env, ...hookEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
    })
    const onData = pty.onData((data) => !wc.isDestroyed() && wc.send('pty:data', id, data))
    const onExit = pty.onExit(({ exitCode }) => {
      sessions.delete(id)
      if (!wc.isDestroyed()) wc.send('pty:exit', id, exitCode)
    })
    sessions.set(id, { pty, dispose: () => (onData.dispose(), onExit.dispose()) })
    return null
  } catch (err) {
    return (err as Error).message
  }
}

export function write(id: string, data: string): void {
  sessions.get(id)?.pty.write(data)
}

// Types text into the session as one pasted prompt, then submits it.
// Control characters are dropped so the text can't end the paste early or send keys.
export function deliver(id: string, text: string): void {
  const session = sessions.get(id)
  if (!session) return
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  session.pty.write(`\x1b[200~${clean}\x1b[201~`)
  setTimeout(() => sessions.get(id)?.pty.write('\r'), 150)
}

export function resize(id: string, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) sessions.get(id)?.pty.resize(cols, rows)
}

// Listeners go first so a late exit event can't reach a re-spawned session with the same id.
export function kill(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  session.dispose()
  session.pty.kill()
}

export function killAll(): void {
  for (const id of [...sessions.keys()]) kill(id)
}
