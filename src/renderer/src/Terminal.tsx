import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { agentById } from './agents'

type Props = { id: string; agentId: string; cwd: string; run: number; onExit: (code: number) => void }

const COMMAND_NOT_FOUND = 127

export default function Terminal({ id, agentId, cwd, run, onExit }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  useEffect(() => {
    const term = new XTerm({
      fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, Menlo, monospace",
      fontSize: 12.5,
      cursorBlink: true,
      theme: { background: '#07080b', foreground: '#e6e8ee', cursor: '#e6e8ee', selectionBackground: '#3a4150' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, url) => window.api.openExternal(url)))
    term.open(ref.current!)
    fit.fit()

    const offData = window.pty.onData((sid, data) => sid === id && term.write(data))
    const offExit = window.pty.onExit((sid, code) => {
      if (sid !== id) return
      if (code === COMMAND_NOT_FOUND) {
        term.writeln(`\r\n\x1b[33m${agentById(agentId).command} is not installed on this machine.\x1b[0m`)
      }
      onExitRef.current(code)
    })
    const input = term.onData((data) => window.pty.write(id, data))
    window.pty.spawn(id, agentId, cwd, term.cols, term.rows).then((error) => {
      if (!error) return
      term.writeln(`\x1b[31m${error}\x1b[0m`)
      onExitRef.current(-1)
    })

    const observer = new ResizeObserver(() => {
      fit.fit()
      window.pty.resize(id, term.cols, term.rows)
    })
    observer.observe(ref.current!)

    return () => {
      observer.disconnect()
      input.dispose()
      offData()
      offExit()
      window.pty.kill(id)
      term.dispose()
    }
  }, [id, agentId, cwd, run])

  return <div ref={ref} className="terminal nodrag nowheel nokey" />
}
