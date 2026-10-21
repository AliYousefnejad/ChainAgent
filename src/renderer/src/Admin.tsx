import { useEffect, useState, type FormEvent } from 'react'
import { api, type AdminUser, type Role, type User } from './api'

type Props = { currentUser: User; onClose: () => void }

const ROLE_LABELS: Record<Role, string> = { user: 'Member', manager: 'Manager', admin: 'Admin' }

export default function Admin({ currentUser, onClose }: Props) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [error, setError] = useState('')
  const [email, setEmail] = useState('')
  const [tempPassword, setTempPassword] = useState('')
  const [resetId, setResetId] = useState<number | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [identityId, setIdentityId] = useState<number | null>(null)
  const [gitlabUsername, setGitlabUsername] = useState('')
  const [gitEmails, setGitEmails] = useState('')
  const isAdmin = currentUser.role === 'admin'
  // Managers may only manage members; the server enforces this, the UI just hides what would fail.
  const canManage = (u: AdminUser) => isAdmin || u.role === 'user'

  const load = () =>
    api
      .listUsers()
      .then(setUsers)
      .catch((err: Error) => setError(err.message))

  useEffect(() => {
    load()
  }, [])

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
      await load()
      setBusy(false)
    }
  }

  const addUser = async (e: FormEvent) => {
    e.preventDefault()
    if (await run(() => api.createUser(email, tempPassword))) {
      setEmail('')
      setTempPassword('')
    }
  }

  const saveReset = async (id: number) => {
    if (await run(() => api.resetPassword(id, resetPassword))) {
      setResetId(null)
      setResetPassword('')
    }
  }

  const editIdentity = (u: AdminUser) => {
    setIdentityId(u.id)
    setGitlabUsername(u.gitlabUsername ?? '')
    setGitEmails(u.gitEmails.join(', '))
  }

  const saveIdentity = async (id: number) => {
    const emails = gitEmails
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
    if (await run(() => api.setIdentity(id, gitlabUsername.trim() || null, emails))) setIdentityId(null)
  }

  return (
    <div className="admin-overlay">
      <div className="admin-header">
        <h2>Users</h2>
        <button className="node-close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <form className="admin-add" onSubmit={addUser}>
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input
          type="text"
          placeholder="Temporary password"
          value={tempPassword}
          onChange={(e) => setTempPassword(e.target.value)}
          minLength={8}
          required
        />
        <button className="btn btn-primary" disabled={busy}>
          Add user
        </button>
      </form>

      {error && <div className="form-error">{error}</div>}

      <table className="admin-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Username</th>
            <th>Role</th>
            <th>Identity</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>
                {u.username ?? '—'} {u.pendingSetup && <span className="pill">pending setup</span>}
              </td>
              <td>
                {isAdmin ? (
                  <select
                    value={u.role}
                    disabled={busy || u.id === currentUser.id}
                    title={u.id === currentUser.id ? 'You can’t change your own role' : undefined}
                    aria-label={`Role of ${u.email}`}
                    onChange={(e) => run(() => api.setRole(u.id, e.target.value as Role))}
                  >
                    {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className={`pill pill-${u.role === 'user' ? 'member' : u.role}`}>{ROLE_LABELS[u.role]}</span>
                )}
              </td>
              <td>
                {identityId === u.id ? (
                  <div className="identity-edit">
                    <input
                      placeholder="GitLab username"
                      value={gitlabUsername}
                      onChange={(e) => setGitlabUsername(e.target.value)}
                      autoFocus
                    />
                    <input
                      placeholder="Commit emails, comma-separated"
                      value={gitEmails}
                      onChange={(e) => setGitEmails(e.target.value)}
                    />
                    <div className="admin-actions">
                      <button className="btn btn-primary" disabled={busy} onClick={() => saveIdentity(u.id)}>
                        Save
                      </button>
                      <button className="btn" onClick={() => setIdentityId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="identity-view">
                    <div>
                      {u.gitlabUsername ? (
                        <span className="mono">@{u.gitlabUsername}</span>
                      ) : (
                        <span className="muted">No GitLab user</span>
                      )}
                      {u.gitEmails.length > 0 && <div className="person-email">{u.gitEmails.join(', ')}</div>}
                    </div>
                    {canManage(u) && (
                      <button className="btn btn-small" onClick={() => editIdentity(u)}>
                        Edit
                      </button>
                    )}
                  </div>
                )}
              </td>
              <td>
                <span className={u.active ? 'pill pill-active' : 'pill pill-disabled'}>
                  {u.active ? 'Active' : 'Disabled'}
                </span>{' '}
                {u.lockedUntil && (
                  <span className="pill pill-locked" title="Too many wrong passwords. Reset password unlocks it now.">
                    Locked until {new Date(u.lockedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </td>
              <td>
                <div className="admin-actions">
                  {resetId === u.id ? (
                    <>
                      <input
                        type="text"
                        placeholder="New temporary password"
                        value={resetPassword}
                        onChange={(e) => setResetPassword(e.target.value)}
                        autoFocus
                      />
                      <button className="btn btn-primary" disabled={busy} onClick={() => saveReset(u.id)}>
                        Save
                      </button>
                      <button className="btn" onClick={() => setResetId(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      {u.id !== currentUser.id && canManage(u) && (
                        <button
                          className={u.active ? 'btn btn-danger' : 'btn'}
                          disabled={busy}
                          onClick={() => run(() => api.setActive(u.id, !u.active))}
                        >
                          {u.active ? 'Disable' : 'Enable'}
                        </button>
                      )}
                      {canManage(u) && (
                        <button
                          className="btn"
                          onClick={() => {
                            setResetId(u.id)
                            setResetPassword('')
                          }}
                        >
                          Reset password
                        </button>
                      )}
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
