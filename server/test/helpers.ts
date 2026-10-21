import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app'
import { createDb, type Db } from '../src/db'
import { migrate } from '../src/migrate'
import { hashPassword } from '../src/password'

export type Ctx = { db: Db; app: FastifyInstance }

export async function setup(): Promise<Ctx> {
  // Tests wipe tables, so they only run against a database named *_test.
  process.env.DB_NAME = process.env.TEST_DB_NAME
  if (!process.env.DB_NAME?.endsWith('_test')) throw new Error('Set TEST_DB_NAME to a database ending in _test')
  const db = createDb()
  await migrate(db)
  const app = await buildApp(db)
  return { db, app }
}

export async function teardown({ db, app }: Ctx): Promise<void> {
  await app.close()
  await db.end()
}

export async function resetDb(db: Db): Promise<void> {
  await db.query('DELETE FROM sessions')
  await db.query('DELETE FROM users')
}

type NewUser = { email: string; password: string; role?: 'admin' | 'user'; mustChange?: boolean; active?: boolean; username?: string }

export async function createUser(db: Db, u: NewUser): Promise<number> {
  const [result] = await db.query<import('mysql2').ResultSetHeader>(
    'INSERT INTO users (email, username, password_hash, role, must_change_password, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    [u.email, u.username ?? null, await hashPassword(u.password), u.role ?? 'user', u.mustChange ? 1 : 0, u.active === false ? 0 : 1]
  )
  return result.insertId
}

export function login(app: FastifyInstance, email: string, password: string) {
  return app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } })
}

export async function tokenFor(app: FastifyInstance, email: string, password: string): Promise<string> {
  const res = await login(app, email, password)
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`)
  return res.json().token
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
