import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  MarkerType,
  type Connection,
  type Edge
} from '@xyflow/react'
import Sidebar from './Sidebar'
import AgentNode, { type AgentNodeType } from './AgentNode'
import WireEdge, { type WireEdgeType } from './WireEdge'
import { agentById, AGENT_MIME } from './agents'
import { api, onUnauthorized, type User } from './api'
import Login from './Login'
import CompleteSetup from './CompleteSetup'
import Admin from './Admin'

const nodeTypes = { agent: AgentNode }
const edgeTypes = { wire: WireEdge }

const NODE_WIDTH = 480
const NODE_HEIGHT = 320
// A wire loop (A→B→A) stops forwarding after this many hand-offs.
const MAX_HOPS = 5
const FLASH_MS = 3000
const SHELL_BLOCK = /```(?:bash|sh|shell|zsh|console)[^\n]*\n([\s\S]*?)```/g

// The commands from an answer's shell code blocks, without "$ " prompts; empty if there are none.
function shellCommands(text: string): string {
  return [...text.matchAll(SHELL_BLOCK)]
    .flatMap((m) => m[1].split('\n'))
    .map((line) => line.replace(/^\$ /, '').trimEnd())
    .filter(Boolean)
    .join('\n')
}

function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNodeType>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<WireEdgeType>([])
  const { screenToFlowPosition } = useReactFlow()
  // Per-agent session counters, so a second Claude becomes "#2" even after "#1" is closed.
  const sessionCounters = useRef<Record<string, number>>({})
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const edgesRef = useRef(edges)
  edgesRef.current = edges
  // How many wire hand-offs led to each node's current turn; a prompt you type yourself is 0.
  const hops = useRef<Record<string, number>>({})

  // Labels fade after a moment, except "loop limit reached", which stays until the next send.
  const labelEdge = useCallback(
    (edgeId: string, status: string, animated: boolean, sticky = false) => {
      const set = (status: string | undefined, animated: boolean) =>
        setEdges((eds) => eds.map((e) => (e.id === edgeId ? { ...e, animated, data: { ...e.data, status } } : e)))
      set(status, animated)
      if (!sticky) setTimeout(() => set(undefined, false), FLASH_MS)
    },
    [setEdges]
  )

  useEffect(
    () =>
      window.pty.onFinished((id, text) => {
        const source = nodesRef.current.find((n) => n.id === id)
        if (!source) return
        const hop = hops.current[id] ?? 0
        hops.current[id] = 0
        const from = `${agentById(source.data.agentId).name} #${source.data.sessionNo}`
        for (const edge of edgesRef.current.filter((e) => e.source === id)) {
          if (hop >= MAX_HOPS) {
            labelEdge(edge.id, 'loop limit reached', false, true)
            continue
          }
          const commands = edge.data?.toShell ? shellCommands(text) : null
          if (commands === '') {
            labelEdge(edge.id, 'no commands', false)
            continue
          }
          const delivery = commands
            ? window.pty.deliver(edge.target, commands, Boolean(edge.data?.autoRun))
            : window.pty.deliver(edge.target, `From ${from}:\n${text}`, true)
          delivery.then((result) => {
            if (result !== 'sent') return labelEdge(edge.id, result, false)
            hops.current[edge.target] = hop + 1
            labelEdge(edge.id, 'sent', true)
          })
        }
      }),
    [labelEdge]
  )

  // Shell output pasted into another shell would run as commands, so Shell → Shell is refused.
  const isValidConnection = useCallback((c: Connection | Edge) => {
    const agentOf = (nodeId: string) => nodesRef.current.find((n) => n.id === nodeId)?.data.agentId
    return c.source !== c.target && !(agentOf(c.source) === 'shell' && agentOf(c.target) === 'shell')
  }, [])

  const onConnect = useCallback(
    (connection: Connection) => {
      const source = nodes.find((n) => n.id === connection.source)
      const target = nodes.find((n) => n.id === connection.target)
      const color = source ? agentById(source.data.agentId).color : '#888'
      const wire: WireEdgeType = {
        ...connection,
        id: `wire-${connection.source}-${connection.target}`,
        type: 'wire',
        style: { stroke: color, strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color },
        data: { toShell: target?.data.agentId === 'shell', autoRun: false }
      }
      setEdges((eds) => addEdge(wire, eds))
    },
    [nodes, setEdges]
  )

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault()
      const agentId = e.dataTransfer.getData(AGENT_MIME)
      if (!agentId) return
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const cwd = await window.api.pickFolder()
      if (!cwd) return

      const sessionNo = (sessionCounters.current[agentId] ?? 0) + 1
      sessionCounters.current[agentId] = sessionNo

      setNodes((nds) =>
        nds.concat({
          id: `${agentId}-${sessionNo}`,
          type: 'agent',
          position: { x: position.x - NODE_WIDTH / 2, y: position.y - 20 },
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          dragHandle: '.agent-node-header',
          data: { agentId, sessionNo, cwd }
        })
      )
    },
    [screenToFlowPosition, setNodes]
  )

  return (
    <main className="canvas">
      <div className="topbar">
        <span className="workspace-name">Untitled workspace</span>
        <span className="topbar-count">
          {nodes.length} session{nodes.length === 1 ? '' : 's'} · {edges.length} connection
          {edges.length === 1 ? '' : 's'}
        </span>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onDragOver={onDragOver}
        onDrop={onDrop}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
        <Controls />
        <MiniMap pannable zoomable nodeColor={(n) => agentById((n as AgentNodeType).data.agentId).color} />
      </ReactFlow>
      {nodes.length === 0 && <div className="empty-hint">Drag an agent from the sidebar to start</div>}
    </main>
  )
}

export default function App() {
  // undefined = still checking the stored session
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [adminOpen, setAdminOpen] = useState(false)

  useEffect(() => {
    onUnauthorized(() => setUser(null))
    api.me().then(setUser, () => setUser(null))
  }, [])

  const logout = async () => {
    await api.logout()
    setAdminOpen(false)
    setUser(null)
  }

  if (user === undefined) return <div className="auth-screen" />
  if (user === null) return <Login onLogin={setUser} />
  if (user.mustChangePassword) return <CompleteSetup onDone={setUser} onLogout={logout} />

  return (
    <ReactFlowProvider>
      <div className="app">
        <Sidebar user={user} onToggleAdmin={() => setAdminOpen((o) => !o)} onLogout={logout} />
        <div className="workspace">
          <Canvas />
          {adminOpen && <Admin currentUser={user} onClose={() => setAdminOpen(false)} />}
        </div>
      </div>
    </ReactFlowProvider>
  )
}
