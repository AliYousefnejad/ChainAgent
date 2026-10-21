import { useEffect, useState, type FormEvent } from 'react'
import { api } from './api'

export default function ChangePassword({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (next.length < 8) return setError('The new password needs at least 8 characters.')
    if (next !== confirm) return setError("The new passwords don't match.")
    setBusy(true)
    setError('')
    try {
      await api.changePassword(current, next)
      setDone(true)
      setTimeout(onClose, 1200)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="auth-card modal" onSubmit={submit}>
        <h1 className="auth-title">Change password</h1>
        {done ? (
          <div className="form-success">Password changed. Your other sessions were signed out.</div>
        ) : (
          <>
            <label className="field">
              <span>Current password</span>
              <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus />
            </label>
            <label className="field">
              <span>New password</span>
              <input type="password" value={next} onChange={(e) => setNext(e.target.value)} required />
            </label>
            <label className="field">
              <span>Confirm new password</span>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </label>
            {error && <div className="form-error">{error}</div>}
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Change password'}
            </button>
            <button type="button" className="link-btn" onClick={onClose}>
              Cancel
            </button>
          </>
        )}
      </form>
    </div>
  )
}
