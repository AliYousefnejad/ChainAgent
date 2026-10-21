import { execFile } from 'node:child_process'
import { request } from './auth'

// Usage counts for Insights: what happened and with which agent, never prompts, answers or code.
// Events are batched and sent with the signed-in user's session; the server decides whose they are.
type Event = { type: string; agent?: string; detail?: string; repo?: string }

// The renderer may only report these; windows and turns are recorded here in the main process.
const RENDERER_TYPES = ['handoff', 'prompt', 'plan_run', 'team_run', 'active']
const FLUSH_MS = 30_000
const BATCH = 200 // the server's limit per request
const MAX_QUEUED = 1000
const MAX_REPO = 300 // the server's limit; a longer remote would get the whole batch refused

const queue: Event[] = []
type Window = { agent: string; cwd: string }
const windows = new Map<string, Window>()
const repos = new Map<string, Promise<string | undefined>>()
const pending = new Set<Promise<void>>() // events still looking up their repo
let generation = 0 // bumped by clear(), so a batch sent before it is never re-queued after it

// Clones often carry a token in the remote (https://oauth2:<token>@host/group/app.git). Only host
// and path are needed to find the project, so the user and password are dropped. scp-style
// remotes (git@host:group/app.git) aren't URLs and hold no secret.
function withoutCredentials(remote: string): string {
  try {
    const url = new URL(remote)
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return remote
  }
}

// The folder's origin remote, so the server can match it to a project. Cached per folder.
function repoOf(cwd: string): Promise<string | undefined> {
  if (!cwd) return Promise.resolve(undefined)
  let repo = repos.get(cwd)
  if (!repo) {
    repo = new Promise((resolve) =>
      execFile('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeout: 3000 }, (err, out) =>
        resolve(err || !out.trim() ? undefined : withoutCredentials(out.trim()))
      )
    )
    repo = repo.then((r) => (r && r.length <= MAX_REPO ? r : undefined))
    repos.set(cwd, repo)
  }
  return repo
}

function push(type: string, win?: Window, detail?: string): void {
  const done = (win ? repoOf(win.cwd) : Promise.resolve(undefined)).then((repo) => {
    if (queue.length < MAX_QUEUED) queue.push({ type, agent: win?.agent, detail, repo })
    pending.delete(done)
  })
  pending.add(done)
}

export function windowOpened(nodeId: string, agent: string, cwd: string): void {
  const win = { agent, cwd }
  windows.set(nodeId, win)
  push('window_opened', win)
}

export function windowClosed(nodeId: string): void {
  const win = windows.get(nodeId)
  if (!win) return
  windows.delete(nodeId)
  push('window_closed', win)
}

export function turnFinished(nodeId: string): void {
  push('turn_finished', windows.get(nodeId))
}

export function fromRenderer(type: string, nodeId?: string, detail?: string): void {
  if (!RENDERER_TYPES.includes(type)) return
  push(type, typeof nodeId === 'string' ? windows.get(nodeId) : undefined, typeof detail === 'string' ? detail : undefined)
}

// Sends what's queued. Kept for a retry only when the server couldn't be reached.
export async function flush(): Promise<void> {
  await Promise.all(pending)
  const gen = generation
  while (queue.length) {
    const events = queue.splice(0, BATCH)
    const res = await request('POST', '/activity', { events })
    if (res.status === 0) {
      if (gen === generation) queue.unshift(...events)
      return
    }
  }
}

// At sign-out, after the last flush: what couldn't be sent must not go out under the next user.
export function clear(): void {
  queue.length = 0
  generation++
}

export function startFlushing(): void {
  setInterval(flush, FLUSH_MS)
}
