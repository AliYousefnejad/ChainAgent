import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import notifyHelper from './notify-helper.cjs?raw'
import opencodePlugin from './opencode-plugin.js?raw'
import { writeZshIntegration } from './shell-integration'

// Agents report a finished turn by POSTing here: Claude through its Stop hook, Codex and
// Gemini through notify-helper.cjs. The secret and node id come from env vars on each pty.
export const HOOK_SECRET = randomBytes(24).toString('hex')
export const paths = { claudeSettings: '', geminiSettings: '', notifyHelper: '', opencodePlugin: '', rolesDir: '', zshDir: '' }
export let hookUrl = ''

const MAX_BODY = 5_000_000
const expectedAuth = Buffer.from(`Bearer ${HOOK_SECRET}`)

function authorized(header: string | undefined): boolean {
  const given = Buffer.from(header ?? '')
  return given.length === expectedAuth.length && timingSafeEqual(given, expectedAuth)
}

function emitToWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, ...args)
}

export function emitFinished(node: string, text: string): void {
  emitToWindows('agent:finished', node, text)
}

export async function startHookServer(): Promise<void> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/stop' || !authorized(req.headers.authorization)) {
      res.writeHead(401).end()
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY) req.destroy()
    })
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
      const node = req.headers['x-canvas-node']
      try {
        const input = JSON.parse(body)
        if (typeof node !== 'string') return
        if (input.hook_event_name === 'Ready') return emitToWindows('agent:ready', node)
        if (input.hook_event_name !== 'Stop' || !input.last_assistant_message) return
        emitFinished(node, input.last_assistant_message)
      } catch {
        // Not JSON: nothing to forward.
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  hookUrl = `http://127.0.0.1:${port}/stop`
  const dir = app.getPath('userData')
  paths.claudeSettings = join(dir, 'claude-hooks.json')
  paths.geminiSettings = join(dir, 'gemini-settings.json')
  paths.notifyHelper = join(dir, 'notify-helper.cjs')
  paths.zshDir = join(dir, 'zsh')
  paths.opencodePlugin = join(dir, 'opencode-chainagent.js')
  paths.rolesDir = join(dir, 'roles')

  const claudeHook = {
    type: 'http',
    url: hookUrl,
    headers: { Authorization: 'Bearer $CHAINAGENT_SECRET', 'X-Canvas-Node': '$CHAINAGENT_NODE' },
    allowedEnvVars: ['CHAINAGENT_SECRET', 'CHAINAGENT_NODE'],
    timeout: 5
  }
  writeFileSync(paths.notifyHelper, notifyHelper)
  writeFileSync(paths.opencodePlugin, opencodePlugin)
  mkdirSync(paths.rolesDir, { recursive: true })
  // SessionStart only runs once the folder is trusted, so it doubles as "this window is ready".
  const readyHook = { type: 'command', command: helperCommand('claude-ready'), timeout: 10 }
  writeFileSync(
    paths.claudeSettings,
    JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [claudeHook] }], SessionStart: [{ matcher: '', hooks: [readyHook] }] } }, null, 2)
  )
  const geminiHook = { type: 'command', name: 'chainagent-forward', command: helperCommand('gemini'), timeout: 10000 }
  const gemini = geminiSettings(geminiHook)
  if (gemini) writeFileSync(paths.geminiSettings, JSON.stringify(gemini, null, 2))
  else paths.geminiSettings = ''

  writeZshIntegration(paths.zshDir)
}

// GEMINI_CLI_SYSTEM_SETTINGS_PATH replaces Gemini's system settings file, which may hold
// company-enforced settings. Copy that file and add our hook to it; if it can't be read
// safely, return null so Gemini keeps its own file and simply doesn't report turns.
const GEMINI_SYSTEM_SETTINGS: Partial<Record<NodeJS.Platform, string>> = {
  linux: '/etc/gemini-cli/settings.json',
  darwin: '/Library/Application Support/GeminiCli/settings.json',
  win32: 'C:\\ProgramData\\gemini-cli\\settings.json'
}

function geminiSettings(hook: object): Record<string, any> | null {
  const current = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || GEMINI_SYSTEM_SETTINGS[process.platform]
  let settings: Record<string, any> = {}
  if (current && existsSync(current)) {
    try {
      settings = JSON.parse(readFileSync(current, 'utf8'))
    } catch {
      return null
    }
  }
  const hooks = settings.hooks ?? {}
  return { ...settings, hooks: { ...hooks, AfterAgent: [...(hooks.AfterAgent ?? []), { matcher: '*', hooks: [hook] }] } }
}

// `codex -c notify=…` replaces the user's own `notify` program, so the helper runs it too.
// Only a one-line top-level `notify = [...]` in config.toml is recognised.
export function codexUserNotify(): string | null {
  try {
    const file = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
    const topLevel = readFileSync(file, 'utf8').split(/^\s*\[/m)[0]
    const line = topLevel.match(/^\s*notify\s*=\s*(\[.*\])\s*$/m)
    const argv = line && JSON.parse(line[1])
    return Array.isArray(argv) && argv.length && argv.every((a) => typeof a === 'string') ? JSON.stringify(argv) : null
  } catch {
    return null
  }
}

export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

// Electron's own binary runs the helper as plain Node, so no separate node or curl is needed.
export const helperArgv = (source: 'codex' | 'gemini' | 'claude-ready') => [
  'env',
  'ELECTRON_RUN_AS_NODE=1',
  process.execPath,
  paths.notifyHelper,
  source
]

export const helperCommand = (source: 'codex' | 'gemini' | 'claude-ready') => helperArgv(source).map(shellQuote).join(' ')
