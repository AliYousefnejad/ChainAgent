// Team mode: what Claude is asked for when it designs a team, and the checks on its answer.
// Kept free of Electron imports so it can be tested on its own.
export type AgentType = 'claude' | 'codex' | 'gemini' | 'opencode' | 'shell'
export type TeamAgent = { key: string; type: AgentType; role: string; instructions: string; useSubagents: boolean }
export type TeamWire = { from: string; to: string; autoRun: boolean }
export type Team = { agents: TeamAgent[]; wires: TeamWire[]; firstAgent: string; firstPrompt: string }
export type TeamResult = Team | { error: string }

export const MAX_TEAM = 5

export const teamSchema = (allowed: AgentType[]) => ({
  type: 'object',
  properties: {
    agents: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_TEAM,
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          type: { type: 'string', enum: allowed },
          role: { type: 'string' },
          instructions: { type: 'string' },
          useSubagents: { type: 'boolean' }
        },
        required: ['key', 'type', 'role', 'instructions', 'useSubagents']
      }
    },
    wires: {
      type: 'array',
      items: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' }, autoRun: { type: 'boolean' } },
        required: ['from', 'to', 'autoRun']
      }
    },
    firstAgent: { type: 'string' },
    firstPrompt: { type: 'string' }
  },
  required: ['agents', 'wires', 'firstAgent', 'firstPrompt']
})

export const teamRules = (allowed: AgentType[]) => `You design a small team of agent windows for ChainAgent to carry out the user's task.
Each window is an AI coding agent (claude, codex, gemini or opencode) or a shell. Wires pass a window's final reply
to the next window.
- Use as few agents as the task needs (1 to ${MAX_TEAM}). A single claude is fine for simple tasks.
- Only use these types: ${allowed.join(', ')}.
- Give every agent one clear specialty and a short role name (e.g. Architect, Coder, Tester, Reviewer).
  Write its instructions to it in the second person: what it does, and what to put in its final reply,
  because that reply is forwarded to the next agent.
- A "shell" window only runs the commands from \`\`\`bash code blocks in the previous agent's final reply, then
  sends the command, its output and exit code on. Put one after an agent whose work should be run (tests, builds).
  Set autoRun true on a wire into a shell only when running those commands without review is reasonable.
- Wires: give a clear order starting at firstAgent. A loop back (e.g. Reviewer → Coder) is allowed for fixes;
  the app stops loops after 5 hand-offs. Never wire a shell to a shell. The first agent must not be a shell.
- Set useSubagents true for a claude agent with a large implementation job; it then splits independent parts
  across its own sub-agents.
- firstPrompt is the complete, self-contained task for firstAgent.
- Do not carry out the task yourself; you may read files to design a better team.`

export function validateTeam(team: Team | undefined, allowed: AgentType[]): TeamResult {
  if (!team?.agents?.length) return { error: 'Claude did not return a team.' }
  if (team.agents.length > MAX_TEAM) return { error: `The team has more than ${MAX_TEAM} agents.` }
  const keys = new Set(team.agents.map((a) => a.key))
  if (keys.size !== team.agents.length) return { error: 'The team has duplicate agent keys.' }
  const odd = team.agents.find((a) => !allowed.includes(a.type))
  if (odd) return { error: `The team uses "${odd.type}", which isn't allowed.` }
  const typeOf = (key: string) => team.agents.find((a) => a.key === key)?.type
  if (!keys.has(team.firstAgent) || typeOf(team.firstAgent) === 'shell') {
    return { error: 'The team needs an agent (not a shell) to start with.' }
  }
  // Keep only valid, distinct wires; a shell feeding a shell would run output as commands.
  const seen = new Set<string>()
  const wires = team.wires.filter((w) => {
    const id = `${w.from}>${w.to}`
    const ok = keys.has(w.from) && keys.has(w.to) && w.from !== w.to && !seen.has(id)
    seen.add(id)
    return ok && !(typeOf(w.from) === 'shell' && typeOf(w.to) === 'shell')
  })
  return { ...team, wires: wires.map((w) => ({ ...w, autoRun: typeOf(w.to) === 'shell' && w.autoRun })) }
}

