import { useCallback, useEffect, useReducer, useRef, useState, type DragEvent } from 'react'
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
import PromptBar, { type Target } from './PromptBar'
import PlanPanel, { type PlanState } from './PlanPanel'
import { agentById, AGENT_MIME } from './agents'
import { api, onUnauthorized, type User } from './api'
import Login from './Login'
import CompleteSetup from './CompleteSetup'
import Admin from './Admin'
import ChangePassword from './ChangePassword'

const nodeTypes = { agent: AgentNode }
const edgeTypes = { wire: WireEdge }

const NODE_WIDTH = 480
const NODE_HEIGHT = 320
// A wire loop (A→B→A) stops forwarding after this many hand-offs.
const MAX_HOPS = 5
const FLASH_MS = 3000
const SHELL_RETRY_MS = 2000
const SHELL_BLOCK = /```(?:bash|sh|shell|zsh|console)[^\n]*\n([\s\S]*?)```/g

// The commands from an answer's shell code blocks, without "$ " prompts; empty if there are none.
function shellCommands(text: string): string {
  return [...text.matchAll(SHELL_BLOCK)]
    .flatMap((m) => m[1].split('\n'))
    .map((line) => line.replace(/^\$ /, '').trimEnd())
    .filter(Boolean)
    .join('\n')
}

const labelOf = (node: AgentNodeType) => `${agentById(node.data.agentId).name} #${node.data.sessionNo}`

// Where a prompt enters the chain: a window with outgoing wires and none coming in (left-most first),
// otherwise the first window.
function chainStart(nodes: AgentNodeType[], edges: WireEdgeType[]): string | undefined {
  const incoming = new Set(edges.map((e) => e.target))
  const outgoing = new Set(edges.map((e) => e.source))
  const starts = nodes.filter((n) => outgoing.has(n.id) && !incoming.has(n.id))
  return (starts.sort((a, b) => a.position.x - b.position.x)[0] ?? nodes[0])?.id
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
  // The plan lives in a ref so IPC callbacks see the latest state; redraw() re-renders.
  const planRef = useRef<PlanState | null>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const [planning, setPlanning] = useState(false)
  const retryTimer = useRef<number | undefined>(undefined)
  const setPlan = useCallback((plan: PlanState | null) => {
    planRef.current = plan
    redraw()
  }, [])

  // Starts every step whose dependencies are done and whose window isn't busy with another step.
  const schedule = useCallback(() => {
    const plan = planRef.current
    if (!plan || plan.phase !== 'running') return
    clearTimeout(retryTimer.current)
    if (plan.steps.every((s) => s.status === 'done')) {
      return setPlan({ ...plan, phase: 'finished', note: `Plan finished: ${plan.steps.length}/${plan.steps.length} steps.` })
    }
    const busy = new Set(plan.steps.filter((s) => s.status === 'running').map((s) => s.agent))
    for (const step of plan.steps) {
      const ready = step.dependsOn.every((d) => plan.steps.find((s) => s.id === d)?.status === 'done')
      if (step.status !== 'waiting' || busy.has(step.agent) || !ready) continue
      busy.add(step.agent)
      step.status = 'running'
      const isShell = nodesRef.current.find((n) => n.id === step.agent)?.data.agentId === 'shell'
      const deps = plan.steps.filter((s) => step.dependsOn.includes(s.id))
      // Shell steps are the reviewed commands only; agents also get their dependencies' results.
      const text =
        isShell || !deps.length
          ? step.prompt
          : `${step.prompt}\n\nResults from earlier steps:\n${deps.map((d) => `## ${d.title}\n${d.output ?? ''}`).join('\n\n')}`
      window.pty.deliver(step.agent, text, true).then((result) => {
        if (planRef.current !== plan || plan.phase !== 'running' || result === 'sent') return
        if (result === 'shell busy') {
          step.status = 'waiting'
          retryTimer.current = window.setTimeout(schedule, SHELL_RETRY_MS)
          return redraw()
        }
        step.status = 'failed'
        setPlan({ ...plan, phase: 'finished', note: `"${step.title}" could not start: ${result}.` })
      })
    }
    setPlan({ ...plan })
  }, [setPlan])

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
        // While a plan runs, a finished turn completes that window's step and wires are paused.
        const plan = planRef.current
        if (plan?.phase === 'running') {
          const step = plan.steps.find((s) => s.status === 'running' && s.agent === id)
          if (step) {
            step.status = 'done'
            step.output = text
            schedule()
          }
          return
        }
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
    [labelEdge, schedule]
  )

  // A window closed while its step runs would leave the plan (and paused wires) stuck.
  useEffect(() => {
    const plan = planRef.current
    if (plan?.phase !== 'running') return
    const lost = plan.steps.find((s) => s.status === 'running' && !nodes.some((n) => n.id === s.agent))
    if (!lost) return
    lost.status = 'failed'
    clearTimeout(retryTimer.current)
    setPlan({ ...plan, phase: 'finished', note: `"${lost.title}" stopped: its window was closed.` })
  }, [nodes, setPlan])

  const targets: Target[] = nodes.map((n) => ({ id: n.id, label: labelOf(n), color: agentById(n.data.agentId).color }))
  const plan = planRef.current
  const planBusy = planning
    ? 'Planning with Claude… this can take a minute'
    : plan?.phase === 'running'
      ? 'Plan running. Wires are paused until it finishes.'
      : ''

  const sendPrompt = async (text: string, target: string) => {
    if (planRef.current?.phase === 'running') return 'A plan is running. Stop it first.'
    hops.current[target] = 0
    const result = await window.pty.deliver(target, text, true)
    return result === 'sent' ? null : `Not sent: ${result}.`
  }

  const makePlan = async (task: string, target: string) => {
    if (planRef.current?.phase === 'running') return 'A plan is already running.'
    setPlanning(true)
    const result = await window.api.createPlan(
      task,
      nodes.map((n) => ({ id: n.id, agent: n.data.agentId, name: labelOf(n), cwd: n.data.cwd })),
      edges.map((e) => ({ source: e.source, target: e.target })),
      nodes.find((n) => n.id === target)?.data.cwd ?? ''
    )
    setPlanning(false)
    if ('error' in result) return result.error
    setPlan({ task, phase: 'review', steps: result.steps.map((s) => ({ ...s, status: 'waiting' })) })
    return null
  }

  const runningAgents = new Set(plan?.phase === 'running' ? plan.steps.filter((s) => s.status === 'running').map((s) => s.agent) : [])
  const shownNodes = runningAgents.size
    ? nodes.map((n) => (runningAgents.has(n.id) ? { ...n, className: 'plan-active' } : n))
    : nodes

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
        nodes={shownNodes}
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
        <MiniMap position="top-right" pannable zoomable nodeColor={(n) => agentById((n as AgentNodeType).data.agentId).color} />
      </ReactFlow>
      {nodes.length === 0 && <div className="empty-hint">Drag an agent from the sidebar to start</div>}
      {plan && (
        <PlanPanel
          plan={plan}
          targets={targets}
          onChange={(steps) => setPlan({ ...plan, steps })}
          onRun={() => {
            planRef.current = { ...plan, phase: 'running', note: undefined, steps: plan.steps.map((s) => ({ ...s, status: 'waiting' })) }
            schedule()
          }}
          onCancel={() => {
            clearTimeout(retryTimer.current)
            setPlan({ ...plan, phase: 'cancelled', note: 'Plan stopped. Agents still working finish their current turn.' })
          }}
          onClose={() => setPlan(null)}
        />
      )}
      <PromptBar targets={targets} chainStart={chainStart(nodes, edges)} busy={planBusy} onSend={sendPrompt} onPlan={makePlan} />
    </main>
  )
}

export default function App() {
  // undefined = still checking the stored session
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [adminOpen, setAdminOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)

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
        <Sidebar
          user={user}
          onToggleAdmin={() => setAdminOpen((o) => !o)}
          onChangePassword={() => setPasswordOpen(true)}
          onLogout={logout}
        />
        <div className="workspace">
          <Canvas />
          {adminOpen && <Admin currentUser={user} onClose={() => setAdminOpen(false)} />}
          {passwordOpen && <ChangePassword onClose={() => setPasswordOpen(false)} />}
        </div>
      </div>
    </ReactFlowProvider>
  )
}
