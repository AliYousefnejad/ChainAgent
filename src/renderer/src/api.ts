type ApiResult = { ok: boolean; status: number; data: any }

export type PlanWindow = { id: string; agent: string; name: string; cwd: string }
export type PlanStep = { id: string; agent: string; title: string; prompt: string; dependsOn: string[] }
export type PlanResult = { steps: PlanStep[] } | { error: string }

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
      toggleFullScreen(): void
    }
    pty: {
      spawn(id: string, agentId: string, cwd: string, cols: number, rows: number): Promise<string | null>
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

export type Role = 'admin' | 'user'
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
}

let unauthorized: () => void = () => {}
export const onUnauthorized = (cb: () => void) => {
  unauthorized = cb
}

function unwrap<T>(res: ApiResult): T {
  if (!res.ok) throw new Error(res.data?.message ?? `Request failed (${res.status})`)
  return res.data as T
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
    call<void>('POST', `/admin/users/${id}/reset-password`, { tempPassword })
}
