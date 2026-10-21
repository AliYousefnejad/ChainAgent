import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app'
import { createLoginLimiter } from '../src/login-limiter'
import { bearer, createUser, login, resetDb, setup, teardown, tokenFor, type Ctx } from './helpers'

let ctx: Ctx
before(async () => (ctx = await setup()))
after(() => teardown(ctx))
// A fresh app per test, so the per-address limiter doesn't carry failures between tests.
beforeEach(async () => {
  await resetDb(ctx.db)
  await ctx.app.close()
  ctx.app = await buildApp(ctx.db)
})

const fromIp = (app: FastifyInstance, ip: string, email: string, password: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email, password }, remoteAddress: ip })

describe('account lock after wrong passwords', () => {
  test('4 wrong passwords still say "Wrong password"; the 5th locks the account', async () => {
    await createUser(ctx.db, { email: 'a@gmail.com', password: 'password1' })
    for (let i = 1; i <= 4; i++) {
      const res = await login(ctx.app, 'a@gmail.com', 'nope-nope')
      assert.equal(res.statusCode, 401, `attempt ${i}`)
      assert.match(res.json().message, /^Wrong password/)
    }
    const fifth = await login(ctx.app, 'a@gmail.com', 'nope-nope')
    assert.equal(fifth.statusCode, 429)
    assert.match(fifth.json().message, /Try again in 15 minutes/)
  })

  test('the last tries warn how many are left', async () => {
    await createUser(ctx.db, { email: 'a@gmail.com', password: 'password1' })
    for (let i = 0; i < 3; i++) await login(ctx.app, 'a@gmail.com', 'nope-nope')
    assert.match((await login(ctx.app, 'a@gmail.com', 'nope-nope')).json().message, /1 try left/)
  })

  test('the right password is refused while locked', async () => {
    await createUser(ctx.db, { email: 'a@gmail.com', password: 'password1' })
    for (let i = 0; i < 5; i++) await login(ctx.app, 'a@gmail.com', 'nope-nope')
    const res = await login(ctx.app, 'a@gmail.com', 'password1')
    assert.equal(res.statusCode, 429)
    assert.match(res.json().message, /Too many wrong passwords/)
  })

  test('after the lock expires the right password works and the count starts again', async () => {
    await createUser(ctx.db, { email: 'a@gmail.com', password: 'password1' })
    for (let i = 0; i < 5; i++) await login(ctx.app, 'a@gmail.com', 'nope-nope')
    await ctx.db.query('UPDATE users SET locked_until = NOW() - INTERVAL 1 MINUTE')
    assert.equal((await login(ctx.app, 'a@gmail.com', 'password1')).statusCode, 200)
    const [rows] = await ctx.db.query<any[]>('SELECT failed_logins, locked_until FROM users')
    assert.equal(rows[0].failed_logins, 0)
    assert.equal(rows[0].locked_until, null)
  })

  test('a successful login resets the wrong-password count', async () => {
    await createUser(ctx.db, { email: 'a@gmail.com', password: 'password1' })
    for (let i = 0; i < 4; i++) await login(ctx.app, 'a@gmail.com', 'nope-nope')
    assert.equal((await login(ctx.app, 'a@gmail.com', 'password1')).statusCode, 200)
    assert.equal((await login(ctx.app, 'a@gmail.com', 'nope-nope')).statusCode, 401)
  })

  test('admins see the lock, and Reset password clears it', async () => {
    await createUser(ctx.db, { email: 'admin@corp.com', password: 'admin-pass', role: 'admin' })
    const adminToken = await tokenFor(ctx.app, 'admin@corp.com', 'admin-pass')
    const id = await createUser(ctx.db, { email: 'a@gmail.com', password: 'password1' })
    for (let i = 0; i < 5; i++) await login(ctx.app, 'a@gmail.com', 'nope-nope')

    const list = (await ctx.app.inject({ method: 'GET', url: '/admin/users', headers: bearer(adminToken) })).json()
    assert.ok(list.find((u: { email: string }) => u.email === 'a@gmail.com').lockedUntil)
    assert.equal(list.find((u: { email: string }) => u.email === 'admin@corp.com').lockedUntil, null)

    await ctx.app.inject({ method: 'POST', url: `/admin/users/${id}/reset-password`, headers: bearer(adminToken), payload: { tempPassword: 'temp-pass1' } })
    assert.equal((await login(ctx.app, 'a@gmail.com', 'temp-pass1')).statusCode, 200)
  })
})

describe('simultaneous attempts', () => {
  test('10 wrong passwords at once get at most 4 "Wrong password" replies, then the account is locked', async () => {
    await createUser(ctx.db, { email: 'a@gmail.com', password: 'password1' })
    const replies = await Promise.all(Array.from({ length: 10 }, () => login(ctx.app, 'a@gmail.com', 'nope-nope')))
    const codes = replies.map((r) => r.statusCode)
    assert.ok(codes.filter((c) => c === 401).length <= 4, `401s: ${codes}`)
    assert.equal(codes.filter((c) => c === 401 || c === 429).length, 10)
    assert.equal((await login(ctx.app, 'a@gmail.com', 'password1')).statusCode, 429)
  })

  test('25 failures at once from one address: at most 20 are looked at', async () => {
    const app = await buildApp(ctx.db, { limiter: createLoginLimiter() })
    const replies = await Promise.all(
      Array.from({ length: 25 }, (_, i) => fromIp(app, '10.0.0.7', `ghost${i}@gmail.com`, 'password1'))
    )
    assert.ok(replies.filter((r) => r.statusCode === 401).length <= 20)
    await app.close()
  })

  test('a valid login after failures does not use up the address allowance', async () => {
    const app = await buildApp(ctx.db, { limiter: createLoginLimiter() })
    await createUser(ctx.db, { email: 'a@gmail.com', password: 'password1' })
    for (let i = 0; i < 25; i++) assert.equal((await fromIp(app, '10.0.0.8', 'a@gmail.com', 'password1')).statusCode, 200)
    await app.close()
  })
})

describe('behind a proxy', () => {
  // nginx on 127.0.0.1 appends the real client to X-Forwarded-For; everything before it is up to the client.
  const viaProxy = (app: FastifyInstance, client: string, fake: string, email: string) =>
    app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'password1' },
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': `${fake}, ${client}` }
    })

  test('a client cannot dodge the limit by faking X-Forwarded-For', async () => {
    const app = await buildApp(ctx.db, { trustProxy: '127.0.0.1', limiter: createLoginLimiter() })
    await createUser(ctx.db, { email: 'a@gmail.com', password: 'password1' })
    for (let i = 0; i < 20; i++) await viaProxy(app, '203.0.113.5', `198.51.100.${i}`, `ghost${i}@gmail.com`)
    assert.equal((await viaProxy(app, '203.0.113.5', '198.51.100.99', 'a@gmail.com')).statusCode, 429)
    await app.close()
  })

  test("one client's failures don't block other people behind the same proxy", async () => {
    const app = await buildApp(ctx.db, { trustProxy: '127.0.0.1', limiter: createLoginLimiter() })
    await createUser(ctx.db, { email: 'a@gmail.com', password: 'password1' })
    for (let i = 0; i < 20; i++) await viaProxy(app, '203.0.113.5', '198.51.100.1', `ghost${i}@gmail.com`)
    assert.equal((await viaProxy(app, '203.0.113.6', '198.51.100.1', 'a@gmail.com')).statusCode, 200)
    await app.close()
  })
})

describe('failed attempts per network address', () => {
  test('after 20 failures from one IP, even a valid login from it is refused; other IPs are fine', async () => {
    const app = await buildApp(ctx.db, { limiter: createLoginLimiter() })
    await createUser(ctx.db, { email: 'a@gmail.com', password: 'password1' })
    for (let i = 0; i < 20; i++) await fromIp(app, '10.0.0.1', `ghost${i}@gmail.com`, 'password1')
    const blocked = await fromIp(app, '10.0.0.1', 'a@gmail.com', 'password1')
    assert.equal(blocked.statusCode, 429)
    assert.match(blocked.json().message, /from this network/)
    assert.equal((await fromIp(app, '10.0.0.2', 'a@gmail.com', 'password1')).statusCode, 200)
    await app.close()
  })

  test('the block lifts once the 15-minute window has passed', async () => {
    let now = 1_000_000
    const app = await buildApp(ctx.db, { limiter: createLoginLimiter({ now: () => now }) })
    await createUser(ctx.db, { email: 'a@gmail.com', password: 'password1' })
    for (let i = 0; i < 20; i++) await fromIp(app, '10.0.0.1', `ghost${i}@gmail.com`, 'password1')
    assert.equal((await fromIp(app, '10.0.0.1', 'a@gmail.com', 'password1')).statusCode, 429)
    now += 15 * 60_000 + 1
    assert.equal((await fromIp(app, '10.0.0.1', 'a@gmail.com', 'password1')).statusCode, 200)
    await app.close()
  })
})

describe('change your own password', () => {
  const change = (token: string, currentPassword: string, newPassword: string) =>
    ctx.app.inject({ method: 'POST', url: '/me/password', headers: bearer(token), payload: { currentPassword, newPassword } })

  test('needs a login', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/me/password', payload: { currentPassword: 'x', newPassword: 'new-pass-1' } })
    assert.equal(res.statusCode, 401)
  })

  test('is blocked while the temporary password is still set', async () => {
    await createUser(ctx.db, { email: 'a@gmail.com', password: 'temp-pass1', mustChange: true })
    const token = await tokenFor(ctx.app, 'a@gmail.com', 'temp-pass1')
    const res = await change(token, 'temp-pass1', 'new-pass-1')
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().code, 'SETUP_REQUIRED')
  })

  test('rejects a wrong current password, the same password, or a short one', async () => {
    await createUser(ctx.db, { email: 'a@gmail.com', password: 'password1' })
    const token = await tokenFor(ctx.app, 'a@gmail.com', 'password1')
    const wrong = await change(token, 'not-it-1', 'new-pass-1')
    assert.equal(wrong.statusCode, 400)
    assert.equal(wrong.json().message, 'Current password is wrong')
    assert.equal((await change(token, 'password1', 'password1')).statusCode, 400)
    assert.equal((await change(token, 'password1', 'short')).statusCode, 400)
  })

  test('changes it, signs out other sessions and keeps this one', async () => {
    await createUser(ctx.db, { email: 'a@gmail.com', password: 'password1' })
    const other = await tokenFor(ctx.app, 'a@gmail.com', 'password1')
    const current = await tokenFor(ctx.app, 'a@gmail.com', 'password1')
    assert.equal((await change(current, 'password1', 'new-pass-1')).statusCode, 204)

    assert.equal((await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(other) })).statusCode, 401)
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(current) })).statusCode, 200)
    assert.equal((await login(ctx.app, 'a@gmail.com', 'password1')).statusCode, 401)
    assert.equal((await login(ctx.app, 'a@gmail.com', 'new-pass-1')).statusCode, 200)
  })
})
