import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// zsh is started with ZDOTDIR pointing here. Each file loads the user's own file first,
// then .zshrc adds hooks that print invisible markers around every command:
//   ESC ] 6973 ; C ; <base64 command> BEL   when a command starts
//   ESC ] 6973 ; D ; <exit code> BEL        when it finishes
const load = (file: string) =>
  `ZDOTDIR="$CHAINAGENT_USER_ZDOTDIR"; [ -f "$ZDOTDIR/${file}" ] && . "$ZDOTDIR/${file}"`

const FILES: Record<string, string> = {
  '.zshenv': [
    'CHAINAGENT_ZDOTDIR="$ZDOTDIR"',
    'CHAINAGENT_USER_ZDOTDIR="${CHAINAGENT_USER_ZDOTDIR:-$HOME}"',
    load('.zshenv'),
    // The user's .zshenv may move ZDOTDIR; later files are read from there.
    'CHAINAGENT_USER_ZDOTDIR="$ZDOTDIR"; ZDOTDIR="$CHAINAGENT_ZDOTDIR"'
  ].join('\n'),
  '.zprofile': `${load('.zprofile')}; ZDOTDIR="$CHAINAGENT_ZDOTDIR"`,
  '.zshrc': [
    `${load('.zshrc')}; ZDOTDIR="$CHAINAGENT_ZDOTDIR"`,
    `__chainagent_preexec() { printf '\\e]6973;C;%s\\a' "$(printf '%s' "$1" | base64 | tr -d '\\n')" }`,
    `__chainagent_precmd() { printf '\\e]6973;D;%s\\a' "$?" }`,
    'autoload -Uz add-zsh-hook',
    'add-zsh-hook preexec __chainagent_preexec',
    // First in line, so $? is still the command's exit code.
    'precmd_functions=(__chainagent_precmd $precmd_functions)'
  ].join('\n'),
  // Last file of a login shell: leave ZDOTDIR as the user's for anything started from here.
  '.zlogin': load('.zlogin')
}

export function writeZshIntegration(dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(FILES)) writeFileSync(join(dir, name), content + '\n')
}

const MARKER = /\x1b\]6973;([CD]);([^\x07]*)\x07/g
const PARTIAL = /\x1b(\](6(9(7(3(;[^\x07]*)?)?)?)?)?)?$/
const MAX_OUTPUT = 8000

function plainText(output: string): string {
  return output
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78]/g, '')
    .split('\n')
    .map((line) => line.replace(/\r$/, '').split('\r').pop()!)
    .join('\n')
    .trim()
    .slice(-MAX_OUTPUT)
}

// Turns a shell's output stream into "command finished" reports, and knows whether the
// shell is idle at its own prompt (first prompt drawn, no command running).
export function commandTracker(onFinished: (report: string) => void) {
  let carry = ''
  let command: string | null = null
  let output = ''
  let ready = false

  const idle = () => ready && command === null
  const feed = (data: string) => {
    const text = carry + data
    const partial = text.match(PARTIAL)
    carry = partial ? partial[0] : ''
    const complete = partial ? text.slice(0, partial.index) : text

    let last = 0
    for (const m of complete.matchAll(MARKER)) {
      if (command !== null) output += complete.slice(last, m.index)
      last = m.index! + m[0].length
      if (m[1] === 'C') {
        command = Buffer.from(m[2], 'base64').toString('utf8')
        output = ''
      } else {
        ready = true
        if (command !== null) onFinished(`$ ${command}\n${plainText(output)}\n[exit ${m[2]}]`)
        command = null
      }
    }
    if (command !== null) output += complete.slice(last)
    // Long-running commands (logs, `yes`) shouldn't grow memory without bound.
    if (output.length > MAX_OUTPUT * 4) output = output.slice(-MAX_OUTPUT * 2)
  }
  return { feed, idle }
}
