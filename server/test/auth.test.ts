import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { bearer, createUser, login, resetDb, setup, teardown, tokenFor, type Ctx } from './helpers'

let ctx: Ctx
before(async () => (ctx = await setup()))
after(() => teardown(ctx))
beforeEach(() => resetDb(ctx.db))

describe('login', () => {
  test('succeeds with correct credentials', async () => {
    await createUser(ctx.db, { email: 'a@corp.com', password: 'password1' })
    const res = await login(ctx.app, 'A@Corp.com', 'password1')
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(typeof body.token, 'string')
    assert.equal(body.user.email, 'a@corp.com')
    assert.equal(body.user.mustChangePassword, false)
    assert.equal(body.user.password_hash, undefined)
  })

  test('wrong password and unknown email return the same 401', async () => {
    await createUser(ctx.db, { email: 'a@corp.com', password: 'password1' })
    const wrong = await login(ctx.app, 'a@corp.com', 'nope-nope')
    const unknown = await login(ctx.app, 'ghost@corp.com', 'password1')
    assert.equal(wrong.statusCode, 401)
    assert.equal(unknown.statusCode, 401)
    assert.deepEqual(wrong.json(), unknown.json())
  })

  test('disabled user cannot log in', async () => {
    await createUser(ctx.db, { email: 'a@corp.com', password: 'password1', active: false })
    const res = await login(ctx.app, 'a@corp.com', 'password1')
    assert.equal(res.statusCode, 403)
  })

  test('missing token is rejected', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/me' })
    assert.equal(res.statusCode, 401)
  })

  test('logout invalidates the token', async () => {
    await createUser(ctx.db, { email: 'a@corp.com', password: 'password1' })
    const token = await tokenFor(ctx.app, 'a@corp.com', 'password1')
    const out = await ctx.app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(token) })
    assert.equal(out.statusCode, 204)
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(token) })
    assert.equal(me.statusCode, 401)
  })

  test('expired session is rejected', async () => {
    await createUser(ctx.db, { email: 'a@corp.com', password: 'password1' })
    const token = await tokenFor(ctx.app, 'a@corp.com', 'password1')
    await ctx.db.query('UPDATE sessions SET expires_at = NOW() - INTERVAL 1 MINUTE')
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(token) })
    assert.equal(me.statusCode, 401)
  })
})

describe('first login setup', () => {
  const setupCall = (token: string, username: string, newPassword: string) =>
    ctx.app.inject({ method: 'POST', url: '/me/complete-setup', headers: bearer(token), payload: { username, newPassword } })

  test('user with a temp password is blocked from other routes until setup is done', async () => {
    // An admin with a temp password proves the block comes from setup, not from role.
    await createUser(ctx.db, { email: 'boss@corp.com', password: 'temp-pass1', role: 'admin', mustChange: true })
    const token = await tokenFor(ctx.app, 'boss@corp.com', 'temp-pass1')
    const res = await ctx.app.inject({ method: 'GET', url: '/admin/users', headers: bearer(token) })
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().code, 'SETUP_REQUIRED')
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(token) })
    assert.equal(me.statusCode, 200)
    assert.equal(me.json().mustChangePassword, true)
  })

  test('sets username and new password; temp password stops working', async () => {
    await createUser(ctx.db, { email: 'e@gmail.com', password: 'temp-pass1', mustChange: true })
    const token = await tokenFor(ctx.app, 'e@gmail.com', 'temp-pass1')
    const res = await setupCall(token, 'Sara.K', 'my-new-pass')
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().username, 'sara.k')
    assert.equal(res.json().mustChangePassword, false)

    assert.equal((await login(ctx.app, 'e@gmail.com', 'temp-pass1')).statusCode, 401)
    const again = await login(ctx.app, 'e@gmail.com', 'my-new-pass')
    assert.equal(again.statusCode, 200)
    assert.equal(again.json().user.username, 'sara.k')
  })

  test('rejects reusing the temp password', async () => {
    await createUser(ctx.db, { email: 'e@gmail.com', password: 'temp-pass1', mustChange: true })
    const token = await tokenFor(ctx.app, 'e@gmail.com', 'temp-pass1')
    assert.equal((await setupCall(token, 'sara', 'temp-pass1')).statusCode, 400)
  })

  test('rejects a short password or invalid username', async () => {
    await createUser(ctx.db, { email: 'e@gmail.com', password: 'temp-pass1', mustChange: true })
    const token = await tokenFor(ctx.app, 'e@gmail.com', 'temp-pass1')
    assert.equal((await setupCall(token, 'sara', 'short')).statusCode, 400)
    assert.equal((await setupCall(token, 'a b', 'my-new-pass')).statusCode, 400)
  })

  test('rejects a taken username', async () => {
    await createUser(ctx.db, { email: 'x@corp.com', password: 'password1', username: 'sara' })
    await createUser(ctx.db, { email: 'e@gmail.com', password: 'temp-pass1', mustChange: true })
    const token = await tokenFor(ctx.app, 'e@gmail.com', 'temp-pass1')
    assert.equal((await setupCall(token, 'Sara', 'my-new-pass')).statusCode, 409)
  })

  test('is refused once setup is already done', async () => {
    await createUser(ctx.db, { email: 'e@gmail.com', password: 'password1' })
    const token = await tokenFor(ctx.app, 'e@gmail.com', 'password1')
    assert.equal((await setupCall(token, 'sara', 'my-new-pass')).statusCode, 400)
  })
})
