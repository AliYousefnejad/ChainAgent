import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import type { Db } from './db'
import { checkProject, GitLabError, syncProject, type Target } from './gitlab'
import { decrypt, encrypt } from './secret'

type ProjectRow = RowDataPacket & {
  id: number
  name: string
  gitlab_url: string
  gitlab_project: string
  token_enc: string | null
  last_synced_at: Date | null
  sync_error: string | null
}

const ID_PARAMS = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } as const
const NAME = { type: 'string', minLength: 1, maxLength: 120 } as const
const TOKEN = { type: 'string', maxLength: 500 } as const

// The token never leaves the server; clients only learn whether one is set.
const publicProject = (p: ProjectRow) => ({
  id: p.id,
  name: p.name,
  gitlabUrl: p.gitlab_url,
  gitlabProject: p.gitlab_project,
  hasToken: Boolean(p.token_enc),
  lastSyncedAt: p.last_synced_at,
  syncError: p.sync_error
})

const targetOf = (p: ProjectRow): Target => ({
  url: p.gitlab_url,
  project: p.gitlab_project,
  token: p.token_enc ? decrypt(p.token_enc) : null
})

const syncing = new Set<number>()

async function runSync(db: Db, p: ProjectRow) {
  syncing.add(p.id)
  try {
    const counts = await syncProject(db, p.id, targetOf(p), p.last_synced_at)
    await db.query('UPDATE projects SET last_synced_at = UTC_TIMESTAMP(), sync_error = NULL WHERE id = ?', [p.id])
    return counts
  } catch (err) {
    await db.query('UPDATE projects SET sync_error = ? WHERE id = ?', [String((err as Error).message).slice(0, 500), p.id])
    throw err
  } finally {
    syncing.delete(p.id)
  }
}

// Every project, one after another; used by the periodic sync in index.ts.
export async function syncAll(db: Db): Promise<void> {
  const [rows] = await db.query<ProjectRow[]>('SELECT * FROM projects')
  for (const p of rows) await runSync(db, p).catch(() => {})
}

export function projectRoutes(db: Db, guards: preHandlerHookHandler[]) {
  const find = async (id: number) => (await db.query<ProjectRow[]>('SELECT * FROM projects WHERE id = ?', [id]))[0][0]

  return async (app: FastifyInstance) => {
    for (const guard of guards) app.addHook('preHandler', guard)

    app.get('/', async () => {
      const [rows] = await db.query<ProjectRow[]>('SELECT * FROM projects ORDER BY name, id')
      return rows.map(publicProject)
    })

    app.post<{ Body: { name: string; gitlabUrl: string; gitlabProject: string; token?: string } }>(
      '/',
      {
        schema: {
          body: {
            type: 'object',
            required: ['name', 'gitlabUrl', 'gitlabProject'],
            properties: {
              name: NAME,
              gitlabUrl: { type: 'string', pattern: '^https?://', maxLength: 255 },
              gitlabProject: { type: 'string', minLength: 1, maxLength: 255 },
              token: TOKEN
            }
          }
        }
      },
      async (req, reply) => {
        const { name, gitlabUrl, gitlabProject } = req.body
        const token = req.body.token?.trim() || null
        // Check the address, project and token with GitLab before saving anything.
        try {
          await checkProject({ url: gitlabUrl, project: gitlabProject.trim(), token })
        } catch (err) {
          const message = err instanceof GitLabError ? err.message : `Can't reach GitLab at ${gitlabUrl}`
          return reply.code(400).send({ message })
        }
        let tokenEnc: string | null = null
        try {
          tokenEnc = token ? encrypt(token) : null
        } catch (err) {
          return reply.code(400).send({ message: (err as Error).message })
        }
        const [result] = await db.query<ResultSetHeader>(
          'INSERT INTO projects (name, gitlab_url, gitlab_project, token_enc, created_by) VALUES (?, ?, ?, ?, ?)',
          [name.trim(), gitlabUrl.trim().replace(/\/+$/, ''), gitlabProject.trim(), tokenEnc, req.user.id]
        )
        return reply.code(201).send(publicProject(await find(result.insertId)))
      }
    )

    app.patch<{ Params: { id: number }; Body: { name?: string; token?: string } }>(
      '/:id',
      { schema: { params: ID_PARAMS, body: { type: 'object', properties: { name: NAME, token: TOKEN } } } },
      async (req, reply) => {
        const project = await find(req.params.id)
        if (!project) return reply.code(404).send({ message: 'Project not found' })
        if (req.body.name !== undefined) await db.query('UPDATE projects SET name = ? WHERE id = ?', [req.body.name.trim(), project.id])
        if (req.body.token !== undefined) {
          // An empty token removes it (public projects need none).
          const token = req.body.token.trim()
          if (token) {
            try {
              await checkProject({ ...targetOf(project), token })
            } catch (err) {
              return reply.code(400).send({ message: err instanceof GitLabError ? err.message : "Can't reach GitLab" })
            }
          }
          await db.query('UPDATE projects SET token_enc = ? WHERE id = ?', [token ? encrypt(token) : null, project.id])
        }
        return publicProject(await find(project.id))
      }
    )

    app.delete<{ Params: { id: number } }>('/:id', { schema: { params: ID_PARAMS } }, async (req, reply) => {
      const [result] = await db.query<ResultSetHeader>('DELETE FROM projects WHERE id = ?', [req.params.id])
      if (!result.affectedRows) return reply.code(404).send({ message: 'Project not found' })
      return reply.code(204).send()
    })

    app.post<{ Params: { id: number } }>('/:id/sync', { schema: { params: ID_PARAMS } }, async (req, reply) => {
      const project = await find(req.params.id)
      if (!project) return reply.code(404).send({ message: 'Project not found' })
      if (syncing.has(project.id)) return reply.code(409).send({ message: 'This project is already syncing' })
      try {
        return await runSync(db, project)
      } catch (err) {
        return reply.code(502).send({ message: (err as Error).message })
      }
    })
  }
}
