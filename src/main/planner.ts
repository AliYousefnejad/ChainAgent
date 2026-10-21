import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { shellQuote } from './hooks'

export type PlanWindow = { id: string; agent: string; name: string; cwd: string }
export type PlanStep = { id: string; agent: string; title: string; prompt: string; dependsOn: string[] }
export type PlanResult = { steps: PlanStep[] } | { error: string }

const TIMEOUT_MS = 180_000

const SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          agent: { type: 'string' },
          title: { type: 'string' },
          prompt: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } }
        },
        required: ['id', 'agent', 'title', 'prompt', 'dependsOn']
      }
    }
  },
  required: ['steps']
}

const RULES = `You are the planner for ChainAgent, a canvas of AI agent windows and shell windows.
Split the user's task into a few steps and give each step to one of the listed windows, using its exact id.
- Use only the listed window ids. A window may get several steps; not every window needs one.
- For a window of type "shell", the step prompt must be only the exact shell commands to run, one per line.
- For agent windows (claude, codex, gemini), write a self-contained prompt. A step automatically receives the
  final results of the steps in its dependsOn, so never ask an agent to go and fetch them.
- Use dependsOn (ids of earlier steps) only for real dependencies; independent steps run in parallel.
- Keep the plan short. Do not carry out the task yourself; you may read files to plan better.`

export function createPlan(
  task: string,
  windows: PlanWindow[],
  wires: { source: string; target: string }[],
  cwd: string
): Promise<PlanResult> {
  if (!windows.length) return Promise.resolve({ error: 'Add an agent to the canvas first.' })

  const input = [
    `Task:\n${task}`,
    `Windows:\n${windows.map((w) => `- id "${w.id}": ${w.name} (type ${w.agent}), folder ${w.cwd}`).join('\n')}`,
    wires.length ? `Wires (output flows from → to):\n${wires.map((w) => `- ${w.source} → ${w.target}`).join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')

  // Read-only planning: only file-reading tools, no MCP servers (they could have side effects),
  // and no canvas hook, so nothing is forwarded.
  const command = [
    'claude', '-p',
    '--output-format', 'json',
    '--max-turns', '6',
    '--tools', 'Read,Glob,Grep',
    '--strict-mcp-config',
    '--json-schema', JSON.stringify(SCHEMA),
    '--append-system-prompt', RULES
  ]
    .map(shellQuote)
    .join(' ')

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: PlanResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    // Login + interactive shell so `claude` is found on the user's PATH.
    const shell = process.env.SHELL || '/bin/bash'
    const child = spawn(shell, ['-l', '-i', '-c', `exec ${command}`], { cwd: cwd || homedir(), stdio: 'pipe' })
    const timer = setTimeout(() => {
      child.kill()
      finish({ error: 'The planner took longer than 3 minutes. Try a shorter task.' })
    }, TIMEOUT_MS)

    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.resume() // drain it, or a chatty login shell could fill the pipe and stall Claude
    child.on('error', (err) => finish({ error: `Could not start Claude: ${err.message}` }))
    child.on('close', () => finish(parseResult(out, windows)))
    child.stdin.end(input)
  })
}

// The shell's startup files may print text first, so look for Claude's result line from the end.
function parseResult(out: string, windows: PlanWindow[]): PlanResult {
  const result = out
    .split('\n')
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .find((value) => value?.type === 'result')

  if (!result) return { error: 'Claude did not return a plan. Is `claude` installed and logged in?' }
  if (result.is_error || !result.structured_output?.steps) {
    return { error: `Planning failed: ${result.result || result.subtype || 'no plan returned'}` }
  }
  return validate(result.structured_output.steps, windows)
}

function validate(steps: PlanStep[], windows: PlanWindow[]): PlanResult {
  const ids = new Set(steps.map((s) => s.id))
  if (ids.size !== steps.length) return { error: 'The plan has duplicate step ids.' }
  const unknown = steps.find((s) => !windows.some((w) => w.id === s.agent))
  if (unknown) return { error: `The plan uses an unknown window "${unknown.agent}".` }

  const cleaned = steps.map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => ids.has(d) && d !== s.id) }))
  // Every step must become runnable: repeatedly take steps whose dependencies are all taken.
  const done = new Set<string>()
  while (done.size < cleaned.length) {
    const ready = cleaned.filter((s) => !done.has(s.id) && s.dependsOn.every((d) => done.has(d)))
    if (!ready.length) return { error: 'The plan has steps that depend on each other in a loop.' }
    ready.forEach((s) => done.add(s.id))
  }
  return { steps: cleaned }
}
