import { homedir } from 'node:os'
import type { WebContents } from 'electron'
import { spawn as spawnPty, type IPty } from 'node-pty'
import { AGENTS } from '../renderer/src/agents'
import { codexUserNotify, emitFinished, HOOK_SECRET, helperArgv, hookUrl, paths, shellQuote } from './hooks'
import { commandTracker } from './shell-integration'

// shellIdle: set for Shell sessions; null when the shell has no integration (not zsh).
type Session = { pty: IPty; dispose: () => void; isShell: boolean; shellIdle: (() => boolean) | null }
export type DeliverResult = 'sent' | 'shell busy' | 'needs zsh' | 'closed'
const sessions = new Map<string, Session>()

// Returns an error message, or null when the session is running.
export function spawn(wc: WebContents, id: string, agentId: string, cwd: string, cols: number, rows: number): string | null {
  if (sessions.has(id)) return null
  const agent = AGENTS.find((a) => a.id === agentId)
  if (!agent) return `Unknown agent "${agentId}"`

  // Login + interactive shell so the user's PATH (.zshrc / .bashrc) finds the CLI.
  const shell = process.env.SHELL || '/bin/bash'
  const isZsh = shell.endsWith('/zsh')
  const report = { CHAINAGENT_HOOK_URL: hookUrl, CHAINAGENT_SECRET: HOOK_SECRET, CHAINAGENT_NODE: id }
  let command = agent.command
  let extraEnv: Record<string, string> = {}

  // Each agent gets its own way to report a finished turn, without touching the user's config files.
  if (agent.id === 'claude') {
    // Hooks from --settings are merged with the user's own.
    command = `${agent.command} --settings ${shellQuote(paths.claudeSettings)}`
    extraEnv = report
  } else if (agent.id === 'codex') {
    command = `${agent.command} -c ${shellQuote(`notify=${JSON.stringify(helperArgv('codex'))}`)}`
    const userNotify = codexUserNotify()
    extraEnv = userNotify ? { ...report, CHAINAGENT_CODEX_NOTIFY: userNotify } : report
  } else if (agent.id === 'gemini' && paths.geminiSettings) {
    extraEnv = {
      ...report,
      ...Object.fromEntries(Object.entries(report).map(([k, v]) => [`GEMINI_CLI_${k}`, v])),
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: paths.geminiSettings
    }
  } else if (agent.id === 'shell' && isZsh) {
    extraEnv = { ZDOTDIR: paths.zshDir, ...(process.env.ZDOTDIR ? { CHAINAGENT_USER_ZDOTDIR: process.env.ZDOTDIR } : {}) }
  }
  const args = agent.id === 'shell' ? ['-l', '-i'] : ['-l', '-i', '-c', `exec ${command}`]
  try {
    const pty = spawnPty(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || homedir(),
      env: { ...process.env, ...extraEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
    })
    const track = agent.id === 'shell' && isZsh ? commandTracker((text) => emitFinished(id, text)) : null
    const onData = pty.onData((data) => {
      track?.feed(data)
      if (!wc.isDestroyed()) wc.send('pty:data', id, data)
    })
    const onExit = pty.onExit(({ exitCode }) => {
      sessions.delete(id)
      if (!wc.isDestroyed()) wc.send('pty:exit', id, exitCode)
    })
    sessions.set(id, {
      pty,
      dispose: () => (onData.dispose(), onExit.dispose()),
      isShell: agent.id === 'shell',
      shellIdle: track ? track.idle : null
    })
    return null
  } catch (err) {
    return (err as Error).message
  }
}

export function write(id: string, data: string): void {
  sessions.get(id)?.pty.write(data)
}

// Types text into the session as one paste, then submits it unless `submit` is false.
// Control characters are dropped so the text can't end the paste early or send keys.
// A Shell only takes a paste while idle at its own zsh prompt: inside ssh, a REPL or an
// older shell, a multi-line paste could run line by line even without Enter.
export function deliver(id: string, text: string, submit: boolean): DeliverResult {
  const session = sessions.get(id)
  if (!session) return 'closed'
  if (session.isShell && !session.shellIdle) return 'needs zsh'
  if (session.shellIdle && !session.shellIdle()) return 'shell busy'
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  session.pty.write(`\x1b[200~${clean}\x1b[201~`)
  // Gemini turns an Enter within 40 ms of a paste into a newline, so wait a little.
  if (submit) setTimeout(() => sessions.get(id)?.pty.write('\r'), 150)
  return 'sent'
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
