import { useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type Node, type NodeProps } from '@xyflow/react'
import { agentById } from './agents'
import Terminal from './Terminal'

export type AgentNodeData = { agentId: string; sessionNo: number; cwd: string }
export type AgentNodeType = Node<AgentNodeData, 'agent'>

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
      <Terminal id={id} agentId={data.agentId} cwd={data.cwd} run={run} onExit={setExitCode} />
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
