import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  api,
  type AdminUser,
  type InsightsFilter,
  type MergeRequestRow,
  type PersonStats,
  type Project,
  type ProjectStats,
  type UnmatchedAuthor,
  type User
} from './api'

type Props = { currentUser: User; onClose: () => void }
type Tab = 'people' | 'projects' | 'mrs'

const PRESETS = [7, 30, 90]
const EMPTY = 'No data for this range — sync a project first'

const pad = (n: number) => String(n).padStart(2, '0')
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
// "Last N days" includes today, so it starts N-1 days back.
function lastDays(days: number) {
  const from = new Date()
  from.setDate(from.getDate() - (days - 1))
  return { from: isoDay(from), to: isoDay(new Date()) }
}
const fmt = (n: number) => n.toLocaleString()
const fmtDate = (s: string) => new Date(s).toLocaleDateString()
const fmtTime = (s: string) => new Date(s).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

type SortKey = 'name' | 'commits' | 'lines' | 'mrsOpened' | 'mrsMerged' | 'approvals' | 'comments'
const COLUMNS: { key: Exclude<SortKey, 'name'>; label: string; value: (p: PersonStats) => number }[] = [
  { key: 'commits', label: 'Commits', value: (p) => p.commits },
  { key: 'lines', label: 'Lines', value: (p) => p.additions + p.deletions },
  { key: 'mrsOpened', label: 'MRs opened', value: (p) => p.mrsOpened },
  { key: 'mrsMerged', label: 'MRs merged', value: (p) => p.mrsMerged },
  { key: 'approvals', label: 'Approvals', value: (p) => p.approvals },
  { key: 'comments', label: 'Comments', value: (p) => p.comments }
]

// A number with a slim bar scaled to the column's largest value, so the table reads as a chart.
function BarCell({ value, max, tip, children }: { value: number; max: number; tip: string; children: ReactNode }) {
  return (
    <td className="bar-cell" title={tip}>
      <span className="bar-value">{children}</span>
      <span className="bar-track">
        {value > 0 && <span className="bar-fill" style={{ width: `${(value / max) * 100}%` }} />}
      </span>
    </td>
  )
}

export default function Insights({ currentUser, onClose }: Props) {
  const isStaff = currentUser.role !== 'user'
  const [preset, setPreset] = useState<number | null>(30)
  const [range, setRange] = useState(() => lastDays(30))
  const [projectId, setProjectId] = useState(0)
  const [tab, setTab] = useState<Tab>('people')
  const [projects, setProjects] = useState<Project[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [people, setPeople] = useState<PersonStats[]>([])
  const [unmatched, setUnmatched] = useState<UnmatchedAuthor[]>([])
  const [projectStats, setProjectStats] = useState<ProjectStats[]>([])
  const [mrs, setMrs] = useState<MergeRequestRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'commits', desc: true })
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [syncing, setSyncing] = useState<number[]>([])
  const [syncNotes, setSyncNotes] = useState<Record<number, { text: string; failed: boolean }>>({})
  const [editId, setEditId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editToken, setEditToken] = useState('')
  const [draft, setDraft] = useState({ name: '', gitlabUrl: '', gitlabProject: '', token: '' })

  const badRange = range.from > range.to
  const refresh = () => setReload((n) => n + 1)

  useEffect(() => {
    if (!isStaff) return
    api.listProjects().then(setProjects, (err: Error) => setError(err.message))
    api.listUsers().then(setUsers, (err: Error) => setError(err.message))
  }, [isStaff, reload])

  useEffect(() => {
    if (badRange) return
    let stale = false
    const filter: InsightsFilter = { ...range, project: projectId || undefined }
    const load =
      tab === 'people'
        ? Promise.all([
            api.insightsPeople(filter).then((rows) => !stale && setPeople(rows)),
            isStaff && api.insightsUnmatched(filter).then((rows) => !stale && setUnmatched(rows))
          ])
        : tab === 'projects'
          ? api.insightsProjects(filter).then((rows) => !stale && setProjectStats(rows))
          : api.insightsMergeRequests(filter).then((rows) => !stale && setMrs(rows))
    setLoading(true)
    setError('')
    load
      .catch((err: Error) => !stale && setError(err.message))
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [tab, range, projectId, badRange, isStaff, reload])

  const pickPreset = (days: number) => {
    setPreset(days)
    setRange(lastDays(days))
  }
  const pickDate = (field: 'from' | 'to', value: string) => {
    if (!value) return
    setPreset(null)
    setRange((r) => ({ ...r, [field]: value }))
  }

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await action()
      return true
    } catch (err) {
      setError((err as Error).message)
      return false
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const linkAuthor = (author: UnmatchedAuthor, userId: number) => {
    const user = users.find((u) => u.id === userId)
    if (!user) return
    const emails = user.gitEmails.includes(author.authorEmail)
      ? user.gitEmails
      : [...user.gitEmails, author.authorEmail]
    run(() => api.setIdentity(user.id, user.gitlabUsername, emails))
  }

  const addProject = async (e: FormEvent) => {
    e.preventDefault()
    const { token, ...rest } = draft
    setAdding(true)
    if (await run(() => api.createProject(token ? { ...rest, token } : rest))) {
      setDraft({ name: '', gitlabUrl: '', gitlabProject: '', token: '' })
    }
    setAdding(false)
  }

  const saveEdit = async (p: Project) => {
    const changes: { name?: string; token?: string } = {}
    if (editName.trim() && editName.trim() !== p.name) changes.name = editName.trim()
    if (editToken) changes.token = editToken
    if (await run(() => api.updateProject(p.id, changes))) setEditId(null)
  }

  const removeProject = (p: Project) => {
    if (!window.confirm(`Remove project "${p.name}"?`)) return
    if (projectId === p.id) setProjectId(0)
    run(() => api.deleteProject(p.id))
  }

  const syncNow = async (p: Project) => {
    setSyncing((ids) => [...ids, p.id])
    try {
      const r = await api.syncProject(p.id)
      const text = `Synced ${fmt(r.commits)} commits, ${fmt(r.mergeRequests)} MRs, ${fmt(r.events)} events`
      setSyncNotes((n) => ({ ...n, [p.id]: { text, failed: false } }))
    } catch (err) {
      setSyncNotes((n) => ({ ...n, [p.id]: { text: (err as Error).message, failed: true } }))
    } finally {
      setSyncing((ids) => ids.filter((id) => id !== p.id))
      refresh()
    }
  }

  const sortBy = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'name' }))
  const sortValue = (p: PersonStats) =>
    sort.key === 'name' ? p.name.toLowerCase() : COLUMNS.find((c) => c.key === sort.key)!.value(p)
  const sortedPeople = [...people].sort((a, b) => {
    const [x, y] = [sortValue(a), sortValue(b)]
    const order = x < y ? -1 : x > y ? 1 : 0
    return sort.desc ? -order : order
  })
  const maxOf = (value: (p: PersonStats) => number) => Math.max(0, ...people.map(value))

  const sortHeader = (k: SortKey, label: string) => (
    <th key={k} aria-sort={sort.key === k ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button className={sort.key === k ? 'sort-btn on' : 'sort-btn'} onClick={() => sortBy(k)}>
        {label}
        <span className="sort-arrow">{sort.key === k ? (sort.desc ? '↓' : '↑') : ''}</span>
      </button>
    </th>
  )

  const tabs: [Tab, string][] = isStaff
    ? [
        ['people', 'People'],
        ['projects', 'Projects'],
        ['mrs', 'Merge requests']
      ]
    : [
        ['people', 'People'],
        ['mrs', 'Merge requests']
      ]
  const status = loading ? <div className="insights-empty">Loading…</div> : null

  const peopleView = (
    <>
      {status ??
        (people.length === 0 ? (
          <div className="insights-empty">{EMPTY}</div>
        ) : (
          <table className="admin-table insights-table">
            <thead>
              <tr>
                {sortHeader('name', 'Person')}
                {COLUMNS.map((c) => sortHeader(c.key, c.label))}
              </tr>
            </thead>
            <tbody>
              {sortedPeople.map((p) => (
                <tr key={p.userId}>
                  <td>
                    <div className="person-name">{p.name}</div>
                    <div className="person-email">{p.email}</div>
                  </td>
                  {COLUMNS.map((c) => {
                    const value = c.value(p)
                    if (c.key === 'lines')
                      return (
                        <BarCell
                          key={c.key}
                          value={value}
                          max={maxOf(c.value)}
                          tip={`${p.name}: +${fmt(p.additions)} / −${fmt(p.deletions)} lines`}
                        >
                          <span className="lines-add">+{fmt(p.additions)}</span>{' '}
                          <span className="lines-del">−{fmt(p.deletions)}</span>
                        </BarCell>
                      )
                    return (
                      <BarCell
                        key={c.key}
                        value={value}
                        max={maxOf(c.value)}
                        tip={`${p.name}: ${fmt(value)} ${c.label.toLowerCase()}`}
                      >
                        {fmt(value)}
                      </BarCell>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      {isStaff && !loading && unmatched.length > 0 && (
        <section className="insights-section">
          <h3>Unmatched authors</h3>
          <p className="insights-hint">
            Commits by these authors aren’t linked to any user. Link an email to count it.
          </p>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Author</th>
                <th>Email</th>
                <th>Commits</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>
              {unmatched.map((a) => (
                <tr key={a.authorEmail}>
                  <td>{a.authorName}</td>
                  <td className="mono">{a.authorEmail}</td>
                  <td className="num">{fmt(a.commits)}</td>
                  <td>
                    <select
                      value=""
                      disabled={busy}
                      onChange={(e) => linkAuthor(a, Number(e.target.value))}
                      aria-label={`Link ${a.authorEmail} to a user`}
                    >
                      <option value="" disabled>
                        Link to…
                      </option>
                      {/* Managers can only link authors to members; admins to anyone. */}
                      {users.filter((u) => currentUser.role === 'admin' || u.role === 'user').map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.username ?? u.email}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  )

  const statsFor = (id: number) => projectStats.find((s) => s.projectId === id)
  const projectsView = (
    <>
      <form className="project-add" onSubmit={addProject}>
        <h3>Add project</h3>
        <div className="project-add-fields">
          <input
            placeholder="Name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            required
          />
          <input
            type="url"
            placeholder="https://gitlab.example.com"
            aria-label="GitLab URL"
            value={draft.gitlabUrl}
            onChange={(e) => setDraft({ ...draft, gitlabUrl: e.target.value })}
            required
          />
          <input
            placeholder="group/project"
            aria-label="Project path or ID"
            value={draft.gitlabProject}
            onChange={(e) => setDraft({ ...draft, gitlabProject: e.target.value })}
            required
          />
          <input
            type="password"
            placeholder="Access token (optional)"
            aria-label="Access token"
            value={draft.token}
            onChange={(e) => setDraft({ ...draft, token: e.target.value })}
          />
          <button className="btn btn-primary" disabled={busy}>
            {adding ? 'Checking…' : 'Add project'}
          </button>
        </div>
        <div className="insights-hint">Token needs the read_api scope; leave it empty for public projects.</div>
      </form>

      {status ??
        (projects.length === 0 ? (
          <div className="insights-empty">No projects yet — add one above, then sync it.</div>
        ) : (
          <div className="project-grid">
            {projects
              .filter((p) => !projectId || p.id === projectId)
              .map((p) => {
                const s = statsFor(p.id)
                const isSyncing = syncing.includes(p.id)
                const note = syncNotes[p.id]
                const totals: [string, ReactNode][] = [
                  ['Commits', fmt(s?.commits ?? 0)],
                  [
                    'Lines',
                    <>
                      <span className="lines-add">+{fmt(s?.additions ?? 0)}</span>{' '}
                      <span className="lines-del">−{fmt(s?.deletions ?? 0)}</span>
                    </>
                  ],
                  ['MRs opened', fmt(s?.mrsOpened ?? 0)],
                  ['MRs merged', fmt(s?.mrsMerged ?? 0)],
                  ['Approvals', fmt(s?.approvals ?? 0)],
                  ['Comments', fmt(s?.comments ?? 0)],
                  ['Contributors', fmt(s?.contributors ?? 0)]
                ]
                return (
                  <div className="project-card" key={p.id}>
                    {editId === p.id ? (
                      <div className="project-edit">
                        <input value={editName} onChange={(e) => setEditName(e.target.value)} aria-label="Name" />
                        <input
                          type="password"
                          placeholder={p.hasToken ? 'New access token (empty keeps it)' : 'Access token'}
                          aria-label="Access token"
                          value={editToken}
                          onChange={(e) => setEditToken(e.target.value)}
                        />
                        <div className="admin-actions">
                          <button className="btn btn-primary" disabled={busy} onClick={() => saveEdit(p)}>
                            Save
                          </button>
                          {p.hasToken && (
                            <button
                              className="btn btn-danger"
                              disabled={busy}
                              onClick={async () => {
                                if (await run(() => api.updateProject(p.id, { token: '' }))) setEditId(null)
                              }}
                            >
                              Remove token
                            </button>
                          )}
                          <button className="btn" onClick={() => setEditId(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="project-head">
                        <div className="project-title">
                          <strong>{p.name}</strong>
                          <span className="mono">
                            {p.gitlabUrl.replace(/^https?:\/\//, '')} · {p.gitlabProject}
                          </span>
                        </div>
                        {p.hasToken && <span className="pill">token</span>}
                      </div>
                    )}
                    <dl className="project-totals">
                      {totals.map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <div className="project-sync">
                      Last sync: {p.lastSyncedAt ? fmtTime(p.lastSyncedAt) : 'never'}
                      {p.syncError && !note?.failed && <div className="form-error">{p.syncError}</div>}
                      {note && <div className={note.failed ? 'form-error' : 'sync-ok'}>{note.text}</div>}
                    </div>
                    <div className="admin-actions">
                      <button className="btn btn-primary" disabled={isSyncing} onClick={() => syncNow(p)}>
                        {isSyncing ? (
                          <>
                            <span className="spinner" aria-hidden /> Syncing…
                          </>
                        ) : (
                          'Sync now'
                        )}
                      </button>
                      {editId !== p.id && (
                        <button
                          className="btn"
                          onClick={() => {
                            setEditId(p.id)
                            setEditName(p.name)
                            setEditToken('')
                          }}
                        >
                          Edit
                        </button>
                      )}
                      <button className="btn btn-danger" disabled={busy || isSyncing} onClick={() => removeProject(p)}>
                        Remove
                      </button>
                    </div>
                  </div>
                )
              })}
          </div>
        ))}
    </>
  )

  const mrsView =
    status ??
    (mrs.length === 0 ? (
      <div className="insights-empty">{EMPTY}</div>
    ) : (
      <table className="admin-table insights-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>Merge request</th>
            <th>Author</th>
            <th>State</th>
            <th>Created</th>
            <th>Merged</th>
            <th>Reviewers</th>
          </tr>
        </thead>
        <tbody>
          {mrs.map((m) => (
            <tr key={`${m.projectId}-${m.iid}`}>
              <td>{m.projectName}</td>
              <td>
                <button className="mr-link" title={m.webUrl} onClick={() => window.api.openExternal(m.webUrl)}>
                  <span className="mono">!{m.iid}</span> {m.title}
                </button>
              </td>
              <td>{m.authorName}</td>
              <td>
                <span className={`pill pill-mr-${m.state}`}>{m.state}</span>
              </td>
              <td>{fmtDate(m.createdAt)}</td>
              <td>
                {m.mergedAt ? (
                  <>
                    {fmtDate(m.mergedAt)}
                    {m.mergedBy && <div className="person-email">by {m.mergedBy}</div>}
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td>{m.reviewers.length ? m.reviewers.join(', ') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ))

  return (
    <div className="admin-overlay">
      <div className="admin-header">
        <h2>Insights</h2>
        <button className="node-close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>

      {!isStaff && (
        <div className="insights-note">Managers can see your activity counts (not your prompts or code).</div>
      )}

      <div className="insights-filters">
        <div className="mode-switch" role="group" aria-label="Date range">
          {PRESETS.map((days) => (
            <button key={days} className={preset === days ? 'on' : ''} onClick={() => pickPreset(days)}>
              {days} days
            </button>
          ))}
        </div>
        <label className="date-field">
          From
          <input type="date" value={range.from} max={range.to} onChange={(e) => pickDate('from', e.target.value)} />
        </label>
        <label className="date-field">
          To
          <input type="date" value={range.to} min={range.from} onChange={(e) => pickDate('to', e.target.value)} />
        </label>
        <select
          value={projectId}
          onChange={(e) => setProjectId(Number(e.target.value))}
          disabled={!isStaff}
          aria-label="Project"
        >
          <option value={0}>All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="tabs" role="tablist">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'tab on' : 'tab'}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {badRange && <div className="form-error">The start date is after the end date.</div>}
      {error && <div className="form-error">{error}</div>}

      {tab === 'people' && peopleView}
      {tab === 'projects' && isStaff && projectsView}
      {tab === 'mrs' && mrsView}
    </div>
  )
}
