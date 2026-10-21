import { useEffect, useState, type FormEvent } from 'react'
import { api, type AdminUser, type User } from './api'

type Props = { currentUser: User; onClose: () => void }

export default function Admin({ currentUser, onClose }: Props) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [error, setError] = useState('')
  const [email, setEmail] = useState('')
  const [tempPassword, setTempPassword] = useState('')
  const [resetId, setResetId] = useState<number | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [busy, setBusy] = useState(false)

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
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.email} {u.role === 'admin' && <span className="pill pill-admin">admin</span>}
              </td>
              <td>
                {u.username ?? '—'} {u.pendingSetup && <span className="pill">pending setup</span>}
              </td>
              <td>
                <span className={u.active ? 'pill pill-active' : 'pill pill-disabled'}>
                  {u.active ? 'Active' : 'Disabled'}
                </span>
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
                      {u.id !== currentUser.id && (
                        <button
                          className={u.active ? 'btn btn-danger' : 'btn'}
                          disabled={busy}
                          onClick={() => run(() => api.setActive(u.id, !u.active))}
                        >
                          {u.active ? 'Disable' : 'Enable'}
                        </button>
                      )}
                      <button
                        className="btn"
                        onClick={() => {
                          setResetId(u.id)
                          setResetPassword('')
                        }}
                      >
                        Reset password
                      </button>
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
