import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { buildApp } from '../src/app'
import { startFakeGitLab, GOOD_TOKEN, type FakeGitLab } from './fake-gitlab'
import { bearer, createUser, resetDb, setup, teardown, tokenFor, type Ctx } from './helpers'

let ctx: Ctx
let gitlab: FakeGitLab
before(async () => {
  ctx = await setup()
  gitlab = await startFakeGitLab()
})
after(async () => {
  await gitlab.close()
  await teardown(ctx)
})

let admin: string, manager: string, sara: string
let ids: Record<string, number>
let projectId: number
beforeEach(async () => {
  await resetDb(ctx.db)
  await ctx.app.close()
  ctx.app = await buildApp(ctx.db)
  ids = {
    admin: await createUser(ctx.db, { email: 'admin@corp.com', password: 'admin-pass', role: 'admin' }),
    manager: await createUser(ctx.db, { email: 'head@corp.com', password: 'head-pass1', role: 'manager' }),
    sara: await createUser(ctx.db, { email: 'sara@corp.com', password: 'sara-pass1', username: 'sara' }),
    omid: await createUser(ctx.db, { email: 'omid@corp.com', password: 'omid-pass1', username: 'omid' })
  }
  admin = await tokenFor(ctx.app, 'admin@corp.com', 'admin-pass')
  manager = await tokenFor(ctx.app, 'head@corp.com', 'head-pass1')
  sara = await tokenFor(ctx.app, 'sara@corp.com', 'sara-pass1')
  const host = new URL(gitlab.url).host
  projectId = (
    await req(admin, 'POST', '/projects', { name: 'App', gitlabUrl: gitlab.url, gitlabProject: 'team/app', token: GOOD_TOKEN })
  ).json().id
  void host
})

const req = (token: string, method: 'GET' | 'POST', url: string, payload?: object) =>
  ctx.app.inject({ method, url, headers: bearer(token), payload })
const today = () => new Date().toISOString().slice(0, 10)
const log = (token: string, query = '') => req(token, 'GET', `/insights/activity?from=${today()}&to=${today()}${query}`)

describe('recording activity', () => {
  test('events are stored for the signed-in user, whatever the body says', async () => {
    const res = await req(sara, 'POST', '/activity', {
      events: [
        { type: 'window_opened', agent: 'claude' },
        { type: 'turn_finished', agent: 'claude', userId: ids.omid, text: 'secret prompt' }
      ]
    })
    assert.equal(res.statusCode, 204)
    const [rows] = await ctx.db.query<any[]>("SELECT user_id, type, agent FROM activity WHERE type <> 'login' ORDER BY id")
    assert.deepEqual(rows.map((r) => [r.user_id, r.type, r.agent]), [[ids.sara, 'window_opened', 'claude'], [ids.sara, 'turn_finished', 'claude']])
  })

  test('a window in a project clone is linked to that project (https and ssh remotes)', async () => {
    const { host, hostname } = new URL(gitlab.url)
    await req(sara, 'POST', '/activity', {
      events: [
        { type: 'turn_finished', agent: 'claude', repo: `http://${host}/team/app.git` },
        { type: 'turn_finished', agent: 'codex', repo: `git@${hostname}:Team/App.git` },
        { type: 'turn_finished', agent: 'shell', repo: 'https://elsewhere.org/team/app.git' }
      ]
    })
    const [rows] = await ctx.db.query<any[]>("SELECT agent, project_id FROM activity WHERE type = 'turn_finished' ORDER BY id")
    assert.deepEqual(rows.map((r) => r.project_id), [projectId, projectId, null])
  })

  test('unknown event types, agents or oversized batches are refused', async () => {
    assert.equal((await req(sara, 'POST', '/activity', { events: [{ type: 'keystroke' }] })).statusCode, 400)
    assert.equal((await req(sara, 'POST', '/activity', { events: [{ type: 'turn_finished', agent: 'skynet' }] })).statusCode, 400)
    const many = Array.from({ length: 201 }, () => ({ type: 'turn_finished' }))
    assert.equal((await req(sara, 'POST', '/activity', { events: many })).statusCode, 400)
  })

  test('at most two "active" minutes count per batch, so a client cannot inflate active time', async () => {
    await req(sara, 'POST', '/activity', { events: Array.from({ length: 10 }, () => ({ type: 'active' })) })
    const [[row]] = await ctx.db.query<any[]>("SELECT COALESCE(SUM(count), 0) AS n FROM activity WHERE type = 'active'")
    assert.equal(Number(row.n), 2)
  })

  test('sign-in and sign-out are recorded by the server', async () => {
    await ctx.app.inject({ method: 'POST', url: '/auth/logout', headers: bearer(sara) })
    const [rows] = await ctx.db.query<any[]>('SELECT type FROM activity WHERE user_id = ? ORDER BY id', [ids.sara])
    assert.deepEqual(rows.map((r) => r.type), ['login', 'logout'])
  })
})

describe('activity log and usage', () => {
  beforeEach(async () => {
    await req(sara, 'POST', '/activity', {
      events: [
        { type: 'active' },
        { type: 'window_opened', agent: 'claude' },
        { type: 'prompt', agent: 'claude', detail: 'team' },
        { type: 'turn_finished', agent: 'claude' },
        { type: 'turn_finished', agent: 'claude' },
        { type: 'handoff', agent: 'claude', detail: 'shell' }
      ]
    })
    const omid = await tokenFor(ctx.app, 'omid@corp.com', 'omid-pass1')
    await req(omid, 'POST', '/activity', { events: [{ type: 'turn_finished', agent: 'opencode' }] })
  })

  test('managers see everyone’s log, newest first, with filters', async () => {
    const all = (await log(manager)).json()
    assert.ok(all.length >= 9)
    assert.ok(all.every((e: any, i: number) => i === 0 || all[i - 1].at >= e.at))
    const turns = (await log(manager, `&type=turn_finished&user=${ids.sara}`)).json()
    assert.equal(turns.length, 2)
    assert.equal(turns[0].name, 'sara')
    assert.equal(turns[0].agent, 'claude')
  })

  test('active minutes stay out of the log unless asked for', async () => {
    assert.ok((await log(manager)).json().every((e: any) => e.type !== 'active'))
    assert.equal((await log(manager, '&type=active')).json().length, 1)
  })

  test('a member sees only their own log', async () => {
    const mine = (await log(sara, `&user=${ids.omid}`)).json()
    assert.ok(mine.length > 0)
    assert.ok(mine.every((e: any) => e.userId === ids.sara))
  })

  test('people stats include usage counts', async () => {
    const people = (await req(manager, 'GET', `/insights/people?from=${today()}&to=${today()}`)).json()
    const s = people.find((p: any) => p.userId === ids.sara)
    assert.deepEqual(
      [s.activeMinutes, s.windows, s.prompts, s.turns, s.handoffs],
      [1, 1, 1, 2, 1]
    )
    assert.equal(people.find((p: any) => p.userId === ids.omid).turns, 1)
  })
})
