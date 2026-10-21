# ChainAgent

**Wire AI coding agents together on a canvas.** Drag Claude Code, Codex, Gemini or a plain shell onto a draw.io-style workspace, and each one opens as a real terminal session in a folder you choose. Draw a wire from one agent to another, and when the first agent finishes a turn, its answer is sent to the next one automatically.

ChainAgent is a desktop app (Electron) with a small login server, so a team can use it with accounts an admin manages.

## Features

- **Canvas workspace.** Pan, zoom, minimap. Agent windows can be moved and resized, and you can run several sessions of the same agent (`Claude Code #1`, `#2`, …).
- **Real terminals.** Each window runs the real CLI in a pseudo-terminal (node-pty + xterm.js), in the folder you pick when you drop it. Colors, resizing and clickable links all work.
- **Uses the login already on your machine.** Agents use your existing CLI login (for example `~/.claude`). If a CLI isn't logged in, its normal login flow appears inside the window. ChainAgent never sees or stores your AI credentials.
- **Agents talk through wires, in any direction.**
  - When an agent finishes a turn, its final answer goes to every window it's wired to, as a prompt starting with `From Claude Code #1:`. Multi-line answers arrive as one prompt.
  - Claude Code, Codex, Gemini and Shell can all send and receive.
- **Shells report every command.** A Shell window sends each finished command, with its output and exit code, down its wires. So an agent can see what you (or another agent) ran.
- **Agents can drive a shell, with a safety switch.**
  - When an agent's answer goes into a Shell, only the commands from its ```` ```bash ```` / `sh` / `zsh` / `console` code blocks are used.
  - They're pasted at the prompt, and you press Enter. Turn on that wire's **Auto-run** pill to run them immediately.
  - Commands are only pasted while the shell is idle at its own zsh prompt. If something else is running there (ssh, a REPL, a long command), nothing is pasted and the wire shows *shell busy*. Shells other than zsh show *needs zsh*.
  - Shell → Shell wires aren't allowed.
- **Privacy note:** a Shell wired to an agent sends every command and its output to that agent's provider, including things like `cat .env`. Only wire shells you're comfortable sharing.
- **Loop guard.** A wire loop (A → B → A, or Claude → Shell → Claude) stops after 5 hand-offs, and the wire shows *loop limit reached*.
- **Collapsible sidebar.** It collapses to a slim icon rail, and the agent icons stay draggable. The open/closed state is remembered.
- **Team accounts.**
  - An admin adds people with an email and a temporary password.
  - On first login each person must choose a username and set a new password.
  - Admins can list, disable/enable and reset users. Disabling someone or resetting their password signs them out everywhere immediately.

## How it works

```
┌──────────────── Electron app ─────────────────┐        ┌──── server/ ────┐
│ Renderer (React + React Flow + xterm.js)      │        │ Fastify API     │
│   canvas, agent windows, wires, admin page    │        │ users, sessions │
│                   │ IPC (preload bridge)      │        │ MySQL           │
│ Main process ─────┴──────────────────────     │  HTTPS │                 │
│   • auth: token in OS-encrypted storage ──────┼───────►│ /auth, /me,     │
│   • pty: one process per agent window         │        │ /admin/users    │
│   • hook server on 127.0.0.1 ◄── Claude Stop hook      └─────────────────┘
└───────────────────────────────────────────────┘
```

- Each agent reports a finished turn to a small server on `127.0.0.1` in the main process. It authenticates with a per-launch secret, and none of your own config files are changed:
  - **Claude Code:** `claude --settings <file>` adds a Stop hook (type `http`). Your own Claude settings and hooks still apply, because hooks from `--settings` merge with them.
  - **Codex:** `codex -c 'notify=[…]'` runs a tiny helper on `agent-turn-complete`.
  - **Gemini:** `GEMINI_CLI_SYSTEM_SETTINGS_PATH` points to an `AfterAgent` hook that runs the same helper. Gemini runs hooks only in folders you've trusted in its prompt.
  - **Shell (zsh):** the shell starts with a `ZDOTDIR` that loads your own `.zshenv`/`.zprofile`/`.zshrc`/`.zlogin`, then adds invisible markers around each command (like VS Code's shell integration).
- The helper runs on Electron's own binary as Node, so it needs no extra `node` or `curl`.
- The renderer finds the wires leaving that window and types the message into each target terminal as a single paste.
- The API token lives only in the Electron main process, encrypted with the OS keychain (`safeStorage`). The renderer can't read it.

## Requirements

- Node.js 24+ and npm 11+
- MySQL 8 (or compatible)
- The agent CLIs you want to use, installed and on your `PATH`: `claude`, `codex`, `gemini`
- Linux or macOS (Windows isn't tested yet)

## Getting started

### 1. Database

```sql
CREATE DATABASE chainagent;
CREATE USER 'chainagent'@'localhost' IDENTIFIED BY 'change-me';
GRANT ALL ON chainagent.* TO 'chainagent'@'localhost';
-- for the test suite
CREATE DATABASE chainagent_test;
GRANT ALL ON chainagent_test.* TO 'chainagent'@'localhost';
```

### 2. API server

```bash
cd server
npm install
cp .env.example .env        # set DB_USER / DB_PASSWORD / DB_NAME
npm run migrate
npm run create-admin -- you@company.com 'a-strong-password'
npm start                   # http://127.0.0.1:3100
```

Run the tests with `npm test`. They use the database in `TEST_DB_NAME`, which must end in `_test`, because the tests wipe its tables.

### 3. Desktop app

```bash
npm install
npm run dev
```

The app talks to `http://localhost:3100` by default. Set `CHAINAGENT_API_URL` to use another server.

> **Linux:** if Electron exits with a *SUID sandbox helper* error, either run
> `sudo chown root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox` once,
> or start with `ELECTRON_DISABLE_SANDBOX=1 npm run dev` (less secure).

## Using it

1. Log in. First-time users choose a username and a new password.
2. Drag an agent from the sidebar onto the canvas and pick the folder it should work in.
3. Drag from the right dot of one window to the left dot of another to wire them. The arrow shows the direction.
4. Give the first agent a task. When it finishes, its answer goes down the wire. For wires into a Shell, click **Auto-run** if the commands should run without you pressing Enter.
5. Admins: **Users** in the sidebar opens user management.

## Scripts

| Where | Command | What it does |
|---|---|---|
| root | `npm run dev` | Start the app with hot reload |
| root | `npm run build` | Production build into `out/` |
| root | `npm run typecheck` | TypeScript check |
| server | `npm start` / `npm run dev` | Run the API (dev reloads on change) |
| server | `npm run migrate` | Apply `server/sql/*.sql` |
| server | `npm run create-admin -- <email> <password>` | Create an admin account |
| server | `npm test` | API test suite |

## Status and roadmap

Early but working. Known limits and next steps:

- [ ] Modern UI/UX refresh that fits any desktop size
- [ ] Verify Codex and Gemini hand-offs with real accounts. They're wired and tested with mock turns. Gemini CLI now needs a paid Gemini API key or an enterprise license, and Codex CLI sign-in is offered for paid ChatGPT plans.
- [ ] Shell integration for bash and fish (only zsh reports commands today)
- [ ] Save and restore workspaces (windows, folders, wires)
- [ ] Installers (electron-builder), with node-pty unpacked from asar
- [ ] Login rate limiting; run the API behind HTTPS in production
- [ ] Logging out or quitting ends all running sessions (by design for now)

## Tech stack

Electron 45 · electron-vite · React 19 · React Flow 12 · xterm.js 6 · node-pty · Fastify 5 · MySQL (mysql2) · TypeScript

## License

[MIT](LICENSE) © 2026 Ali Yousefnejad
