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
import AgentNode, { roleBrief, type AgentNodeType } from './AgentNode'
import TeamPanel, { handOffOrder, type TeamState } from './TeamPanel'
import WireEdge, { type WireEdgeType } from './WireEdge'
import PromptBar, { type Target } from './PromptBar'
import PlanPanel, { type PlanState } from './PlanPanel'
import { agentById, AGENT_MIME } from './agents'
import { api, onUnauthorized, type AgentType, type Team, type User } from './api'
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

const FullScreenIcon = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={on ? 'M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3' : 'M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3'} />
  </svg>
)

function makeWire(source: AgentNodeType, target: AgentNodeType, autoRun = false): WireEdgeType {
  const color = agentById(source.data.agentId).color
  return {
    id: `wire-${source.id}-${target.id}`,
    source: source.id,
    target: target.id,
    type: 'wire',
    style: { stroke: color, strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color },
    data: { toShell: target.data.agentId === 'shell', autoRun }
  }
}

const TEAM_GAP = 80
const TEAM_PER_ROW = 3
const READY_POLL_MS = 700

function Canvas({ fullScreen }: { fullScreen: boolean }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNodeType>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<WireEdgeType>([])
  const { screenToFlowPosition, fitView } = useReactFlow()
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
  // Team mode, kept the same way. Claude windows report "ready" through their SessionStart hook.
  const teamRef = useRef<TeamState | null>(null)
  const [designing, setDesigning] = useState(false)
  const readyClaude = useRef(new Set<string>())
  const startTimer = useRef<number | undefined>(undefined)
  const setTeam = useCallback((team: TeamState | null) => {
    teamRef.current = team
    redraw()
  }, [])
  useEffect(() => window.pty.onReady((id) => readyClaude.current.add(id)), [])

  // Codex and Gemini team members have no system-prompt flag, so their role leads every message.
  const toAgent = useCallback((nodeId: string, text: string) => {
    const node = nodesRef.current.find((n) => n.id === nodeId)
    const role = node?.data.role
    return role && (node.data.agentId === 'codex' || node.data.agentId === 'gemini') ? `${roleBrief(role)}\n\n${text}` : text
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
      window.pty.deliver(step.agent, isShell ? text : toAgent(step.agent, text), true).then((result) => {
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
  }, [setPlan, toAgent])

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
            : window.pty.deliver(edge.target, toAgent(edge.target, `From ${from}:\n${text}`), true)
          delivery.then((result) => {
            if (result !== 'sent') return labelEdge(edge.id, result, false)
            hops.current[edge.target] = hop + 1
            labelEdge(edge.id, 'sent', true)
          })
        }
      }),
    [labelEdge, schedule, toAgent]
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
  const team = teamRef.current
  const planBusy = designing
    ? 'Designing a team with Claude… this can take a minute'
    : planning
    ? 'Planning with Claude… this can take a minute'
    : plan?.phase === 'running'
      ? 'Plan running. Wires are paused until it finishes.'
      : ''

  const sendPrompt = async (text: string, target: string) => {
    if (planRef.current?.phase === 'running') return 'A plan is running. Stop it first.'
    hops.current[target] = 0
    const isShell = nodes.find((n) => n.id === target)?.data.agentId === 'shell'
    const result = await window.pty.deliver(target, isShell ? text : toAgent(target, text), true)
    return result === 'sent' ? null : `Not sent: ${result}.`
  }

  const makePlan = async (task: string, target: string) => {
    if (planRef.current?.phase === 'running') return 'A plan is already running.'
    if (teamRef.current) return 'Close the team panel first.'
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

  const makeTeam = async (task: string, allowed: AgentType[]) => {
    if (planRef.current) return 'Close the plan panel first.'
    if (teamRef.current && teamRef.current.phase !== 'running' && teamRef.current.phase !== 'stopped') {
      return 'A team is already being set up.'
    }
    const cwd = await window.api.pickFolder()
    if (!cwd) return 'Pick the project folder for the team.'
    setDesigning(true)
    const [result, trusted] = await Promise.all([window.api.createTeam(task, allowed, cwd), window.api.isClaudeTrusted(cwd)])
    setDesigning(false)
    if ('error' in result) return result.error
    setTeam({ task, cwd, team: result, trusted, phase: 'review' })
    return null
  }

  // Waits until every team window can take input, then starts the chain at the first agent.
  const startWhenReady = useCallback(
    (ids: string[], firstId: string, firstRole: string) => {
      const tick = async () => {
        const state = teamRef.current
        if (!state || state.phase !== 'starting') return
        const ready = (
          await Promise.all(
            ids.map((id) => {
              const node = nodesRef.current.find((n) => n.id === id)
              if (!node) return false
              return node.data.agentId === 'claude' ? readyClaude.current.has(id) : window.pty.ready(id)
            })
          )
        ).filter(Boolean).length
        if (ready < ids.length) {
          if (ready !== state.ready) setTeam({ ...state, ready })
          startTimer.current = window.setTimeout(tick, READY_POLL_MS)
          return
        }
        hops.current[firstId] = 0
        const result = await window.pty.deliver(firstId, toAgent(firstId, state.team.firstPrompt), true)
        setTeam({
          ...state,
          ready,
          phase: result === 'sent' ? 'running' : 'stopped',
          note:
            result === 'sent'
              ? `Team started: the first prompt went to the ${firstRole}. Follow the hand-offs on the wires.`
              : `Couldn't send the first prompt: ${result}.`
        })
      }
      tick()
    },
    [setTeam, toAgent]
  )

  // Creates the team's windows in a free area, wires them, then waits for them to be ready.
  const createTeam = (state: TeamState, team: Team) => {
    const agents = handOffOrder(team)
    const bottom = Math.max(0, ...nodes.map((n) => n.position.y + (n.height ?? NODE_HEIGHT)))
    const top = nodes.length ? bottom + TEAM_GAP * 2 : TEAM_GAP
    const created = new Map<string, AgentNodeType>()
    agents.forEach((agent, i) => {
      const sessionNo = (sessionCounters.current[agent.type] ?? 0) + 1
      sessionCounters.current[agent.type] = sessionNo
      created.set(agent.key, {
        id: `${agent.type}-${sessionNo}`,
        type: 'agent',
        position: {
          x: TEAM_GAP + (i % TEAM_PER_ROW) * (NODE_WIDTH + TEAM_GAP),
          y: top + Math.floor(i / TEAM_PER_ROW) * (NODE_HEIGHT + TEAM_GAP)
        },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        dragHandle: '.agent-node-header',
        data: {
          agentId: agent.type,
          sessionNo,
          cwd: state.cwd,
          role: { name: agent.role, instructions: agent.instructions, useSubagents: agent.useSubagents }
        }
      })
    })
    const newNodes = [...created.values()]
    const wires = team.wires.map((w) => makeWire(created.get(w.from)!, created.get(w.to)!, w.autoRun))
    nodesRef.current = [...nodesRef.current, ...newNodes]
    setNodes((nds) => nds.concat(newNodes))
    setEdges((eds) => eds.concat(wires))
    setTimeout(() => fitView({ nodes: newNodes.map((n) => ({ id: n.id })), padding: 0.15, duration: 400 }), 60)

    setTeam({ ...state, team, phase: 'starting', ready: 0, note: undefined })
    const first = team.agents.find((a) => a.key === team.firstAgent)!
    startWhenReady(newNodes.map((n) => n.id), created.get(first.key)!.id, first.role)
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
      if (source && target) setEdges((eds) => addEdge(makeWire(source, target), eds))
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

  // The plan or team panel sits right above the prompt box.
  const panel = plan ? (
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
  ) : team ? (
    <TeamPanel
      state={team}
      onChange={(changed) => setTeam({ ...team, team: changed })}
      onCreate={() => createTeam(team, team.team)}
      onCancel={() => {
        clearTimeout(startTimer.current)
        setTeam({ ...team, phase: 'stopped', note: 'Not started. The windows stay; send a prompt yourself when ready.' })
      }}
      onClose={() => setTeam(null)}
    />
  ) : null

  return (
    <main className="canvas">
      <div className="topbar">
        <span className="workspace-name">Untitled workspace</span>
        <span className="topbar-count">
          {nodes.length} session{nodes.length === 1 ? '' : 's'} · {edges.length} connection
          {edges.length === 1 ? '' : 's'}
        </span>
        <button
          className="icon-btn"
          title={fullScreen ? 'Exit full screen (F11)' : 'Full screen (F11)'}
          aria-label={fullScreen ? 'Exit full screen' : 'Full screen'}
          onClick={() => window.api.toggleFullScreen()}
        >
          <FullScreenIcon on={fullScreen} />
        </button>
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
      <PromptBar
        targets={targets}
        chainStart={chainStart(nodes, edges)}
        busy={planBusy}
        onSend={sendPrompt}
        onPlan={makePlan}
        onTeam={makeTeam}
        panel={panel}
      />
    </main>
  )
}

export default function App() {
  // undefined = still checking the stored session
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [adminOpen, setAdminOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  // Mirrors the window's real full-screen state (F11, the top-bar button or the window manager).
  const [fullScreen, setFullScreen] = useState(false)
  useEffect(() => window.api.onFullScreen(setFullScreen), [])

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
        {fullScreen && <div className="focus-hint">Full screen. Press F11 to exit.</div>}
        <Sidebar
          user={user}
          onToggleAdmin={() => setAdminOpen((o) => !o)}
          onChangePassword={() => setPasswordOpen(true)}
          onLogout={logout}
        />
        <div className="workspace">
          <Canvas fullScreen={fullScreen} />
          {adminOpen && <Admin currentUser={user} onClose={() => setAdminOpen(false)} />}
          {passwordOpen && <ChangePassword onClose={() => setPasswordOpen(false)} />}
        </div>
      </div>
    </ReactFlowProvider>
  )
}
