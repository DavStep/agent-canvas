# Agent Client Protocol (ACP) in Agent canvas

ACP ([agentclientprotocol.com](https://agentclientprotocol.com), started by Zed) standardises how a
client app drives a coding agent. The client spawns the agent as a subprocess, and the two speak
JSON-RPC 2.0 over stdio, one message per line. Agent canvas is the client. Any agent that speaks
ACP (Gemini CLI natively, Claude Code and Codex through their adapters, and many others) can run
as a session card on the canvas, beside the hand-built Claude and Codex integrations.

This builds on the official TypeScript SDK, `@agentclientprotocol/sdk` (2.12, protocol v1, the
stable entry point). The SDK supplies the typed connection, `client()` handlers and
`ndJsonStream`. Agent canvas supplies the process, the mapping onto its own chat model, and the
client capabilities.

## How ACP maps onto the app

| ACP | Agent canvas |
| --- | --- |
| An agent: command, args, env | An **ACP agent** in Settings (`settings.json` → `acpAgents`), with a name and an icon (which creature its cards wear). |
| One agent process | One `AcpConnection` per configured agent, spawned on first use and shared by all of that agent's sessions. It stops after 10 idle minutes and when the app quits. |
| `initialize` | Sent once per process. The app advertises `fs.readTextFile`, `fs.writeTextFile` and `terminal`. The agent's `loadSession`, `sessionCapabilities.resume` and `promptCapabilities.image` decide what the app offers. |
| `session/new` | **New session** with that agent, from the dialog or a project orchestrator's `create_chat`. The card id is `acp:<local id>`. The local id maps to the agent's own `sessionId` in `~/.agent-canvas/acp-sessions.json`. |
| `session/load` | Reopening a past session after a restart (or after its process idled out). The agent replays the history as `session/update`s, which become the chat's items. |
| `session/resume` | Used when the agent can resume but not load: the conversation continues, and a notice says the earlier messages cannot be shown. |
| Neither | The chat opens read-only with a notice: "<agent> can't reopen past conversations…". |
| `session/prompt` | `send()`. The request stays open until the turn ends. The chat's `turn` is `running` until then, and the card shows Working. A message sent during a turn is queued (shown as queued), because ACP v1 has no steering. It goes out when the turn ends normally (`end_turn`) or the owner stopped it (`cancelled`). After a limit (`max_tokens`, `max_turn_requests`), a `refusal`, a failed prompt or the process ending, the queued messages are **held, not sent**: a notice says so, and the card is *Needs you · interrupted* until the owner sends again. A cut-off turn must never start the next one on its own. |
| `session/cancel` | Stop. Every permission request still waiting is answered `cancelled`, as the spec requires, and the turn ends with stop reason `cancelled` → "Stopped". |
| `agent_message_chunk` | An `assistant` item, streamed with `append`. A new `messageId`, or a tool call between chunks, starts a new item. |
| `agent_thought_chunk` | A `reasoning` item, streamed. |
| `user_message_chunk` | A `user` item. These come only from `session/load` replays, since the app shows what it sends itself. |
| `tool_call` / `tool_call_update` | A `tool` item. `kind` maps to command / edit / read / search / web / other, and `title` becomes the target. `pending`/`in_progress` show as running, `completed` as done, `failed` as failed. `diff` content becomes `FileDiff`s, text content and `rawOutput` become the output, and an embedded `terminal` streams that terminal's output into the row. |
| `plan` (and `plan_update` items) | `ChatState.plan`: the existing plan strip (pending / inProgress / completed). |
| `current_mode_update`, modes from `session/new` | `ChatState.mode`/`modes` and the Permissions picker, set with `session/set_mode`. |
| `configOptions` with category `model` | `ChatState.models`/`model` and the Model picker, set with `session/set_config_option`. |
| `session_info_update.title` | The card and chat title. |
| `notice` | A `notice` item (info / warn / error). |
| `session/request_permission` | An `approval` item, the same permission card the other providers use. Its options map onto Allow (`allow_once`), Always allow (`allow_always`, labelled "this session") and Deny (`reject_once`, else `reject_always`). The linked tool row shows *waiting*. The card reads *Needs you · Wants permission*, and the Dock badge and quit dialog count it. |
| `fs/read_text_file`, `fs/write_text_file` | Served from disk, **scoped to the session's folder**. Paths are resolved with `realpath`, so a symlink cannot lead out. A path outside asks the owner first with an approval card ("…wants to read a file outside the project folder"). Reads honour `line`/`limit`, and an unsaved buffer is irrelevant here (the app has no editor). |
| `terminal/*` | Real processes in their own process group, run in the session's folder. The command and quoted args go through the login shell (`$SHELL -c`), as Zed does, because agents send whole command lines. A `cwd` outside asks first. Output is kept to `outputByteLimit` from the end (truncated at the front, on a character boundary). `wait_for_exit`, `kill` and `release` follow the spec. Every terminal is killed when the session's process stops or the app quits. |
| Process exit | Open chats it ran say so. Running tools fail, waiting approvals expire, queued messages are held, the card is *interrupted (killed)*, and the next message starts the agent again (and loads the session if it can). |
| `usage_update`, the prompt response's `usage` | `usage_update` (context used / size, cost) is passed to `onUsage`. A prompt response's `usage` (input, output plus thought, cache read and write tokens; unstable in the schema, but sent by adapters) becomes one turn in Settings → Usage, under "ACP agents". Agents that send neither show no usage. |

What carries over unchanged: the card layout, states (working / needs you / idle) and zones by
folder, the chat thread, tool rows, diffs, plan strip, permission cards, Stop, the request queue,
the Dock badge and the quit flow (a busy ACP session is finished in the background like the
others).

Identity: an ACP card wears the creature its agent's icon names. Claude Code through ACP keeps
Clawd, Codex through ACP keeps its own figure, and any other agent gets a recoloured generic
figure. A small badge on the card and in the chat header names the agent ("Gemini CLI"), so a
Claude Code card driven over ACP is still told apart from a native one.

## Configuration

Settings → **ACP agents** lists the agents with what was found on this Mac:

- **Presets.** One click adds a preset; nothing is installed for you.
  - Gemini CLI: `gemini --acp`. Older releases used `--experimental-acp`; edit the args if yours does.
  - Claude Code (ACP): `claude-agent-acp`, from `npm i -g @agentclientprotocol/claude-agent-acp`.
  - Codex (ACP): `codex-acp`, from `npm i -g @zed-industries/codex-acp`.
- **Show in New session.** Every agent's row has this toggle (`showInNewSession` in
  `settings.json`). When it has never been set, it is **off for the Claude Code and Codex
  adapters** and on for every other agent. The native engines come first (see the recommendation
  below), so New session does not list Claude twice. An adapter is recognised by its preset id
  (`claude-acp`, `codex-acp`) or by its program (`claude-agent-acp`, `codex-acp`, also behind a
  path). That holds for adapters added before the toggle existed. Turn an adapter on to test it
  side by side with the native engine, and off to hide it again.
  The toggle decides the same thing everywhere:
  - The New session dialog's tabs list Claude, Codex and the shown agents only.
  - The canvas agent's `canvas_overview` lists only the shown agents, and `start_task` refuses a
    hidden one.
  - The ACP engine refuses to start a new session with a hidden agent, which also covers a project
    orchestrator's `create_chat`.
  Hiding an agent never hides its sessions. Their cards, chats, ⌘K results and composer stay
  as they are, and they reopen (load or resume) and continue as before. ⌘K and the composer have no
  agent list of their own: ⌘K finds sessions, and a composer belongs to one session.
- **Custom agents.** Name, command, args, env (`KEY=value` lines) and icon.
- **Detection.** A bare command is looked up on the login shell's `PATH` (the one the app already
  asks for), and an absolute one is checked directly. A missing command is shown as *Not
  installed* with the install hint. Such an agent cannot be picked in New session, and the canvas
  agent is told it is not installed.

Env values are kept in `settings.json` (0600). Keys belong in the agent's own login or in the
shell profile where possible.

## The canvas agent

`start_task`'s `provider` accepts `claude`, `codex` or an ACP agent shown in New session, written
`acp:<id>` (a bare id such as `gemini` works too). An agent that is not in Settings, is hidden, or
is not installed is refused with a reason, and nothing starts. `canvas_overview` lists the shown
ACP agents and whether each is installed, so the agent can discover them. Project orchestrators (which `start_task` hands work to) get the same choice in
`worker_options` and `create_chat`, so a request like "have Gemini do it" reaches a Gemini card.

## What is missing (in ACP or here)

- **No account or plan limits.** ACP has no account or rate-limit call, so the Profile page keeps
  its Claude and Codex panels, and ACP agents show only *installed / not installed*. Token usage is
  recorded when the agent reports it (see the table above). A usage-limit error ("usage limit",
  "rate limit", "quota", 429) marks the card *interrupted (limit)*. No reset time is known. `authenticate`
  is not driven. An agent that needs a login says so in its error, which the chat shows, and the
  owner logs in with the agent's own CLI.
- **No sessions owned elsewhere.** ACP gives no way to see sessions another client runs, so ACP
  cards are only the sessions started here (owner *here* or *not open*). `session/list` could
  later list an agent's past sessions.
- **No steering, no questions.** A message during a turn waits for the turn to end.
  ACP's (unstable) elicitation is not advertised, so agents fall back to plain messages.
- **Thinking levels** are not mapped. Only `configOptions` of category `model` become the Model
  picker, and other config options are not shown.
- **Images** go as image blocks only when the agent advertises `promptCapabilities.image`.
  Otherwise they are saved as files (the attachments folder) and sent as `resource_link`s with a
  note (`prompt.ts`). Files (`@"path"` mentions, also those an orchestrator passes on from
  `start_task`'s attachments) always go as `resource_link`s.
- **Models and modes before the first session** are not known: an agent says what it offers only
  in `session/new`. The New session dialog shows the agent's own defaults until one session has
  started. After that it offers the models and modes that session reported.
- **History without `session/load`** is not kept by the app. Such a past session shows a notice
  instead of its transcript.
- **MCP servers** are not passed to ACP sessions (`mcpServers: []`), so the canvas agent's own
  canvas tools stay with the Claude/Codex canvas agent.

## Risks

- **Trust.** An ACP agent is an arbitrary program the owner configured. It runs with the owner's
  rights like any CLI. The folder scope applies only to what the agent asks *the app* to do
  (`fs/*`, `terminal/*`). An agent that edits files itself is not confined by it, and its own
  permission prompts are what the owner sees.
- **Spec drift.** ACP is young: the SDK moved to an app-builder API in 2.x, Gemini renamed its
  flag, and v2 is in preview. The SDK version is pinned, the stable v1 entry point only is used,
  and unknown `session/update` kinds are ignored.
- **Agent quirks.** Agents differ in how they use tool-call content (diffs vs text, terminals vs
  `rawOutput`) and in which statuses they send. The mapping takes the union and never fails a turn
  over a field it does not understand.
- **Long-lived processes.** One agent process serves all of its sessions. A crash ends every
  turn of that agent at once (each chat says so). Idle processes are stopped after 10 minutes so
  they do not pile up.
- **Secrets in env.** These are stored in `settings.json`, so see above.

## Recommendation: should Claude and Codex move onto ACP?

**Not now. Keep the native Claude and Codex engines, and keep ACP as the way to add other agents.**
Revisit it in about six months, or when ACP v2 is stable. Then run Claude Code (ACP) and Codex (ACP)
from Settings side by side with the native ones for a few weeks first.

Why not migrate today:

- **The native engines see more than ACP carries.** The Claude and Codex cards read the providers'
  own files. Those files show sessions started in Terminal, VS Code or the desktop apps (owner
  *elsewhere*, "Show in Terminal", Move here). They also give subagents, branches, rate-limit
  windows on the Profile page, interrupted turns with reset times, and usage backfilled from
  transcripts. ACP sees only the sessions this app starts, and it has no account or limits call.
- **Features the app relies on are missing or unstable in ACP v1.** These include steering a running
  turn (Codex queues into the running turn today), questions (`AskUserQuestion`; ACP's
  elicitation is unstable), thinking levels, permission modes with the providers' exact semantics,
  and the canvas agent's in-process MCP tools.
- **The adapters wrap the same SDKs the app already uses.** `claude-agent-acp` drives the Claude
  Agent SDK, and `codex-acp` drives Codex's app server. Going through them adds a process and a
  translation layer, and it loses fidelity (tool kinds, diffs, plan items) without removing any
  dependency.
- **Risk.** The Claude and Codex engines are the most tested part of the app. Swapping their
  transport would put every card, chat and quit-flow test back in play for no gain the owner can
  see.

What would change the answer:

- ACP gains stable session listing for sessions outside this app, elicitation, steering and usage
  or limit reporting.
- Or maintaining the two native engines costs more than the gaps above. If each provider's SDK
  churn keeps forcing engine rewrites, a single ACP engine becomes the cheaper path.

If that happens, migrate one provider at a time, behind a Settings switch:

1. Ship Codex over ACP first, since it already runs as a separate process.
2. Keep the file readers (`server/adapter/`) for cards and ownership, and replace only the chat
   engine.
3. Keep the native engine selectable until the ACP path passes the same engine tests
   (`server/engines/*/engine.test.ts`, run against an adapter) and the e2e chat scenarios.

The ACP engine is built for this: it takes any `ChatEngine` caller, keeps one process per agent,
and maps permissions onto the same approval cards. Migration would be configuration plus parity
work, not a new architecture.

