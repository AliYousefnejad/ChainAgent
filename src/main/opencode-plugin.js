// ChainAgent's OpenCode plugin, loaded through OPENCODE_CONFIG_CONTENT for windows the app starts.
// When a turn ends (session.idle) it sends the final reply to ChainAgent's local /stop endpoint.
export const ChainAgentNotify = async ({ client }) => {
  const url = process.env.CHAINAGENT_HOOK_URL
  const secret = process.env.CHAINAGENT_SECRET
  const node = process.env.CHAINAGENT_NODE
  if (!url || !secret || !node) return {}

  return {
    event: async ({ event }) => {
      if (event.type !== 'session.idle') return
      try {
        const id = event.properties.sessionID
        // Sub-agent sessions also go idle; only the main conversation is forwarded.
        const session = await client.session.get({ path: { id } })
        if (session.data?.parentID) return
        const messages = (await client.session.messages({ path: { id }, query: { limit: 20 } })).data ?? []
        const last = [...messages].reverse().find((m) => m.info.role === 'assistant')
        if (!last || last.info.error) return // aborted or failed turns aren't passed on
        const text = last.parts
          .filter((p) => p.type === 'text' && !p.synthetic)
          .map((p) => p.text)
          .join('')
          .trim()
        if (!text) return
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, 'X-Canvas-Node': node },
          body: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: text }),
          signal: AbortSignal.timeout(5000)
        })
      } catch {
        // Never disturb OpenCode; the turn simply isn't forwarded.
      }
    }
  }
}
