import { agentById } from './agents'
import type { Team, TeamAgent } from './api'

export type TeamState = {
  task: string
  cwd: string
  team: Team
  trusted: boolean // Claude already trusts the folder, so its windows won't ask first
  phase: 'review' | 'starting' | 'running' | 'stopped'
  ready?: number
  note?: string
}

type Props = {
  state: TeamState
  onChange: (team: Team) => void
  onCreate: () => void
  onCancel: () => void
  onClose: () => void
}

// Agents in hand-off order: the first agent, then whoever its wires lead to, then the rest.
export function handOffOrder(team: Team): TeamAgent[] {
  const order: string[] = []
  const visit = (key: string) => {
    if (order.includes(key)) return
    order.push(key)
    team.wires.filter((w) => w.from === key).forEach((w) => visit(w.to))
  }
  visit(team.firstAgent)
  team.agents.forEach((a) => visit(a.key))
  return order.map((key) => team.agents.find((a) => a.key === key)!).filter(Boolean)
}

export default function TeamPanel({ state, onChange, onCreate, onCancel, onClose }: Props) {
  const { team, phase } = state
  const editable = phase === 'review'
  const roleOf = (key: string) => team.agents.find((a) => a.key === key)?.role ?? key
  const update = (key: string, change: Partial<TeamAgent>) =>
    onChange({ ...team, agents: team.agents.map((a) => (a.key === key ? { ...a, ...change } : a)) })
  const remove = (key: string) =>
    onChange({
      ...team,
      agents: team.agents.filter((a) => a.key !== key),
      wires: team.wires.filter((w) => w.from !== key && w.to !== key)
    })
  const hasClaude = team.agents.some((a) => a.type === 'claude')

  return (
    <div className="plan-panel team-panel">
      <div className="plan-head">
        <div>
          <div className="plan-kicker">{editable ? 'Review the team' : 'Team'}</div>
          <div className="plan-task">{state.task}</div>
          <div className="team-folder" title={state.cwd}>
            Folder: {state.cwd}
          </div>
        </div>
        <span className="plan-count">
          {team.agents.length} agent{team.agents.length === 1 ? '' : 's'}
        </span>
      </div>

      <ol className="plan-steps">
        {handOffOrder(team).map((agent, i) => {
          const info = agentById(agent.type)
          return (
            <li key={agent.key} className="plan-step" style={{ '--accent': info.color } as React.CSSProperties}>
              <div className="plan-step-head">
                <span className="plan-step-no">{i + 1}</span>
                {editable ? (
                  <input className="plan-step-title" value={agent.role} onChange={(e) => update(agent.key, { role: e.target.value })} />
                ) : (
                  <span className="plan-step-title">{agent.role}</span>
                )}
                <span className="plan-step-agent">
                  {info.glyph} {info.name}
                </span>
                {agent.key === team.firstAgent && <span className="plan-status running">starts</span>}
                {editable && agent.key !== team.firstAgent && (
                  <button className="node-close" title="Remove agent" onClick={() => remove(agent.key)}>
                    ×
                  </button>
                )}
              </div>
              {agent.type !== 'shell' &&
                (editable ? (
                  <textarea
                    className="plan-step-prompt"
                    value={agent.instructions}
                    rows={Math.min(5, agent.instructions.split('\n').length + 1)}
                    onChange={(e) => update(agent.key, { instructions: e.target.value })}
                  />
                ) : (
                  <div className="plan-step-text">{agent.instructions}</div>
                ))}
              {agent.type === 'claude' && (
                <label className="team-check">
                  <input
                    type="checkbox"
                    checked={agent.useSubagents}
                    disabled={!editable}
                    onChange={(e) => update(agent.key, { useSubagents: e.target.checked })}
                  />
                  Use sub-agents for independent parts
                </label>
              )}
            </li>
          )
        })}
      </ol>

      {team.wires.length > 0 && (
        <div className="team-wires">
          <div className="plan-kicker">Hand-offs</div>
          {team.wires.map((w) => {
            const toShell = team.agents.find((a) => a.key === w.to)?.type === 'shell'
            return (
              <div key={`${w.from}>${w.to}`} className="team-wire">
                {roleOf(w.from)} → {roleOf(w.to)}
                {toShell && (
                  <button
                    className={w.autoRun ? 'wire-autorun on' : 'wire-autorun'}
                    disabled={!editable}
                    title={w.autoRun ? 'Commands run as soon as they arrive' : 'Commands are pasted; you press Enter'}
                    onClick={() => onChange({ ...team, wires: team.wires.map((x) => (x === w ? { ...x, autoRun: !x.autoRun } : x)) })}
                  >
                    Auto-run: {w.autoRun ? 'on' : 'off'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="team-first">
        <div className="plan-kicker">First prompt → {roleOf(team.firstAgent)}</div>
        {editable ? (
          <textarea
            className="plan-step-prompt"
            value={team.firstPrompt}
            rows={Math.min(6, team.firstPrompt.split('\n').length + 1)}
            onChange={(e) => onChange({ ...team, firstPrompt: e.target.value })}
          />
        ) : (
          <div className="plan-step-text">{team.firstPrompt}</div>
        )}
      </div>

      {editable && hasClaude && !state.trusted && (
        <div className="plan-note warn">
          Claude hasn't trusted this folder yet. Each new Claude window will first ask about it: choose "Yes, I trust
          this folder" there (the highlighted default is "No, exit"). The team starts once every window is ready.
        </div>
      )}
      {phase === 'starting' && (
        <div className="plan-note">
          Waiting for windows ({state.ready ?? 0}/{team.agents.length} ready). If a Claude window asks about trusting
          the folder, choose "Yes, I trust this folder" there.
        </div>
      )}
      {state.note && <div className="plan-note">{state.note}</div>}

      <div className="plan-actions">
        {phase === 'review' && (
          <>
            <button className="btn" onClick={onClose}>
              Discard
            </button>
            <button className="btn btn-primary" onClick={onCreate} disabled={!team.agents.length}>
              Create &amp; run
            </button>
          </>
        )}
        {phase === 'starting' && (
          <button className="btn btn-danger" onClick={onCancel}>
            Don't start
          </button>
        )}
        {(phase === 'running' || phase === 'stopped') && (
          <button className="btn" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </div>
  )
}
