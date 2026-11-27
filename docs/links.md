# Links between sessions

One session can wait for others with a prompt queued. When they finish, the app sends that prompt
by itself. A line on the canvas shows each wait. Typical uses:

- "Install the app after all the feature sessions finish."
- "Resume these 11 cut-off sessions, at most 4 at once."

## The model (shared/runs.ts)

A **run** is one queued prompt, held in `QueuedRun`. It has these parts:

- **target**: what gets the prompt. It is one of:
  - `session`: an existing chat.
  - `new`: a planned session (folder, provider, model, effort, mode, title). It is drawn as a card
    whose id is `plan:<run id>` until it starts.
  - `handoff`: a task for the project orchestrator, which is what `start_task` with `after` makes.
- **after**: the sessions it waits for (planned ones included).
- **mode**: `all` (the default) or `any`.
- **prompt**, plus an optional **handOff**, which appends each upstream's last answer as
  "Upstream result from …".
- **attachments**.
- **by**: who made it (owner, agent or orchestrator).
- **state**: `waiting`, `starting`, `started` or `failed`.

A session has at most one pending run. Linking it again adds upstreams to the same run. A link
that would close a loop is refused; `wouldCycle` checks this, counting only pending runs.

Runs live in `dataHome/runs.json` (server/runs/store.ts), apart from the layout. The file also
holds the per-project **max running** caps, keyed by folder (`folderOf`).

## When a run starts (server/runs/evaluate.ts, scheduler.ts)

The scheduler re-evaluates every run against the current session states on every source change
and every 2 s. Each upstream ("edge") is in one of these states:

| Edge | When |
|---|---|
| `working` | It is working, or it was just sent its own queued prompt and has not moved yet. |
| `pending` | It waits on something else: its own run, the owner (permission, question), or a planned session not started yet. |
| `done` | It finished its turn normally: idle, or a reply not looked at yet. |
| `interrupted` | Its turn was cut off. The run shows **blocked: A was interrupted** and waits. |

A link to a card that was already finished counts as done only after a short settle window
(`SETTLE_MS`). This keeps a link made between two quick turns from firing at once.

Once its upstreams are done (all of them, or any one), a run is **queued**. It is sent when:

- its target is free (not working, and not waiting on the owner's permission, question or
  terminal), and
- the project is under its max running cap. Runs are sent oldest first. A session just sent a
  prompt counts as running for `START_GRACE_MS`.

An interrupted target does take its queued prompt: queuing "Continue" is how cut-off sessions
are resumed.

Sending goes through the normal paths in electron/main.ts:

- `sendToChat` for a session, with its own model and permission mode;
- `start` for a planned session;
- `delegateTask` for a handoff.

The run is marked `starting` on disk **before** the send. If the app closes mid-send, the run
comes back as `failed` ("closed while starting"), so a relaunch never sends twice. A failed run
offers **Try again** in the card menu. A target that is busy elsewhere throws `NotYet`, and the
scheduler tries again 10 s later. A started run retires once its session is idle again.

## On the canvas (web/src/links/)

- **Lines** (`Connectors.tsx`) are an SVG on the board. They pan and zoom with it and are redrawn
  every frame while anything moves (card glides, zone moves, entrances). They curve sideways
  between cards side by side, and vertically between cards one above the other. Their style
  depends on state:
  - muted dashed while waiting; the dash flows (`link-flow`, motion.css) while the upstream works;
  - muted solid once that upstream is done;
  - green once the run has started;
  - red when blocked.

  Lines never take the pointer, so a line that crosses a card does not get in the way of
  clicking that card. Hovering either linked card shows the line's **×**.
- **Port**: hovering a card shows a small ring on its right edge. Dragging the ring onto another
  card opens **Run after…** with that link filled in. Dropping it on empty canvas opens
  **New session**. **Queue session** links the new card and opens its chat panel. The panel
  shows the wait and switches to the live conversation when the first message starts.
- **Card menu**: right-click a card, or press the menu key or Shift+F10 on it. The menu offers:
  - **Run after…** (or **Edit what it waits for…**);
  - **Try again**, for a failed run;
  - **Remove the wait**.
- **The dialog** (`LinkDialog.tsx`) sets:
  - the sessions it waits for (searchable);
  - all or any, when there is more than one;
  - the prompt;
  - whether to append their answers.
- **A waiting card** has a dashed border and a "Waiting for …" chip with a queue icon; hovering
  the chip shows the queued prompt. A blocked card has a red border and chip.
- **A planned session** is a quiet card in its folder's zone. Clicking an owner-created card opens its waiting chat. Its card menu can edit the wait.

## Agents

The canvas agent (server/agent/linkTools.ts) has these tools:

- `start_task` with `after` (and `afterMode`, `handOff`);
- `link_sessions` (it asks the owner first);
- `unlink_sessions`;
- `set_max_running`, for a folder or zone. To run a batch at most N at once, set the cap and give
  each session `link_sessions` with `after: []`.

`canvas_overview` lists the queue and the caps. `read_session` shows what a session waits for
and which runs wait on it.

The project orchestrator (server/agent/project.ts) works the same way:

- `create_chat` and `continue_chat` take `after`. A planned chat is answered as `plan:<id>`.
- It has its own `set_max_running`.

Its prompt tells it to sequence work with these tools rather than by polling.

Max running has no on-canvas control yet; only the agents set it.

## Testing

- server/runs/runs.test.ts covers the store, cycles, the trigger, persistence and relaunch.
- server/agent/linkTools.test.ts covers the tools.
- web/src/links/links.test.ts covers the lines, the waits and the curve.
- e2e/links.spec.ts drives the demo with `AGENT_CANVAS_DEMO_TURNS=1`. That setting lets the
  demo's scripted turns move the cards, so finishing one card can start the next.
