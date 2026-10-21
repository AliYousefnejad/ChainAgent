import type { Db } from './db'

// Reads contribution data from a GitLab instance (REST v4) for one project:
// commits with line stats, merge requests, and approval/comment events.
export type Target = { url: string; project: string; token: string | null }

export class GitLabError extends Error {}

const PER_PAGE = 100
const MAX_PAGES = 200 // safety net: 20,000 records per kind and sync
const MAX_RETRIES = 3
const FIRST_SYNC_DAYS = 90
const OVERLAP_DAYS = 7 // re-read a week back: commits can be pushed long after they were authored

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// MySQL DATETIME in UTC.
const sqlTime = (iso: string) => new Date(iso).toISOString().slice(0, 19).replace('T', ' ')

async function get(target: Target, path: string, params: Record<string, string> = {}) {
  const url = new URL(`${target.url.replace(/\/+$/, '')}/api/v4/projects/${encodeURIComponent(target.project)}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  for (let attempt = 0; ; attempt++) {
    // No redirects: fetch would carry the token header along to wherever GitLab points.
    const res = await fetch(url, { headers: target.token ? { 'PRIVATE-TOKEN': target.token } : {}, redirect: 'error' })
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep(Math.min(Number(res.headers.get('retry-after')) || 5, 60) * 1000)
      continue
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new GitLabError(`GitLab answered ${res.status}: ${body.message ?? body.error ?? res.statusText}`)
    }
    return { data: await res.json(), next: res.headers.get('x-next-page') || '' }
  }
}

// Follows x-next-page; commits never report totals, so that header is the only way to page.
// Stops when a page repeats an earlier one: some GitLab endpoints (commits with all=true on
// gitlab.com) ignore the page number while x-next-page keeps counting up.
async function getAll(target: Target, path: string, params: Record<string, string>): Promise<any[]> {
  const all: any[] = []
  const seen = new Set<string>()
  let page = '1'
  for (let i = 0; page && i < MAX_PAGES; i++) {
    const { data, next } = await get(target, path, { ...params, per_page: String(PER_PAGE), page })
    const first = data[0] && String(data[0].id)
    if (first && seen.has(first)) break
    if (first) seen.add(first)
    all.push(...data)
    page = next
  }
  return all
}

const BATCH = 500

// Bulk upsert: `rows` become one multi-row VALUES per batch.
async function insertRows(db: Db, sql: string, rows: unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) await db.query(sql, [rows.slice(i, i + BATCH)])
}

export async function checkProject(target: Target): Promise<{ id: number; path: string }> {
  const { data } = await get(target, '')
  return { id: data.id, path: data.path_with_namespace }
}

export async function syncProject(db: Db, projectId: number, target: Target, lastSyncedAt: Date | null) {
  const since = lastSyncedAt
    ? new Date(lastSyncedAt.getTime() - OVERLAP_DAYS * 86_400_000)
    : new Date(Date.now() - FIRST_SYNC_DAYS * 86_400_000)
  const sinceIso = since.toISOString()

  // Commits on the default branch: the work that landed (open work shows up as merge requests).
  // all=true can't be paged reliably on gitlab.com. Merge commits only repeat the lines they merge.
  const commits = [
    ...new Map(
      (await getAll(target, '/repository/commits', { with_stats: 'true', since: sinceIso }))
        .filter((c) => (c.parent_ids?.length ?? 1) <= 1)
        .map((c) => [c.id, c])
    ).values()
  ]
  await insertRows(
    db,
    `INSERT INTO commits (project_id, sha, author_name, author_email, authored_at, additions, deletions) VALUES ?
     ON DUPLICATE KEY UPDATE author_name = VALUES(author_name), author_email = VALUES(author_email),
       additions = VALUES(additions), deletions = VALUES(deletions)`,
    commits.map((c) => [
      projectId,
      c.id,
      c.author_name,
      c.author_email.toLowerCase(),
      sqlTime(c.authored_date),
      c.stats?.additions ?? 0,
      c.stats?.deletions ?? 0
    ])
  )

  const mrs = [
    ...new Map(
      (await getAll(target, '/merge_requests', { state: 'all', updated_after: sinceIso, order_by: 'updated_at', sort: 'asc' })).map(
        (m) => [m.iid, m]
      )
    ).values()
  ]
  await insertRows(
    db,
    `INSERT INTO merge_requests (project_id, iid, title, author_username, author_name, state, created_at, merged_at, merged_by, reviewers, web_url)
     VALUES ? ON DUPLICATE KEY UPDATE title = VALUES(title), state = VALUES(state), merged_at = VALUES(merged_at),
       merged_by = VALUES(merged_by), reviewers = VALUES(reviewers)`,
    mrs.map((m) => [
        projectId,
        m.iid,
        String(m.title).slice(0, 500),
        m.author.username,
        m.author.name,
        m.state,
        sqlTime(m.created_at),
        m.merged_at ? sqlTime(m.merged_at) : null,
        m.merge_user?.username ?? m.merged_by?.username ?? null,
        JSON.stringify((m.reviewers ?? []).map((r: { username: string }) => r.username)),
        m.web_url
      ])
  )

  // The Events API gives approvals and comments in one call per project instead of one per MR.
  // Only comments on merge requests count; comment text is never stored.
  const after = since.toISOString().slice(0, 10)
  const approved = await getAll(target, '/events', { action: 'approved', after })
  const commented = (await getAll(target, '/events', { action: 'commented', after })).filter(
    (e) => e.note?.noteable_type === 'MergeRequest'
  )
  const events = [
    ...new Map(
      [
        ...approved.map((e) => ({ e, action: 'approved', iid: e.target_iid })),
        ...commented.map((e) => ({ e, action: 'commented', iid: e.note.noteable_iid }))
      ].map((x) => [x.e.id, x])
    ).values()
  ]
  await insertRows(
    db,
    'INSERT IGNORE INTO mr_events (project_id, event_id, action, author_username, target_iid, created_at) VALUES ?',
    events.map(({ e, action, iid }) => [projectId, e.id, action, e.author_username, iid ?? null, sqlTime(e.created_at)])
  )

  return { commits: commits.length, mergeRequests: mrs.length, events: events.length }
}
