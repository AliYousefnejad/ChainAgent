import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { RowDataPacket } from 'mysql2'
import type { Db } from './db'

// Usage counts from the app: what happened, never what was written. Each event is stored for
// the signed-in user; the body can't name anyone else, and there is no field for prompt text.
export const CLIENT_TYPES = ['window_opened', 'window_closed', 'turn_finished', 'handoff', 'prompt', 'plan_run', 'team_run', 'active']
export const ALL_TYPES = ['login', 'logout', ...CLIENT_TYPES]
const AGENTS = ['claude', 'codex', 'gemini', 'opencode', 'shell']
const MAX_EVENTS = 200
// Batches arrive every ~30 s with one "active" minute at most; a little slack, no inflation.
const MAX_ACTIVE_PER_BATCH = 2

type Event = { type: string; agent?: string; detail?: string; repo?: string }

export async function record(db: Db, userId: number, type: string): Promise<void> {
  await db.query('INSERT INTO activity (user_id, type) VALUES (?, ?)', [userId, type])
}

// "host/group/project" from a git remote: https://host/group/project.git, git@host:group/project.git, ssh://git@host:22/group/project
function repoKey(remote: string): string | null {
  const scp = remote.match(/^[\w.-]+@([^:/]+):(.+)$/)
  let host: string
  let path: string
  if (scp) [, host, path] = scp
  else {
    try {
      const url = new URL(remote)
      host = url.hostname
      path = url.pathname
    } catch {
      return null
    }
  }
  return `${host}/${path.replace(/^\/+/, '').replace(/\.git$/, '')}`.toLowerCase()
}

export function activityRoutes(db: Db, guards: preHandlerHookHandler[]) {
  return async (app: FastifyInstance) => {
    for (const guard of guards) app.addHook('preHandler', guard)

    app.post<{ Body: { events: Event[] } }>(
      '/',
      {
        schema: {
          body: {
            type: 'object',
            required: ['events'],
            properties: {
              events: {
                type: 'array',
                maxItems: MAX_EVENTS,
                items: {
                  type: 'object',
                  required: ['type'],
                  properties: {
                    type: { type: 'string', enum: CLIENT_TYPES },
                    agent: { type: 'string', enum: AGENTS },
                    detail: { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' },
                    repo: { type: 'string', maxLength: 300 }
                  }
                }
              }
            }
          }
        }
      },
      async (req, reply) => {
        const [projects] = await db.query<RowDataPacket[]>('SELECT id, gitlab_url, gitlab_project FROM projects')
        const byRepo = new Map(
          projects.map((p) => [repoKey(`${p.gitlab_url.replace(/\/+$/, '')}/${p.gitlab_project}`), p.id as number])
        )
        let active = 0
        const rows = req.body.events
          .filter((e) => e.type !== 'active' || ++active <= MAX_ACTIVE_PER_BATCH)
          .map((e) => [
            req.user.id,
            (e.repo && byRepo.get(repoKey(e.repo))) || null,
            e.type,
            e.agent ?? null,
            e.detail ?? null
          ])
        if (rows.length) await db.query('INSERT INTO activity (user_id, project_id, type, agent, detail) VALUES ?', [rows])
        return reply.code(204).send()
      }
    )
  }
}
