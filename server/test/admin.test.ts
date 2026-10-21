import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { bearer, createUser, login, resetDb, setup, teardown, tokenFor, type Ctx } from './helpers'

let ctx: Ctx
let adminId: number
let adminToken: string

before(async () => (ctx = await setup()))
after(() => teardown(ctx))
beforeEach(async () => {
  await resetDb(ctx.db)
  adminId = await createUser(ctx.db, { email: 'admin@corp.com', password: 'admin-pass', role: 'admin' })
  adminToken = await tokenFor(ctx.app, 'admin@corp.com', 'admin-pass')
})

const asAdmin = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  ctx.app.inject({ method, url, headers: bearer(adminToken), payload })

describe('admin routes', () => {
  test('non-admin gets 403 on every admin route', async () => {
    const id = await createUser(ctx.db, { email: 'u@corp.com', password: 'password1' })
    const token = await tokenFor(ctx.app, 'u@corp.com', 'password1')
    const calls = [
      { method: 'GET' as const, url: '/admin/users' },
      { method: 'POST' as const, url: '/admin/users', payload: { email: 'n@corp.com', tempPassword: 'temp-pass1' } },
      { method: 'PATCH' as const, url: `/admin/users/${id}/status`, payload: { active: false } },
      { method: 'POST' as const, url: `/admin/users/${id}/reset-password`, payload: { tempPassword: 'temp-pass1' } }
    ]
    for (const c of calls) {
      const res = await ctx.app.inject({ ...c, headers: bearer(token) })
      assert.equal(res.statusCode, 403, `${c.method} ${c.url}`)
    }
  })

  test('creates a user who must complete setup on first login', async () => {
    const res = await asAdmin('POST', '/admin/users', { email: 'Employee@Gmail.com', tempPassword: 'temp-pass1' })
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().email, 'employee@gmail.com')
    assert.equal(res.json().pendingSetup, true)

    const first = await login(ctx.app, 'employee@gmail.com', 'temp-pass1')
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().user.mustChangePassword, true)
    assert.equal(first.json().user.role, 'user')
  })

  test('duplicate email returns 409', async () => {
    await asAdmin('POST', '/admin/users', { email: 'e@gmail.com', tempPassword: 'temp-pass1' })
    const res = await asAdmin('POST', '/admin/users', { email: 'E@gmail.com', tempPassword: 'temp-pass2' })
    assert.equal(res.statusCode, 409)
  })

  test('invalid email or short temp password returns 400', async () => {
    assert.equal((await asAdmin('POST', '/admin/users', { email: 'not-an-email', tempPassword: 'temp-pass1' })).statusCode, 400)
    assert.equal((await asAdmin('POST', '/admin/users', { email: 'e@gmail.com', tempPassword: 'short' })).statusCode, 400)
  })

  test('user list has no password hashes', async () => {
    await createUser(ctx.db, { email: 'u@corp.com', password: 'password1', mustChange: true })
    const res = await asAdmin('GET', '/admin/users')
    assert.equal(res.statusCode, 200)
    const users = res.json()
    assert.equal(users.length, 2)
    for (const u of users) {
      assert.deepEqual(Object.keys(u).sort(), ['active', 'createdAt', 'email', 'gitEmails', 'gitlabUsername', 'id', 'lockedUntil', 'pendingSetup', 'role', 'username'])
    }
    assert.equal(users.find((u: { email: string }) => u.email === 'u@corp.com').pendingSetup, true)
  })

  test('disabling revokes live sessions and blocks login; enabling restores it', async () => {
    const id = await createUser(ctx.db, { email: 'u@corp.com', password: 'password1' })
    const token = await tokenFor(ctx.app, 'u@corp.com', 'password1')

    assert.equal((await asAdmin('PATCH', `/admin/users/${id}/status`, { active: false })).statusCode, 200)
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(token) })).statusCode, 401)
    assert.equal((await login(ctx.app, 'u@corp.com', 'password1')).statusCode, 403)

    assert.equal((await asAdmin('PATCH', `/admin/users/${id}/status`, { active: true })).statusCode, 200)
    assert.equal((await login(ctx.app, 'u@corp.com', 'password1')).statusCode, 200)
  })

  test('admin cannot disable themselves', async () => {
    const res = await asAdmin('PATCH', `/admin/users/${adminId}/status`, { active: false })
    assert.equal(res.statusCode, 400)
  })

  test('reset password forces setup again and revokes sessions', async () => {
    const id = await createUser(ctx.db, { email: 'u@corp.com', password: 'password1', username: 'u' })
    const token = await tokenFor(ctx.app, 'u@corp.com', 'password1')

    const res = await asAdmin('POST', `/admin/users/${id}/reset-password`, { tempPassword: 'temp-pass9' })
    assert.equal(res.statusCode, 204)
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(token) })).statusCode, 401)
    assert.equal((await login(ctx.app, 'u@corp.com', 'password1')).statusCode, 401)
    const again = await login(ctx.app, 'u@corp.com', 'temp-pass9')
    assert.equal(again.statusCode, 200)
    assert.equal(again.json().user.mustChangePassword, true)
  })

  test('unknown user id returns 404', async () => {
    assert.equal((await asAdmin('PATCH', '/admin/users/999999/status', { active: false })).statusCode, 404)
    assert.equal((await asAdmin('POST', '/admin/users/999999/reset-password', { tempPassword: 'temp-pass1' })).statusCode, 404)
  })
})
