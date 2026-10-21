// Run as Node (ELECTRON_RUN_AS_NODE=1) by Codex's `notify` and Gemini's AfterAgent hook
// when they finish a turn, and by Claude's SessionStart hook ("claude-ready") once a Claude
// window is up. Reports to ChainAgent's local /stop endpoint.
const http = require('node:http')
const { spawn } = require('node:child_process')

// Gemini can redact env names containing SECRET; GEMINI_CLI_* names always pass.
const env = (name) => process.env[`CHAINAGENT_${name}`] || process.env[`GEMINI_CLI_CHAINAGENT_${name}`]

function post(text, event = 'Stop') {
  return new Promise((resolve) => {
    const [url, secret, node] = [env('HOOK_URL'), env('SECRET'), env('NODE')]
    if (!url || !secret || !node || (event === 'Stop' && !text)) return resolve()
    const body = JSON.stringify({ hook_event_name: event, last_assistant_message: text })
    const req = http.request(url, {
      method: 'POST',
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${secret}`,
        'X-Canvas-Node': node
      }
    })
    req.on('response', (res) => res.resume().on('end', resolve))
    req.on('error', resolve)
    req.on('timeout', () => req.destroy())
    req.end(body)
  })
}

async function main(source) {
  if (source === 'codex') {
    // Codex appends the event as one JSON argument.
    const arg = process.argv[process.argv.length - 1]
    const event = JSON.parse(arg)
    if (event.type === 'agent-turn-complete') await post(event['last-assistant-message'])
    // Still run the user's own notify program, which our -c override replaced.
    const userNotify = process.env.CHAINAGENT_CODEX_NOTIFY && JSON.parse(process.env.CHAINAGENT_CODEX_NOTIFY)
    if (userNotify) spawn(userNotify[0], [...userNotify.slice(1), arg], { stdio: 'ignore', detached: true }).unref()
  } else if (source === 'claude-ready') {
    // Nothing may be printed: SessionStart output would be added to Claude's context.
    await post('', 'Ready')
  } else if (source === 'gemini') {
    let input = ''
    for await (const chunk of process.stdin) input += chunk
    await post(JSON.parse(input).prompt_response)
  }
}

const source = process.argv[2]
main(source)
  .catch(() => {})
  // Gemini requires JSON on stdout; an empty object means "carry on".
  .finally(() => source === 'gemini' && process.stdout.write('{}'))
