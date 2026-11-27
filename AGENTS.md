# Agent Canvas

For tasks that design, change, or review the Agent Canvas interface or its interactions, read and apply the `agent-canvas-ui` skill before starting. This includes requests phrased in terms of the user’s experience, such as making a session card easier to scan or a panel easier to navigate. The personal installation is at `~/.codex/skills/agent-canvas-ui/SKILL.md`.

For tasks that add or change motion (entrances, exits, hover and press feedback, the view travelling, anything that moves or glows), read `docs/motion.md` first and keep new motion in `web/src/motion.css` with the tokens in `web/src/theme.css`. In Claude Code the `canvas-motion` agent (`.claude/agents/canvas-motion.md`) does this work.

## No side stripes

Never use left-edge (or right-edge) accent bars or stripes for selection, status or emphasis: no coloured `border-left` / `border-inline-start`, no inset box-shadow with a sideways offset (`inset 2px 0 0 …`), no thin `::before`/`::after` bar, no absolutely positioned stripe. The owner dislikes them. Use these instead: a selected row gets a subtle filled background on the rounded row (`var(--sel-fill)`), a hovered row a fainter one (`var(--row-hover)`), keyboard focus a `:focus-visible` outline in `var(--ring)`, and state a dot, an icon or a word. `web/src/noSideStripes.test.ts` (part of `npm test`) enforces this across `web/src`, inline styles and `mockups/`; a neutral 1px divider between regions or a resize grip goes in its allow-list with a reason, never a coloured accent.
