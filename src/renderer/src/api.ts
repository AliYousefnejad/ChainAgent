type ApiResult = { ok: boolean; status: number; data: any }

export type PlanWindow = { id: string; agent: string; name: string; cwd: string }
export type PlanStep = { id: string; agent: string; title: string; prompt: string; dependsOn: string[] }
export type PlanResult = { steps: PlanStep[] } | { error: string }

export type AgentType = 'claude' | 'codex' | 'gemini' | 'opencode' | 'shell'
export type TeamAgent = { key: string; type: AgentType; role: string; instructions: string; useSubagents: boolean }
export type TeamWire = { from: string; to: string; autoRun: boolean }
export type Team = { agents: TeamAgent[]; wires: TeamWire[]; firstAgent: string; firstPrompt: string }
export type TeamResult = Team | { error: string }

declare global {
  interface Window {
    api: {
      login(email: string, password: string): Promise<ApiResult>
      logout(): Promise<void>
      request(method: string, path: string, body?: unknown): Promise<ApiResult>
      pickFolder(): Promise<string | null>
      openExternal(url: string): void
      createPlan(task: string, windows: PlanWindow[], wires: { source: string; target: string }[], cwd: string): Promise<PlanResult>
      transcribe(samples: Float32Array, language: string): Promise<{ text?: string; error?: string }>
      onSttProgress(cb: (percent: number) => void): () => void
      onFullScreen(cb: (on: boolean) => void): () => void
      createTeam(task: string, allowed: AgentType[], cwd: string): Promise<TeamResult>
      isClaudeTrusted(folder: string): Promise<boolean>
      toggleFullScreen(): void
    }
    pty: {
      spawn(id: string, agentId: string, cwd: string, cols: number, rows: number, role?: string): Promise<string | null>
      ready(id: string): Promise<boolean>
      onReady(cb: (id: string) => void): () => void
      write(id: string, data: string): void
      resize(id: string, cols: number, rows: number): void
      kill(id: string): void
      onData(cb: (id: string, data: string) => void): () => void
      onExit(cb: (id: string, code: number) => void): () => void
      deliver(id: string, text: string, submit: boolean): Promise<'sent' | 'shell busy' | 'needs zsh' | 'closed'>
      onFinished(cb: (id: string, text: string) => void): () => void
    }
  }
}

// 'user' is a member: the server keeps that value, the UI calls it "Member".
export type Role = 'admin' | 'manager' | 'user'
export type User = { id: number; email: string; username: string | null; role: Role; mustChangePassword: boolean }
export type AdminUser = {
  id: number
  email: string
  username: string | null
  role: Role
  active: boolean
  pendingSetup: boolean
  lockedUntil: string | null
  createdAt: string
  gitlabUsername: string | null
  gitEmails: string[]
}

export type Project = {
  id: number
  name: string
  gitlabUrl: string
  gitlabProject: string
  hasToken: boolean
  lastSyncedAt: string | null
  syncError: string | null
}
export type SyncResult = { commits: number; mergeRequests: number; events: number }
type ActivityCounts = {
  commits: number
  additions: number
  deletions: number
  mrsOpened: number
  mrsMerged: number
  approvals: number
  comments: number
}
export type PersonStats = ActivityCounts & { userId: number; name: string; email: string }
export type UnmatchedAuthor = { authorName: string; authorEmail: string; commits: number }
export type ProjectStats = ActivityCounts & {
  projectId: number
  name: string
  contributors: number
  lastSyncedAt: string | null
  syncError: string | null
}
export type MergeRequestRow = {
  projectId: number
  projectName: string
  iid: number
  title: string
  authorName: string
  state: 'opened' | 'merged' | 'closed' | 'locked'
  createdAt: string
  mergedAt: string | null
  mergedBy: string | null
  reviewers: string[]
  webUrl: string
}
// from/to are YYYY-MM-DD, both inclusive.
export type InsightsFilter = { from: string; to: string; project?: number; author?: number }

let unauthorized: () => void = () => {}
export const onUnauthorized = (cb: () => void) => {
  unauthorized = cb
}

function unwrap<T>(res: ApiResult): T {
  if (!res.ok) throw new Error(res.data?.message ?? `Request failed (${res.status})`)
  return res.data as T
}

function withQuery(path: string, filter: InsightsFilter) {
  const params = new URLSearchParams({ from: filter.from, to: filter.to })
  if (filter.project) params.set('project', String(filter.project))
  if (filter.author) params.set('author', String(filter.author))
  return `${path}?${params}`
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await window.api.request(method, path, body)
  if (res.status === 401) unauthorized()
  return unwrap<T>(res)
}

export const api = {
  login: async (email: string, password: string) => unwrap<User>(await window.api.login(email, password)),
  logout: () => window.api.logout(),
  me: () => call<User>('GET', '/me'),
  completeSetup: (username: string, newPassword: string) =>
    call<User>('POST', '/me/complete-setup', { username, newPassword }),
  listUsers: () => call<AdminUser[]>('GET', '/admin/users'),
  createUser: (email: string, tempPassword: string) => call<AdminUser>('POST', '/admin/users', { email, tempPassword }),
  setActive: (id: number, active: boolean) => call<AdminUser>('PATCH', `/admin/users/${id}/status`, { active }),
  changePassword: (currentPassword: string, newPassword: string) =>
    call<void>('POST', '/me/password', { currentPassword, newPassword }),
  resetPassword: (id: number, tempPassword: string) =>
    call<void>('POST', `/admin/users/${id}/reset-password`, { tempPassword }),
  setRole: (id: number, role: Role) => call<AdminUser>('PATCH', `/admin/users/${id}/role`, { role }),
  setIdentity: (id: number, gitlabUsername: string | null, gitEmails: string[]) =>
    call<AdminUser>('PATCH', `/admin/users/${id}/identity`, { gitlabUsername, gitEmails }),
  listProjects: () => call<Project[]>('GET', '/projects'),
  createProject: (project: { name: string; gitlabUrl: string; gitlabProject: string; token?: string }) =>
    call<Project>('POST', '/projects', project),
  updateProject: (id: number, changes: { name?: string; token?: string }) =>
    call<Project>('PATCH', `/projects/${id}`, changes),
  deleteProject: (id: number) => call<void>('DELETE', `/projects/${id}`),
  syncProject: (id: number) => call<SyncResult>('POST', `/projects/${id}/sync`),
  insightsPeople: (filter: InsightsFilter) => call<PersonStats[]>('GET', withQuery('/insights/people', filter)),
  insightsUnmatched: (filter: InsightsFilter) =>
    call<UnmatchedAuthor[]>('GET', withQuery('/insights/unmatched', filter)),
  insightsProjects: (filter: InsightsFilter) => call<ProjectStats[]>('GET', withQuery('/insights/projects', filter)),
  insightsMergeRequests: (filter: InsightsFilter) =>
    call<MergeRequestRow[]>('GET', withQuery('/insights/merge-requests', filter))
}
