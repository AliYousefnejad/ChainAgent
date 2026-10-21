# ChainAgent

**Wire AI coding agents together on a canvas.** Drag Claude Code, Codex, Gemini or a plain shell onto a draw.io-style workspace, and each one opens as a real terminal session in a folder you choose. Draw a wire from one agent to another, and when the first agent finishes a turn, its answer is sent to the next one automatically.

ChainAgent is a desktop app (Electron) with a small login server, so a team can use it with accounts an admin manages.

## Features

- **Canvas workspace.** Pan, zoom, minimap. Agent windows can be moved and resized, and you can run several sessions of the same agent (`Claude Code #1`, `#2`, …).
- **Real terminals.** Each window runs the real CLI in a pseudo-terminal (node-pty + xterm.js), in the folder you pick when you drop it. Colors, resizing and clickable links all work.
- **Uses the login already on your machine.** Agents use your existing CLI login (for example `~/.claude`). If a CLI isn't logged in, its normal login flow appears inside the window. ChainAgent never sees or stores your AI credentials.
- **Agents talk through wires.** When a Claude Code session finishes a turn, its final answer goes to every agent it's wired to, as a prompt starting with `From Claude Code #1:`. Multi-line answers arrive as one prompt.
- **Loop guard.** A wire loop (A → B → A) stops after 5 hand-offs, and the wire shows *loop limit reached*.
- **Safe wiring rules.** Only agents that report when they finish can send. Shell windows can't receive, so AI output is never run as shell commands.
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

- Each Claude Code window starts with `claude --settings <file>`, which adds one **Stop hook** of type `http`. When Claude finishes a turn, the hook POSTs `last_assistant_message` to a local server in the main process. The request is authenticated with a per-launch secret.
- Your own Claude Code settings and hooks still apply, because hooks from `--settings` are merged with them.
- The renderer finds the wires leaving that window and types the message into each target terminal as a single pasted prompt.
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
3. Drag from the right dot of one Claude Code window to the left dot of another to wire them.
4. Give the first agent a task. When it finishes, its answer goes down the wire.
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
- [ ] Finish signals for Codex and Gemini, so they can send down wires as well as receive
- [ ] Save and restore workspaces (windows, folders, wires)
- [ ] Installers (electron-builder), with node-pty unpacked from asar
- [ ] Login rate limiting; run the API behind HTTPS in production
- [ ] Logging out or quitting ends all running sessions (by design for now)

## Tech stack

Electron 45 · electron-vite · React 19 · React Flow 12 · xterm.js 6 · node-pty · Fastify 5 · MySQL (mysql2) · TypeScript

## License

[MIT](LICENSE) © 2026 Ali Yousefnejad
