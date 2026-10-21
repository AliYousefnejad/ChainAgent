import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { RowDataPacket } from 'mysql2'
import { ALL_TYPES } from './activity'
import type { Db } from './db'

// Contribution numbers per person and project, built from the synced GitLab data.
// Commits are matched to people by email (login email + linked commit emails),
// merge requests and MR events by GitLab username. Members only ever see themselves.

type Person = { id: number; name: string; email: string; role: string; gitlab: string | null; emails: string[] }
type Range = { start: string; end: string; project: number | null }

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const
const QUERY = {
  type: 'object',
  properties: { from: DATE, to: DATE, project: { type: 'integer', minimum: 1 }, author: { type: 'integer', minimum: 1 } }
} as const
const DEFAULT_DAYS = 30
const MR_LIMIT = 500

type Query = { from?: string; to?: string; project?: number; author?: number; user?: number; type?: string }
const LOG_QUERY = {
  type: 'object',
  properties: { ...QUERY.properties, user: { type: 'integer', minimum: 1 }, type: { type: 'string', enum: ALL_TYPES } }
} as const
const LOG_LIMIT = 500
// Usage columns in the People table, from the app's activity events.
const USAGE: Record<string, string> = {
  active: 'activeMinutes',
  window_opened: 'windows',
  prompt: 'prompts',
  turn_finished: 'turns',
  handoff: 'handoffs',
  plan_run: 'plans',
  team_run: 'teams'
}

// [start, end) in UTC; `to` is inclusive, so the end is the start of the next day.
function rangeOf(q: Query): Range {
  const to = q.to ?? new Date().toISOString().slice(0, 10)
  const from = q.from ?? new Date(Date.now() - DEFAULT_DAYS * 86_400_000).toISOString().slice(0, 10)
  const end = new Date(`${to}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + 1)
  return { start: `${from} 00:00:00`, end: end.toISOString().slice(0, 19).replace('T', ' '), project: q.project ?? null }
}

const isLead = (req: FastifyRequest) => req.user.role === 'admin' || req.user.role === 'manager'

export function insightRoutes(db: Db, guards: preHandlerHookHandler[]) {
  const people = async (onlyId?: number): Promise<Person[]> => {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT id, username, email, role, gitlab_username, git_emails FROM users ${onlyId ? 'WHERE id = ?' : ''} ORDER BY id`,
      onlyId ? [onlyId] : []
    )
    return rows.map((u) => ({
      id: u.id,
      name: u.username ?? u.email,
      email: u.email,
      role: u.role,
      gitlab: u.gitlab_username,
      emails: [u.email, ...((u.git_emails as string[] | null) ?? [])].map((e) => e.toLowerCase())
    }))
  }
  const ownerOfEmail = (all: Person[]) => {
    const map = new Map<string, Person>()
    for (const p of all) for (const e of p.emails) map.set(e, p)
    return map
  }
  const projectFilter = (r: Range, column = 'project_id') => (r.project ? ` AND ${column} = ${Number(r.project)}` : '')

  const commitsByEmail = async (r: Range) =>
    (
      await db.query<RowDataPacket[]>(
        `SELECT author_email AS email, MAX(author_name) AS name, COUNT(*) AS commits, SUM(additions) AS additions, SUM(deletions) AS deletions
         FROM commits WHERE authored_at >= ? AND authored_at < ?${projectFilter(r)} GROUP BY author_email`,
        [r.start, r.end]
      )
    )[0]
  const countBy = async (sql: string, r: Range) =>
    new Map((await db.query<RowDataPacket[]>(sql, [r.start, r.end]))[0].map((row) => [row.k, Number(row.n)]))

  return async (app: FastifyInstance) => {
    for (const guard of guards) app.addHook('preHandler', guard)

    app.get<{ Querystring: Query }>('/people', { schema: { querystring: QUERY } }, async (req) => {
      const r = rangeOf(req.query)
      const all = await people(isLead(req) ? undefined : req.user.id)
      const owner = ownerOfEmail(await people())
      const opened = await countBy(
        `SELECT author_username AS k, COUNT(*) AS n FROM merge_requests WHERE created_at >= ? AND created_at < ?${projectFilter(r)} GROUP BY author_username`,
        r
      )
      const merged = await countBy(
        `SELECT author_username AS k, COUNT(*) AS n FROM merge_requests WHERE merged_at >= ? AND merged_at < ?${projectFilter(r)} GROUP BY author_username`,
        r
      )
      const events = (action: string) =>
        countBy(
          `SELECT author_username AS k, COUNT(*) AS n FROM mr_events WHERE action = '${action}' AND created_at >= ? AND created_at < ?${projectFilter(r)} GROUP BY author_username`,
          r
        )
      const [approvals, comments, commits] = await Promise.all([events('approved'), events('commented'), commitsByEmail(r)])
      const [activity] = await db.query<RowDataPacket[]>(
        `SELECT user_id, type, SUM(count) AS n FROM activity WHERE created_at >= ? AND created_at < ?${projectFilter(r)} GROUP BY user_id, type`,
        [r.start, r.end]
      )
      const usage = new Map(all.map((p) => [p.id, Object.fromEntries(Object.values(USAGE).map((k) => [k, 0]))]))
      for (const a of activity) {
        const u = usage.get(a.user_id)
        if (u && USAGE[a.type]) u[USAGE[a.type]] = Number(a.n)
      }

      const stats = new Map(all.map((p) => [p.id, { commits: 0, additions: 0, deletions: 0 }]))
      for (const c of commits) {
        const s = stats.get(owner.get(c.email)?.id ?? -1)
        if (!s) continue
        s.commits += Number(c.commits)
        s.additions += Number(c.additions)
        s.deletions += Number(c.deletions)
      }
      return all.map((p) => ({
        userId: p.id,
        name: p.name,
        email: p.email,
        ...stats.get(p.id)!,
        mrsOpened: (p.gitlab && opened.get(p.gitlab)) || 0,
        mrsMerged: (p.gitlab && merged.get(p.gitlab)) || 0,
        approvals: (p.gitlab && approvals.get(p.gitlab)) || 0,
        comments: (p.gitlab && comments.get(p.gitlab)) || 0,
        ...usage.get(p.id)!
      }))
    })

    // The activity log: who did what, when, in which project. Members only see their own.
    // Active minutes (one a minute) would bury everything else, so they show only when filtered for.
    app.get<{ Querystring: Query }>('/activity', { schema: { querystring: LOG_QUERY } }, async (req) => {
      const r = rangeOf(req.query)
      const user = isLead(req) ? req.query.user : req.user.id
      const [rows] = await db.query<RowDataPacket[]>(
        `SELECT a.created_at, a.user_id, a.type, a.agent, a.detail, p.name AS project, COALESCE(u.username, u.email) AS name
         FROM activity a JOIN users u ON u.id = a.user_id LEFT JOIN projects p ON p.id = a.project_id
         WHERE a.created_at >= ? AND a.created_at < ?${projectFilter(r, 'a.project_id')}
         ${user ? 'AND a.user_id = ?' : ''} ${req.query.type ? 'AND a.type = ?' : "AND a.type <> 'active'"}
         ORDER BY a.created_at DESC, a.id DESC LIMIT ${LOG_LIMIT}`,
        [r.start, r.end, ...(user ? [user] : []), ...(req.query.type ? [req.query.type] : [])]
      )
      return rows.map((a) => ({
        at: a.created_at,
        userId: a.user_id,
        name: a.name,
        type: a.type,
        agent: a.agent,
        detail: a.detail,
        projectName: a.project
      }))
    })

    app.get<{ Querystring: Query }>('/unmatched', { schema: { querystring: QUERY } }, async (req, reply) => {
      if (!isLead(req)) return reply.code(403).send({ message: 'Managers only' })
      const owner = ownerOfEmail(await people())
      return (await commitsByEmail(rangeOf(req.query)))
        .filter((c) => !owner.has(c.email))
        .map((c) => ({ authorName: c.name, authorEmail: c.email, commits: Number(c.commits) }))
        .sort((a, b) => b.commits - a.commits)
    })

    app.get<{ Querystring: Query }>('/projects', { schema: { querystring: QUERY } }, async (req, reply) => {
      if (!isLead(req)) return reply.code(403).send({ message: 'Managers only' })
      const r = rangeOf(req.query)
      const range = (column: string) => `${column} >= ? AND ${column} < ?`
      const [rows] = await db.query<RowDataPacket[]>(
        `SELECT p.id, p.name, p.last_synced_at, p.sync_error,
           (SELECT COUNT(*) FROM commits c WHERE c.project_id = p.id AND ${range('c.authored_at')}) AS commits,
           (SELECT COALESCE(SUM(additions), 0) FROM commits c WHERE c.project_id = p.id AND ${range('c.authored_at')}) AS additions,
           (SELECT COALESCE(SUM(deletions), 0) FROM commits c WHERE c.project_id = p.id AND ${range('c.authored_at')}) AS deletions,
           (SELECT COUNT(*) FROM merge_requests m WHERE m.project_id = p.id AND ${range('m.created_at')}) AS mrsOpened,
           (SELECT COUNT(*) FROM merge_requests m WHERE m.project_id = p.id AND ${range('m.merged_at')}) AS mrsMerged,
           (SELECT COUNT(*) FROM mr_events e WHERE e.project_id = p.id AND e.action = 'approved' AND ${range('e.created_at')}) AS approvals,
           (SELECT COUNT(*) FROM mr_events e WHERE e.project_id = p.id AND e.action = 'commented' AND ${range('e.created_at')}) AS comments
         FROM projects p ${r.project ? `WHERE p.id = ${Number(r.project)}` : ''} ORDER BY p.name, p.id`,
        Array(7).fill([r.start, r.end]).flat()
      )
      // Contributors are people, not email addresses: one person may commit from several.
      const owner = ownerOfEmail(await people())
      const [authors] = await db.query<RowDataPacket[]>(
        `SELECT DISTINCT project_id, author_email FROM commits WHERE authored_at >= ? AND authored_at < ?`,
        [r.start, r.end]
      )
      const contributors = new Map<number, Set<string>>()
      for (const a of authors) {
        const who = owner.get(a.author_email)
        const set = contributors.get(a.project_id) ?? new Set()
        set.add(who ? `user:${who.id}` : a.author_email)
        contributors.set(a.project_id, set)
      }
      return rows.map((p) => ({
        projectId: p.id,
        name: p.name,
        commits: Number(p.commits),
        additions: Number(p.additions),
        deletions: Number(p.deletions),
        mrsOpened: Number(p.mrsOpened),
        mrsMerged: Number(p.mrsMerged),
        approvals: Number(p.approvals),
        comments: Number(p.comments),
        contributors: contributors.get(p.id)?.size ?? 0,
        lastSyncedAt: p.last_synced_at,
        syncError: p.sync_error
      }))
    })

    app.get<{ Querystring: Query }>('/merge-requests', { schema: { querystring: QUERY } }, async (req) => {
      const r = rangeOf(req.query)
      const all = await people()
      const byGitlab = new Map(all.filter((p) => p.gitlab).map((p) => [p.gitlab!, p]))
      // Members only see their own; leads may filter by person.
      const authorId = isLead(req) ? req.query.author : req.user.id
      let author: string | null = null
      if (authorId) {
        author = all.find((p) => p.id === authorId)?.gitlab ?? null
        if (!author) return []
      }
      const [rows] = await db.query<RowDataPacket[]>(
        `SELECT m.*, p.name AS project_name FROM merge_requests m JOIN projects p ON p.id = m.project_id
         WHERE ((m.created_at >= ? AND m.created_at < ?) OR (m.merged_at >= ? AND m.merged_at < ?))
         ${projectFilter(r, 'm.project_id')} ${author ? 'AND m.author_username = ?' : ''}
         ORDER BY m.created_at DESC LIMIT ${MR_LIMIT}`,
        [r.start, r.end, r.start, r.end, ...(author ? [author] : [])]
      )
      return rows.map((m) => ({
        projectId: m.project_id,
        projectName: m.project_name,
        iid: m.iid,
        title: m.title,
        authorName: byGitlab.get(m.author_username)?.name ?? m.author_name,
        state: m.state,
        createdAt: m.created_at,
        mergedAt: m.merged_at,
        mergedBy: m.merged_by,
        reviewers: m.reviewers ?? [],
        webUrl: m.web_url
      }))
    })
  }
}
