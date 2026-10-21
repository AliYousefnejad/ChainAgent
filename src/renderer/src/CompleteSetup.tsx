import { useState, type FormEvent } from 'react'
import { api, type User } from './api'

type Props = { onDone: (user: User) => void; onLogout: () => void }

export default function CompleteSetup({ onDone, onLogout }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (password.length < 8) return setError('Password must be at least 8 characters')
    if (password !== confirm) return setError('Passwords do not match')
    setBusy(true)
    setError('')
    try {
      onDone(await api.completeSetup(username, password))
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="auth-title">Finish setting up your account</h1>
        <label className="field">
          <span>Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            pattern="[a-zA-Z0-9._\-]{3,32}"
            title="3–32 characters: letters, numbers, dot, underscore or dash"
            required
            autoFocus
          />
        </label>
        <label className="field">
          <span>New password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
        <button type="button" className="link-btn" onClick={onLogout}>
          Log out
        </button>
      </form>
    </div>
  )
}
