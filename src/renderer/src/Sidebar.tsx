import { useState } from 'react'
import { AGENTS, AGENT_MIME } from './agents'
import type { User } from './api'

type Props = {
  user: User
  onToggleAdmin: () => void
  onToggleInsights: () => void
  onChangePassword: () => void
  onLogout: () => void
}

const STORAGE_KEY = 'chainagent.sidebarCollapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
)
const ICONS = {
  collapse: 'M15 18l-6-6 6-6',
  expand: 'M9 18l6-6-6-6',
  chart: 'M3 3v18h18M8 17v-5M13 17V8M18 17v-8',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4'
}

export default function Sidebar({ user, onToggleAdmin, onToggleInsights, onChangePassword, onLogout }: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed)

  const toggle = () => {
    setCollapsed(!collapsed)
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '0' : '1')
    } catch {
      // Not saved; the sidebar still toggles for this session.
    }
  }

  return (
    <aside className={collapsed ? 'sidebar collapsed' : 'sidebar'}>
      <div className="sidebar-header">
        <span className="sidebar-brand">ChainAgent</span>
        <button
          className="icon-btn"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggle}
        >
          <Icon d={collapsed ? ICONS.expand : ICONS.collapse} />
        </button>
      </div>
      <div className="sidebar-title">Agents</div>
      <div className="agent-list">
        {AGENTS.map((agent) => (
          <div
            key={agent.id}
            className="agent-card"
            title={collapsed ? `${agent.name} — drag onto the canvas` : undefined}
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
        <div className="sidebar-user" title={collapsed ? (user.username ?? user.email) : undefined}>
          <span className="sidebar-user-name">{user.username ?? user.email}</span>
          {user.role !== 'user' && <span className={`pill pill-${user.role}`}>{user.role}</span>}
        </div>
        <div className="sidebar-actions">
          <button className="btn" title="Insights" aria-label="Insights" onClick={onToggleInsights}>
            <Icon d={ICONS.chart} />
            <span className="btn-label">Insights</span>
          </button>
          {user.role !== 'user' && (
            <button className="btn" title="Users" aria-label="Users" onClick={onToggleAdmin}>
              <Icon d={ICONS.users} />
              <span className="btn-label">Users</span>
            </button>
          )}
        </div>
        <div className="sidebar-actions">
          <button className="btn icon-only" title="Change password" aria-label="Change password" onClick={onChangePassword}>
            <Icon d={ICONS.key} />
          </button>
          <button className="btn" title="Log out" aria-label="Log out" onClick={onLogout}>
            <Icon d={ICONS.logout} />
            <span className="btn-label">Log out</span>
          </button>
        </div>
      </div>
    </aside>
  )
}
