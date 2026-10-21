import { useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type Node, type NodeProps } from '@xyflow/react'
import { agentById } from './agents'
import Terminal from './Terminal'

export type Role = { name: string; instructions: string; useSubagents: boolean }
export type AgentNodeData = { agentId: string; sessionNo: number; cwd: string; role?: Role }
export type AgentNodeType = Node<AgentNodeData, 'agent'>

// What a team member is told about its job. Claude gets it as an appended system prompt;
// Codex and Gemini (which have no such flag) get it in front of every message they receive.
export function roleBrief(role: Role): string {
  return [
    `You are the ${role.name} in a ChainAgent team. ${role.instructions}`,
    role.useSubagents ? 'Split independent parts of the work across sub-agents with your Agent tool, then combine their results.' : '',
    'Your final reply is forwarded automatically to the next agent in the chain, so end with what it needs.'
  ]
    .filter(Boolean)
    .join('\n')
}

export default function AgentNode({ id, data, selected }: NodeProps<AgentNodeType>) {
  const { deleteElements } = useReactFlow()
  const agent = agentById(data.agentId)
  const [run, setRun] = useState(0)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const running = exitCode === null

  const close = () => {
    if (running && !window.confirm(`Stop ${agent.name} #${data.sessionNo}?`)) return
    deleteElements({ nodes: [{ id }] })
  }

  const restart = () => {
    setExitCode(null)
    setRun((r) => r + 1)
  }

  return (
    <div className="agent-node" style={{ '--accent': agent.color } as React.CSSProperties}>
      <NodeResizer isVisible={selected} minWidth={320} minHeight={200} color={agent.color} />
      <Handle type="target" position={Position.Left} />
      <header className="agent-node-header">
        <span className="agent-dot" />
        <span className="agent-node-title">
          {data.role && <span className="agent-node-role">{data.role.name} · </span>}
          {agent.name} <span className="agent-node-no">#{data.sessionNo}</span>
        </span>
        <span className="agent-node-cwd" title={data.cwd}>
          {data.cwd.split('/').pop() || '/'}
        </span>
        {running ? (
          <span className="status-pill status-running">running</span>
        ) : (
          <>
            <span className="status-pill">exited ({exitCode})</span>
            <button className="btn btn-small nodrag" onClick={restart}>
              Restart
            </button>
          </>
        )}
        <button className="node-close nodrag" title="Close session" onClick={close}>
          ×
        </button>
      </header>
      <Terminal
        id={id}
        agentId={data.agentId}
        cwd={data.cwd}
        role={data.role && data.agentId === 'claude' ? roleBrief(data.role) : undefined}
        run={run}
        onExit={setExitCode}
      />
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
