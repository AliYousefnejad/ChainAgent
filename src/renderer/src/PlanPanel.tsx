import type { PlanStep } from './api'
import type { Target } from './PromptBar'

export type StepStatus = 'waiting' | 'running' | 'done' | 'failed'
export type PlanState = {
  task: string
  phase: 'review' | 'running' | 'finished' | 'cancelled'
  steps: (PlanStep & { status: StepStatus; output?: string })[]
  note?: string
}

type Props = {
  plan: PlanState
  targets: Target[]
  onChange: (steps: PlanState['steps']) => void
  onRun: () => void
  onCancel: () => void
  onClose: () => void
}

export default function PlanPanel({ plan, targets, onChange, onRun, onCancel, onClose }: Props) {
  const editable = plan.phase === 'review'
  const titleOf = (id: string) => plan.steps.find((s) => s.id === id)?.title ?? id
  const update = (id: string, change: Partial<PlanState['steps'][number]>) =>
    onChange(plan.steps.map((s) => (s.id === id ? { ...s, ...change } : s)))
  const remove = (id: string) =>
    onChange(plan.steps.filter((s) => s.id !== id).map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== id) })))
  const done = plan.steps.filter((s) => s.status === 'done').length
  const last = [...plan.steps].reverse().find((s) => s.output)

  return (
    <div className="plan-panel">
      <div className="plan-head">
        <div>
          <div className="plan-kicker">
            {plan.phase === 'review' ? 'Review the plan' : plan.phase === 'running' ? 'Running plan' : 'Plan'}
          </div>
          <div className="plan-task">{plan.task}</div>
        </div>
        <span className="plan-count">
          {done}/{plan.steps.length} done
        </span>
      </div>

      <ol className="plan-steps">
        {plan.steps.map((step, i) => {
          const color = targets.find((t) => t.id === step.agent)?.color ?? '#888'
          return (
            <li key={step.id} className={`plan-step ${step.status}`} style={{ '--accent': color } as React.CSSProperties}>
              <div className="plan-step-head">
                <span className="plan-step-no">{i + 1}</span>
                {editable ? (
                  <input className="plan-step-title" value={step.title} onChange={(e) => update(step.id, { title: e.target.value })} />
                ) : (
                  <span className="plan-step-title">{step.title}</span>
                )}
                {editable ? (
                  <select value={step.agent} onChange={(e) => update(step.id, { agent: e.target.value })}>
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="plan-step-agent">{targets.find((t) => t.id === step.agent)?.label ?? step.agent}</span>
                )}
                {!editable && <span className={`plan-status ${step.status}`}>{step.status}</span>}
                {editable && (
                  <button className="node-close" title="Remove step" onClick={() => remove(step.id)}>
                    ×
                  </button>
                )}
              </div>
              {editable ? (
                <textarea
                  className="plan-step-prompt"
                  value={step.prompt}
                  rows={Math.min(6, step.prompt.split('\n').length + 1)}
                  onChange={(e) => update(step.id, { prompt: e.target.value })}
                />
              ) : (
                <div className="plan-step-text">{step.prompt}</div>
              )}
              {step.dependsOn.length > 0 && (
                <div className="plan-deps">after: {step.dependsOn.map((d) => titleOf(d)).join(', ')}</div>
              )}
            </li>
          )
        })}
      </ol>

      {plan.note && <div className="plan-note">{plan.note}</div>}
      {plan.phase === 'finished' && last?.output && (
        <details className="plan-result">
          <summary>Last result</summary>
          <pre>{last.output}</pre>
        </details>
      )}

      <div className="plan-actions">
        {plan.phase === 'review' && (
          <>
            <button className="btn" onClick={onClose}>
              Discard
            </button>
            <button className="btn btn-primary" onClick={onRun} disabled={!plan.steps.length}>
              Run plan
            </button>
          </>
        )}
        {plan.phase === 'running' && (
          <button className="btn btn-danger" onClick={onCancel}>
            Stop plan
          </button>
        )}
        {(plan.phase === 'finished' || plan.phase === 'cancelled') && (
          <button className="btn" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </div>
  )
}
