# Live checks

Run by the owner and the controller after the final review, on the owner's real accounts
(spec "Testing", live). Use a scratch folder (say `~/agent-canvas-live`) and one-line messages.
Each line says what to do, then what counts as a pass. Anything that fails becomes a ledger
finding.

## Before you start

1. Log in to Claude Code once: run `claude`, then `/login`; afterwards `claude auth status`.
   Pass: it reports `loggedIn: true`.
2. Install and open the app: `npm ci && npm run install-app`, then open Agent canvas from
   Spotlight (a Dock launch, not a terminal). Pass: the canvas shows your sessions, and Codex
   cards have no "Codex not found" banner.

## Claude, started here

3. ⌘N → Claude, the scratch folder, default model, mode Ask; send "Say hi in five words".
   Pass: a card appears in the folder's zone, the chat opens and the reply streams in.
4. Ownership by pid: while that session runs, check its file in `~/.claude/sessions/` (read
   only): its `pid`'s parent (`ps -o ppid= -p <pid>`) is Agent canvas's main process
   (`pgrep -f "Agent canvas.app/Contents/MacOS/Agent canvas$"`). Pass: they match, and the card
   and chat show it as run here (composer enabled, no read-only banner).
5. Send "Run `ls` in this folder". Pass: an approval card appears with the command; Allow runs
   it and the tool row shows the output.
6. Send "Ask me a multiple-choice question about colours, using your question tool". Pass: a
   question card appears; answering it lets the turn finish.
7. Send "Count slowly to 50, one number per line" and press Stop mid-reply. Pass: the reply
   stops and the turn goes idle with no red error notice. Record the aborted reason Claude
   gives for the interrupted turn (the notice text, or the result's `subtype` and error)
   verbatim.
8. Pick another model in the composer and send "Which model are you?". Pass: the reply comes
   from the new model and the picker keeps it after reopening the chat.
9. Send one more message, then read the session's transcript tail
   (`tail -c 4000 ~/.claude/projects/<folder>/<session>.jsonl`). Pass: the user record for that
   message carries the same `uuid` the app sent (shown as the user item's id; note whether the
   transcript kept it or wrote its own).

## Codex, started here

10. ⌘N → Codex, the scratch folder, default model, preset Auto; send "Say hi in five words".
    Pass: the card appears and the reply streams in.
11. Send "Run `ls` in this folder" with preset Read only. Pass: an approval card appears;
    Allow runs it and the output shows.
12. Send something that makes Codex ask (e.g. "Ask me which file to create before creating
    it"). Pass: a question card appears and answering it continues the turn (if Codex does not
    ask, record that and move on).
13. Stop a long reply, then change the model and send again. Pass: Stop ends the turn with a
    "Stopped" notice; the next turn uses the new model.

## Existing sessions resumed here

14. Open an existing idle Claude session (one no other program has open) and send "Reply with
    OK". Pass: it resumes with its history, the reply arrives, and `claude --resume <id>` in a
    terminal later shows the same conversation.
15. Do the same with an existing idle Codex chat. Pass: it resumes, replies, and the Codex app
    shows the new turn afterwards.

## Open in another app

16. Open a Claude session in the Claude app, then open the same card here. Pass: within 2 s the
    chat shows "Open in another app — read-only here", the composer is off, and messages written
    in the Claude app appear here live.
17. Close it in the Claude app, then press Move here. Pass: Move here succeeds, the chat becomes
    writable, and a message sent here gets a reply; nothing was written here before that.

## Profile and usage

18. Open the profile page. Pass: each provider's email and plan match their own apps, and the
    5 h and weekly usage numbers match Claude's `/usage` and Codex's `/status` within a point
    or two.
19. Record the shapes behind it while signed in: the Claude `accountInfo()` fields
    (`email`, `subscriptionType`, `tokenSource`, `apiKeySource`, `apiProvider`) and the usage
    call's `rate_limits` windows. Pass: the profile shows email and plan, and its windows have
    labels and reset times (not "Not reported").
20. Let a Claude turn produce a `rate_limit_event` (any turn near a limit, or check the SDK
    debug log). Pass: `utilization` is a 0–1 fraction and `resetsAt` is in seconds since the
    epoch, as the engine assumes (the profile's percent and reset time match `/usage`). If it is
    already a percent or in milliseconds, that is a finding.

## Quit with a running turn

21. Start a long turn in one chat and leave an approval pending in another, then press ⌘Q.
    Pass: one dialog lists both by title, "running" and "waiting for you", with Cancel chosen.
22. Press Cancel. Pass: both sessions keep going; ⌘Q again shows the dialog again (once, even
    if you also choose Quit from the Dock meanwhile).
23. ⌘Q and Quit. Pass: the app exits within a few seconds, no `claude` or `codex app-server`
    process it started is left (`pgrep -fl "claude-agent-sdk|codex app-server"`), and both
    sessions resume afterwards with everything said before the quit.
24. Close the window (red button) with a turn running. Pass: the app stays in the Dock, the
    turn finishes, and clicking the Dock icon brings the window back.

## Needs you from this app's own approvals

25. In a Claude chat run here, leave an approval pending (step 5's "Run `ls`") and look at the
    session's own file in `~/.claude/sessions/` (read only) while `canUseTool` waits. Record
    whether its `status` says `waiting` (with a `waitingFor`) or stays `busy`. Pass either way:
    the card shows "Needs you" (the app adds it from its own engine); the answer tells whether
    the provider's file alone would have been enough.
26. In a Codex chat run here, leave an approval pending (step 11). Pass: within a second or two
    its card shows "Needs you", the rail lists it under Needs you, and the Dock badge counts it;
    answering clears all three.

## Started from the Dock or Spotlight

27. Quit the app, then open it from Spotlight (not a terminal). Start a Claude session and ask
    it to run `node -v` and `which npx`. Pass: both print a version and a path (Homebrew or
    nvm), and `/mcp` in that session (or its tool list) shows your user MCP servers connected,
    including any started with `npx` or `uvx`. Do the same in a Codex chat.
