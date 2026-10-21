import { randomBytes, timingSafeEqual } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

// Claude sessions get a Stop hook that POSTs here when they finish a turn.
// The hook reads the secret and node id from env vars set on each pty.
export const HOOK_SECRET = randomBytes(24).toString('hex')
export let hookSettingsPath = ''

const MAX_BODY = 5_000_000
const expectedAuth = Buffer.from(`Bearer ${HOOK_SECRET}`)

function authorized(header: string | undefined): boolean {
  const given = Buffer.from(header ?? '')
  return given.length === expectedAuth.length && timingSafeEqual(given, expectedAuth)
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
        if (input.hook_event_name !== 'Stop' || typeof node !== 'string' || !input.last_assistant_message) return
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('agent:finished', node, input.last_assistant_message)
        }
      } catch {
        // Not JSON: nothing to forward.
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  hookSettingsPath = join(app.getPath('userData'), 'claude-hooks.json')
  const hook = {
    type: 'http',
    url: `http://127.0.0.1:${port}/stop`,
    headers: { Authorization: 'Bearer $CHAINAGENT_SECRET', 'X-Canvas-Node': '$CHAINAGENT_NODE' },
    allowedEnvVars: ['CHAINAGENT_SECRET', 'CHAINAGENT_NODE'],
    timeout: 5
  }
  writeFileSync(hookSettingsPath, JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [hook] }] } }, null, 2))
}
