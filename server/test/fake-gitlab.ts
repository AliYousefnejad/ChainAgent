import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// A tiny stand-in for a GitLab instance with one project, "team/app" (id 42).
// It serves two pages of commits (the second only after one 429), merge requests and events.
export const GOOD_TOKEN = 'glpat-good'

const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()

export const fixtures = {
  commitsPage1: [
    { id: 'a'.repeat(40), author_name: 'Sara K', author_email: 'sara@corp.com', authored_date: recent(1), parent_ids: ['p1'], stats: { additions: 10, deletions: 2 } },
    { id: 'b'.repeat(40), author_name: 'Sara K', author_email: 'SARA.home@gmail.com', authored_date: recent(2), parent_ids: ['p2'], stats: { additions: 5, deletions: 5 } }
  ],
  commitsPage2: [
    // A merge commit: two parents, must not be counted.
    { id: 'c'.repeat(40), author_name: 'Sara K', author_email: 'sara@corp.com', authored_date: recent(1), parent_ids: ['x', 'y'], stats: { additions: 100, deletions: 100 } },
    { id: 'd'.repeat(40), author_name: 'Stranger', author_email: 'who@else.org', authored_date: recent(3), parent_ids: ['p3'], stats: { additions: 7, deletions: 0 } },
    // Outside a 7-day window, inside the 90-day first sync.
    { id: 'e'.repeat(40), author_name: 'Omid R', author_email: 'omid@corp.com', authored_date: recent(20), parent_ids: ['p4'], stats: { additions: 3, deletions: 1 } }
  ],
  mergeRequests: [
    { iid: 1, title: 'Add health endpoint', author: { username: 'sara', name: 'Sara K' }, state: 'merged', created_at: recent(2), merged_at: recent(1), merge_user: { username: 'omid' }, reviewers: [{ username: 'omid' }], web_url: 'http://gl/team/app/-/merge_requests/1' },
    { iid: 2, title: 'Fix login', author: { username: 'omid', name: 'Omid R' }, state: 'opened', created_at: recent(1), merged_at: null, merge_user: null, reviewers: [], web_url: 'http://gl/team/app/-/merge_requests/2' }
  ],
  approved: [{ id: 501, action_name: 'approved', author_username: 'omid', target_type: 'MergeRequest', target_iid: 1, created_at: recent(1) }],
  commented: [
    { id: 601, action_name: 'commented on', author_username: 'omid', target_type: 'DiscussionNote', created_at: recent(1), note: { noteable_type: 'MergeRequest', noteable_iid: 1 } },
    { id: 602, action_name: 'commented on', author_username: 'sara', target_type: 'Note', created_at: recent(1), note: { noteable_type: 'Issue', noteable_iid: 9 } }
  ]
}

export type FakeGitLab = { url: string; requests: string[]; close: () => Promise<void> }

export async function startFakeGitLab(): Promise<FakeGitLab> {
  const requests: string[] = []
  let throttled = false
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    requests.push(url.pathname + url.search)
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body))
    }
    if (req.headers['private-token'] && req.headers['private-token'] !== GOOD_TOKEN) return send(401, { message: '401 Unauthorized' })
    const base = '/api/v4/projects/team%2Fapp'
    if (url.pathname === base) return send(200, { id: 42, path_with_namespace: 'team/app', name: 'app' })
    if (url.pathname === `${base}/repository/commits`) {
      // Like gitlab.com: with all=true the page number is ignored, so only the default branch is paged.
      if (url.searchParams.get('with_stats') !== 'true' || url.searchParams.has('all')) return send(400, { message: 'expected with_stats, no all' })
      if (url.searchParams.get('page') === '2') {
        if (!throttled) {
          throttled = true
          return send(429, { message: 'slow down' }, { 'Retry-After': '1' })
        }
        return send(200, fixtures.commitsPage2, { 'x-next-page': '' })
      }
      return send(200, fixtures.commitsPage1, { 'x-next-page': '2' })
    }
    if (url.pathname === `${base}/merge_requests`) return send(200, fixtures.mergeRequests, { 'x-next-page': '' })
    // A project whose API keeps returning the same page while x-next-page keeps counting.
    const loop = '/api/v4/projects/team%2Floop'
    if (url.pathname === loop) return send(200, { id: 43, path_with_namespace: 'team/loop' })
    if (url.pathname.startsWith(loop)) {
      const page = Number(url.searchParams.get('page') ?? 1)
      const body = url.pathname.endsWith('/repository/commits') ? fixtures.commitsPage1 : []
      return send(200, body, { 'x-next-page': body.length ? String(page + 1) : '' })
    }
    if (url.pathname === `${base}/events`) {
      const action = url.searchParams.get('action')
      return send(200, action === 'approved' ? fixtures.approved : action === 'commented' ? fixtures.commented : [], { 'x-next-page': '' })
    }
    send(404, { message: '404 Project Not Found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) }
}
