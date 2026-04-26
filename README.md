# PearCollab

Real-time P2P collaborative code editing for VS Code — no server, no account required.  
Peers connect directly (or via relay) using [Hyperswarm](https://github.com/holepunchto/hyperswarm) DHT and synchronize edits with [Yjs](https://github.com/yjs/yjs).

---

## Requirements

- **Node.js ≥ 18** — must be on your `PATH` (run `node --version` to check)
- **VS Code ≥ 1.80**
- Internet access (for DHT peer discovery)

---

## Setup

Run this once from the repo root to install all dependencies:

```bash
npm run setup
```

This is equivalent to:

```bash
npm install          # extension dependencies (yjs, ignore, typescript…)
cd sidecar && npm install   # networking sidecar (hyperswarm, protomux…)
```

---

## Running in development

1. Open the `pearcollab` folder in VS Code.
2. Press **F5** (or go to **Run → Start Debugging**).  
   This compiles the extension and opens a new **Extension Development Host** window.
3. In the Extension Development Host window, use the extension as described below.

> If you get a compile error, run `npm run compile` in the terminal first, then try F5 again.

---

## Usage

### Starting a session (host)

1. Click the **PearCollab** icon in the Activity Bar (left sidebar).
2. Click **Start Session**.
3. Enter your display name (saved for future sessions).
4. Enter a room name (any string ≥ 3 chars, e.g. `purple-falcon-42`).
5. Share the room name with your collaborators.

### Joining a session

1. Click the **PearCollab** icon in the Activity Bar.
2. Click **Join Session**.
3. Enter your display name.
4. Enter the exact room name the host shared with you.

### During a session

- **Peers** and their current files appear in the sidebar.
- **Cursors and selections** of other peers are highlighted in your editors.
- Edits are synced automatically via Yjs CRDTs — no conflicts.
- Click **Copy** next to the room name to copy it to clipboard.
- Click **End Session** (or the status bar item) to leave.

### Commands (Command Palette)

| Command | Description |
|---|---|
| `PearCollab: Start Session` | Create a new room |
| `PearCollab: Join Session` | Join an existing room |
| `PearCollab: End Session` | Leave the current session |
| `PearCollab: Copy Room Name` | Copy room name to clipboard |

---

## Architecture

```
VS Code Extension (extension.ts)
        │  stdin/stdout JSON-RPC
        ▼
Sidecar process (sidecar/index.js)
        │  Hyperswarm DHT + Protomux channels
        ▼
     Peers
```

- **Extension**: manages Yjs documents, applies remote edits, renders cursor decorations, drives the sidebar UI.
- **Sidecar**: a plain Node.js process that owns the Hyperswarm socket and relays encoded Yjs updates and presence messages between peers.
- **Yjs**: CRDT-based conflict-free merging of text edits.
- Files matching `.gitignore`, sensitive patterns (`.env`, `.key`, `.pem`), or >10 MB are excluded from sync.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Node.js not found` error | Install Node.js ≥ 18 and ensure `node` is on your PATH |
| Peers can't find each other | Check internet connectivity; DHT requires outbound UDP |
| Session connects but edits don't sync | Make sure both peers have the same file open |
| Status bar shows "relay" | Direct UDP is blocked; connection still works via relay |
| Buttons in sidebar do nothing | Recompile with `npm run compile` and restart the Extension Host |
