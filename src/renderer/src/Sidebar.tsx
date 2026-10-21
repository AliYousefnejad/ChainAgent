import { AGENTS, AGENT_MIME } from './agents'
import type { User } from './api'

type Props = { user: User; onToggleAdmin: () => void; onLogout: () => void }

export default function Sidebar({ user, onToggleAdmin, onLogout }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">ChainAgent</div>
      <div className="sidebar-title">Agents</div>
      <div className="agent-list">
        {AGENTS.map((agent) => (
          <div
            key={agent.id}
            className="agent-card"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(AGENT_MIME, agent.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
          >
            <span className="agent-icon" style={{ background: agent.color }}>
              {agent.glyph}
            </span>
            <span className="agent-meta">
              <span className="agent-name">{agent.name}</span>
              <code className="agent-command">{agent.command}</code>
            </span>
          </div>
        ))}
      </div>
      <div className="sidebar-hint">Drag onto the canvas to start a session</div>
      <div className="sidebar-footer">
        <div className="sidebar-user">
          <span className="sidebar-user-name">{user.username ?? user.email}</span>
          {user.role === 'admin' && <span className="pill pill-admin">admin</span>}
        </div>
        <div className="sidebar-actions">
          {user.role === 'admin' && (
            <button className="btn" onClick={onToggleAdmin}>
              Users
            </button>
          )}
          <button className="btn" onClick={onLogout}>
            Log out
          </button>
        </div>
      </div>
    </aside>
  )
}
