# ChainAgent

**Wire AI coding agents together on a canvas.** Drag Claude Code, Codex, Gemini, OpenCode or a plain shell onto a draw.io-style workspace, and each one opens as a real terminal session in a folder you choose. Draw a wire from one agent to another, and when the first agent finishes a turn, its answer is sent to the next one automatically.

ChainAgent is a desktop app (Electron) with a small login server, so a team can use it with accounts an admin manages.

## Features

- **Canvas workspace.** Pan, zoom, minimap. Agent windows can be moved and resized, and you can run several sessions of the same agent (`Claude Code #1`, `#2`, …).
- **Real terminals.** Each window runs the real CLI in a pseudo-terminal (node-pty + xterm.js), in the folder you pick when you drop it. Colors, resizing and clickable links all work.
- **Uses the login already on your machine.** Agents use your existing CLI login (for example `~/.claude`). If a CLI isn't logged in, its normal login flow appears inside the window. ChainAgent never sees or stores your AI credentials.
- **Agents talk through wires, in any direction.**
  - When an agent finishes a turn, its final answer goes to every window it's wired to, as a prompt starting with `From Claude Code #1:`. Multi-line answers arrive as one prompt.
  - Claude Code, Codex, Gemini, OpenCode and Shell can all send and receive.
- **Shells report every command.** A Shell window sends each finished command, with its output and exit code, down its wires. So an agent can see what you (or another agent) ran.
- **Agents can drive a shell, with a safety switch.**
  - When an agent's answer goes into a Shell, only the commands from its ```` ```bash ```` / `sh` / `zsh` / `console` code blocks are used.
  - They're pasted at the prompt, and you press Enter. Turn on that wire's **Auto-run** pill to run them immediately.
  - Commands are only pasted while the shell is idle at its own zsh prompt. If something else is running there (ssh, a REPL, a long command), nothing is pasted and the wire shows *shell busy*. Shells other than zsh show *needs zsh*.
  - Shell → Shell wires aren't allowed.
- **Privacy note:** a Shell wired to an agent sends every command and its output to that agent's provider, including things like `cat .env`. Only wire shells you're comfortable sharing.
- **Loop guard.** A wire loop (A → B → A, or Claude → Shell → Claude) stops after 5 hand-offs, and the wire shows *loop limit reached*.
- **Prompt box.** A floating, colourful prompt box at the bottom of the canvas.
  - Your prompt goes to the **chain start** (a window with outgoing wires and none coming in), or any window you pick, then flows through the wires.
  - Enter sends; Shift+Enter adds a new line.
- **Plan mode.** Switch on **Plan** and describe the whole task.
  - Claude (with your existing login, **read-only**: only `Read`/`Glob`/`Grep`, no MCP servers) splits it into steps for the windows on the canvas.
  - You review the steps (edit text, reassign windows, delete steps), then press **Run plan**.
  - Steps run in order. A step starts when the steps it depends on are done, and agent steps receive those steps' results. Shell steps run exactly the commands you reviewed.
  - Wires are paused during a plan run, so nothing is sent twice.
- **Team mode: Claude builds the team.** Switch the prompt box to **Team** and describe the job.
  - Claude (read-only) decides **how many agents** are needed (up to 5) and **which role** each plays, e.g. Architect → Coder → Test runner (Shell) → Reviewer. It also decides how they're wired and writes the first prompt.
  - The **Use** chips limit which agent types it may pick (Claude is always on; it leads).
  - You review the team (edit roles and instructions, remove agents, toggle Auto-run, tick *sub-agents* for big implementation roles), pick the project folder, then press **Create & run**.
  - The windows appear wired together. Claude and OpenCode windows get their role in their system prompt; Codex and Gemini get it in front of each message.
  - The first prompt is sent once **every** window is ready. A new Claude window first asks whether you trust the folder: choose **"Yes, I trust this folder"** (the default is "No, exit").
- **Voice input.** Click the mic, speak, click again: the text appears in the box.
  - Speech is recognised **on your machine** with Whisper (small, 8-bit), so nothing is sent anywhere. The model (~250 MB) downloads once on first use.
  - Switch the language with the **EN / FA** chip.
- **Collapsible sidebar.** It collapses to a slim icon rail, and the agent icons stay draggable. The open/closed state is remembered.
- **Team accounts.**
  - An admin adds people with an email and a temporary password.
  - On first login each person must choose a username and set a new password.
  - Admins can list, disable/enable and reset users. Disabling someone or resetting their password signs them out everywhere immediately.
  - Anyone can change their own password with the key icon in the sidebar. Their other sessions are signed out.
- **Insights for managers** (GitLab).
  - Link your projects (any self-hosted GitLab or gitlab.com) with a read-only token. Commits, merge requests, approvals and MR comments are synced every 30 minutes, or on **Sync now**.
  - **People:** per person and date range: commits and lines added/removed (default branch, merge commits excluded), MRs opened and merged, approvals given, MR comments.
  - **Unmatched authors** lists commit emails that belong to nobody yet. Link one to a person with one click.
  - **Projects:** totals per project. **Merge requests:** list with links to GitLab.
- **Roles.**
  - **Admin:** everything, including setting roles.
  - **Manager (Head):** Insights for everyone, projects, and managing members (add, disable, reset).
  - **Member:** sees only their own numbers, with a note on what managers can see.
- **Sign-in protection.**
  - Login says plainly whether an email has an account.
  - **5 wrong passwords in a row lock that account for 15 minutes**, including attempts sent at the same time. An admin's *Reset password* unlocks it immediately, and the Users page shows a *Locked* badge.
  - **20 failed sign-ins from one network address in 15 minutes** block that address for the rest of the window, which also stops guessing emails. This counter is kept in memory, so it resets when the API restarts.
  - Behind a reverse proxy (nginx), set `TRUST_PROXY` to the proxy's address, e.g. `TRUST_PROXY=127.0.0.1` for nginx on the same server, so each client's real address is used. Don't trust every hop: clients could then fake their address.

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
  - **OpenCode:** `OPENCODE_CONFIG_CONTENT` adds a small plugin (merged with your own OpenCode config). On `session.idle` it sends the final reply, skipping sub-agent sessions and failed turns. A team member's role is added through OpenCode's `instructions`.
  - **Shell (zsh):** the shell starts with a `ZDOTDIR` that loads your own `.zshenv`/`.zprofile`/`.zshrc`/`.zlogin`, then adds invisible markers around each command (like VS Code's shell integration).
- The helper runs on Electron's own binary as Node, so it needs no extra `node` or `curl`.
- The renderer finds the wires leaving that window and types the message into each target terminal as a single paste.
- The API token lives only in the Electron main process, encrypted with the OS keychain (`safeStorage`). The renderer can't read it.

## Requirements

- Node.js 24+ and npm 11+
- MySQL 8 (or compatible)
- The agent CLIs you want to use, installed and on your `PATH` and logged in: `claude`, `codex`, `gemini`, `opencode`
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
# for Insights: a key that encrypts GitLab tokens at rest (put it in .env as CHAINAGENT_SECRET_KEY)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
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
5. Managers: **Insights** → **Projects** → add your GitLab project (URL, `group/project`, and a token with the `read_api` scope, which can be a project or group access token). Then link people's GitLab usernames and commit emails on **Users**, or with **Link to…** under Unmatched authors.
6. Or switch the prompt box to **Team**, describe the job, review the team Claude proposes, and press **Create & run**.
7. Admins and managers: **Users** in the sidebar opens user management.

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
- [ ] Let shell plan steps use earlier steps' results (today they run fixed commands)
- [ ] Live dictation while you speak, and automatic language detection
- [ ] Save and restore workspaces (windows, folders, wires)
- [ ] Installers (electron-builder), with node-pty unpacked from asar
- [ ] Run the API behind HTTPS in production (deployment guide)
- [ ] Logging out or quitting ends all running sessions (by design for now)

## Tech stack

Electron 45 · electron-vite · React 19 · React Flow 12 · xterm.js 6 · node-pty · Transformers.js (Whisper, ONNX) · Fastify 5 · MySQL (mysql2) · TypeScript

## License

[MIT](LICENSE) © 2026 Ali Yousefnejad
