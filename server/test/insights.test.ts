import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { buildApp } from '../src/app'
import { decrypt } from '../src/secret'
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

let admin: string, manager: string, member: string
let ids: Record<string, number>
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
  member = await tokenFor(ctx.app, 'sara@corp.com', 'sara-pass1')
})

const req = (token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  ctx.app.inject({ method, url, headers: bearer(token), payload })
const addProject = (token: string, extra: object = {}) =>
  req(token, 'POST', '/projects', { name: 'App', gitlabUrl: gitlab.url, gitlabProject: 'team/app', token: GOOD_TOKEN, ...extra })

describe('roles', () => {
  test('a manager can list users and manage members, but not admins or other managers', async () => {
    assert.equal((await req(manager, 'GET', '/admin/users')).statusCode, 200)
    assert.equal((await req(manager, 'PATCH', `/admin/users/${ids.sara}/status`, { active: false })).statusCode, 200)
    assert.equal((await req(manager, 'PATCH', `/admin/users/${ids.admin}/status`, { active: false })).statusCode, 403)
    assert.equal((await req(manager, 'POST', `/admin/users/${ids.admin}/reset-password`, { tempPassword: 'temp-pass1' })).statusCode, 403)
    const other = await createUser(ctx.db, { email: 'head2@corp.com', password: 'head-pass2', role: 'manager' })
    assert.equal((await req(manager, 'PATCH', `/admin/users/${other}/status`, { active: false })).statusCode, 403)
  })

  test('only an admin changes roles, and not their own', async () => {
    assert.equal((await req(manager, 'PATCH', `/admin/users/${ids.sara}/role`, { role: 'manager' })).statusCode, 403)
    const res = await req(admin, 'PATCH', `/admin/users/${ids.sara}/role`, { role: 'manager' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().role, 'manager')
    assert.equal((await req(admin, 'PATCH', `/admin/users/${ids.admin}/role`, { role: 'user' })).statusCode, 400)
    assert.equal((await req(admin, 'PATCH', `/admin/users/${ids.sara}/role`, { role: 'king' })).statusCode, 400)
  })

  test('members get 403 on user management and projects', async () => {
    for (const [method, url] of [['GET', '/admin/users'], ['GET', '/projects'], ['GET', '/insights/projects'], ['GET', '/insights/unmatched']] as const) {
      assert.equal((await req(member, method, url)).statusCode, 403, url)
    }
  })

  test('admins and managers set GitLab identity; emails are stored lowercase', async () => {
    const res = await req(manager, 'PATCH', `/admin/users/${ids.sara}/identity`, { gitlabUsername: 'sara', gitEmails: ['SARA.home@gmail.com'] })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().gitlabUsername, 'sara')
    assert.deepEqual(res.json().gitEmails, ['sara.home@gmail.com'])
    const onAdmin = await req(manager, 'PATCH', `/admin/users/${ids.admin}/identity`, { gitlabUsername: 'x', gitEmails: [] })
    assert.equal(onAdmin.statusCode, 403)
  })
})

describe('projects', () => {
  test('adding checks the project with GitLab; the token is never returned and is encrypted at rest', async () => {
    const res = await addProject(manager)
    assert.equal(res.statusCode, 201)
    const project = res.json()
    assert.equal(project.hasToken, true)
    assert.equal(JSON.stringify(project).includes(GOOD_TOKEN), false)
    const [rows] = await ctx.db.query<any[]>('SELECT token_enc FROM projects')
    assert.notEqual(rows[0].token_enc, GOOD_TOKEN)
    assert.equal(decrypt(rows[0].token_enc), GOOD_TOKEN)
    const list = (await req(manager, 'GET', '/projects')).json()
    assert.equal(JSON.stringify(list).includes(GOOD_TOKEN), false)
  })

  test('a wrong token or project is refused with GitLab’s reason', async () => {
    const bad = await addProject(admin, { token: 'nope' })
    assert.equal(bad.statusCode, 400)
    assert.match(bad.json().message, /401/)
    assert.equal((await addProject(admin, { gitlabProject: 'team/missing' })).statusCode, 400)
  })

  test('rename, replace token, and remove', async () => {
    const id = (await addProject(admin)).json().id
    assert.equal((await req(admin, 'PATCH', `/projects/${id}`, { name: 'Renamed' })).json().name, 'Renamed')
    assert.equal((await req(admin, 'PATCH', `/projects/${id}`, { token: '' })).json().hasToken, false)
    assert.equal((await req(admin, 'DELETE', `/projects/${id}`)).statusCode, 204)
    assert.deepEqual((await req(admin, 'GET', '/projects')).json(), [])
  })
})

describe('sync', () => {
  test('pulls commits (skipping merge commits, waiting out a 429), MRs and MR events; re-sync adds no duplicates', async () => {
    const id = (await addProject(admin)).json().id
    const first = await req(admin, 'POST', `/projects/${id}/sync`)
    assert.equal(first.statusCode, 200)
    assert.deepEqual(first.json(), { commits: 4, mergeRequests: 2, events: 2 })
    await req(admin, 'POST', `/projects/${id}/sync`)
    const [[c], [m], [e]] = await Promise.all(
      ['commits', 'merge_requests', 'mr_events'].map((t) => ctx.db.query<any[]>(`SELECT COUNT(*) AS n FROM ${t}`).then(([r]) => r))
    )
    assert.deepEqual([c.n, m.n, e.n], [4, 2, 2])
    const project = (await req(admin, 'GET', '/projects')).json()[0]
    assert.ok(project.lastSyncedAt)
    assert.equal(project.syncError, null)
  })

  test('a GitLab that repeats the same page forever does not loop; counts are distinct commits', async () => {
    const id = (await addProject(admin, { gitlabProject: 'team/loop' })).json().id
    const started = Date.now()
    const res = await req(admin, 'POST', `/projects/${id}/sync`)
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().commits, 2)
    assert.ok(Date.now() - started < 5000)
    assert.ok(gitlab.requests.filter((r) => r.startsWith('/api/v4/projects/team%2Floop/repository/commits')).length <= 3)
  })

  test('a failing sync is reported and stored on the project', async () => {
    const id = (await addProject(admin)).json().id
    await ctx.db.query('UPDATE projects SET gitlab_project = ?', ['team/missing'])
    const res = await req(admin, 'POST', `/projects/${id}/sync`)
    assert.equal(res.statusCode, 502)
    assert.match((await req(admin, 'GET', '/projects')).json()[0].syncError, /404/)
  })
})

describe('insights', () => {
  const range = (days: number) => {
    const to = new Date().toISOString().slice(0, 10)
    const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    return `from=${from}&to=${to}`
  }

  beforeEach(async () => {
    const id = (await addProject(admin)).json().id
    await req(admin, 'POST', `/projects/${id}/sync`)
    await req(admin, 'PATCH', `/admin/users/${ids.sara}/identity`, { gitlabUsername: 'sara', gitEmails: ['sara.home@gmail.com'] })
    await req(admin, 'PATCH', `/admin/users/${ids.omid}/identity`, { gitlabUsername: 'omid', gitEmails: [] })
  })

  test('per person: commits by any of their emails, lines, MRs, approvals and MR comments', async () => {
    const people = (await req(manager, 'GET', `/insights/people?${range(7)}`)).json()
    const sara = people.find((p: any) => p.userId === ids.sara)
    const omid = people.find((p: any) => p.userId === ids.omid)
    assert.deepEqual(
      [sara.commits, sara.additions, sara.deletions, sara.mrsOpened, sara.mrsMerged, sara.approvals, sara.comments],
      [2, 15, 7, 1, 1, 0, 0]
    )
    // Omid's only commit is 20 days old, outside this 7-day range; his issue-free MR comment counts.
    assert.deepEqual([omid.commits, omid.mrsOpened, omid.approvals, omid.comments], [0, 1, 1, 1])
  })

  test('commit authors that match nobody are listed', async () => {
    const unmatched = (await req(manager, 'GET', `/insights/unmatched?${range(30)}`)).json()
    assert.deepEqual(unmatched, [{ authorName: 'Stranger', authorEmail: 'who@else.org', commits: 1 }])
  })

  test('a member only sees themselves', async () => {
    const people = (await req(member, 'GET', `/insights/people?${range(30)}`)).json()
    assert.deepEqual(people.map((p: any) => p.userId), [ids.sara])
    const mrs = (await req(member, 'GET', `/insights/merge-requests?${range(30)}`)).json()
    assert.deepEqual(mrs.map((m: any) => m.iid), [1])
  })

  test('project totals and the merge request list', async () => {
    const [project] = (await req(manager, 'GET', `/insights/projects?${range(30)}`)).json()
    assert.deepEqual(
      [project.commits, project.additions, project.mrsOpened, project.mrsMerged, project.approvals, project.comments, project.contributors],
      [4, 25, 2, 1, 1, 1, 3]
    )
    const mrs = (await req(manager, 'GET', `/insights/merge-requests?${range(30)}`)).json()
    const merged = mrs.find((m: any) => m.iid === 1)
    assert.equal(merged.authorName, 'sara')
    assert.equal(merged.mergedBy, 'omid')
    assert.deepEqual(merged.reviewers, ['omid'])
    assert.equal(merged.projectName, 'App')
    // Times come back as the same instant GitLab reported, whatever the server's time zone.
    const sent = (await import('./fake-gitlab')).fixtures.mergeRequests[0].created_at
    assert.equal(new Date(merged.createdAt).toISOString().slice(0, 19), sent.slice(0, 19))
    const synced = (await req(manager, 'GET', '/projects')).json()[0]
    assert.ok(Math.abs(Date.now() - new Date(synced.lastSyncedAt).getTime()) < 120_000, 'lastSyncedAt is "just now"')
  })

  test('bad ranges are rejected', async () => {
    assert.equal((await req(manager, 'GET', '/insights/people?from=yesterday&to=today')).statusCode, 400)
  })
})
