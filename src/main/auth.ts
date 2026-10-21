import { app, net, safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const API_URL = process.env.CHAINAGENT_API_URL ?? 'http://localhost:3100'

export type ApiResult = { ok: boolean; status: number; data: any }

let token: string | null = null
const sessionFile = () => join(app.getPath('userData'), 'session.bin')

export function loadToken(): void {
  try {
    if (safeStorage.isEncryptionAvailable() && existsSync(sessionFile())) {
      token = safeStorage.decryptString(readFileSync(sessionFile()))
    }
  } catch {
    token = null
  }
}

function setToken(value: string | null): void {
  token = value
  if (value && safeStorage.isEncryptionAvailable()) writeFileSync(sessionFile(), safeStorage.encryptString(value))
  else rmSync(sessionFile(), { force: true })
}

export async function request(method: string, path: string, body?: unknown): Promise<ApiResult> {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const res = await net.fetch(API_URL + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { message: text }
    }
    if (res.status === 401 && token) setToken(null)
    return { ok: res.ok, status: res.status, data }
  } catch {
    return { ok: false, status: 0, data: { message: 'Cannot reach the server' } }
  }
}

export async function login(email: string, password: string): Promise<ApiResult> {
  const res = await request('POST', '/auth/login', { email, password })
  if (!res.ok) return res
  setToken(res.data.token)
  return { ok: true, status: res.status, data: res.data.user }
}

export async function logout(): Promise<void> {
  if (token) await request('POST', '/auth/logout')
  setToken(null)
}
