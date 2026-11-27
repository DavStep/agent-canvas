# Agent canvas: mockup brief (shared by all visual directions)

## What this is
A static, single-screen mockup of a desktop tool: a spatial canvas where every card is one
running Claude Code session. The owner runs about 11 sessions at once and wants to see at a
glance which are working, which are idle, and which are waiting on them. The mockup exists so
the owner can choose a visual direction. It must look like a finished, designed product, not a
generic AI-generated dashboard. Craft matters more than feature count.

## Deliverable
One self-contained HTML file at the path given in your task. Static: inline CSS, inline SVG,
no frameworks, no build step, no external scripts. JS is not needed; do not add any beyond
what your direction explicitly asks for. Web fonts: at most two families from Google Fonts,
always with sensible fallbacks. Designed for a 1440x900 viewport, no page scroll
(`html,body{height:100%;overflow:hidden}`), and it must not break between 1280 and 1680 wide.

## Screen layout (same structure in every direction)
1. Top bar (slim): product name "Agent canvas"; counts "11 sessions · 3 working · 2 need you";
   on the right, quiet text controls: Zones, Fit, 100%.
2. "Needs you" strip directly under the top bar, with two entries:
   - "Enable account deletion approvals on Hostly": asks permission to run a command, 2m
   - "Purchases unavailable in production": finished, waiting for your reply, 14m
3. The canvas (fills the rest, left of the side panel): a pannable-looking surface with four
   zones placed spatially, at different sizes, like things arranged on a desk. Not a kanban,
   not equal columns, not a rigid grid of zones. Cards inside a zone are tidy.
   No connector lines or arrows anywhere.
4. Side panel on the right (about 360px), open for the selected card.

## Zones and cards (use exactly this content)
Zone "garden-sim" (5 cards)
- Reconnection dialog and animation issues | WORKING | "Editing ReconnectDialog.tsx" | fix/reconnect | 6m in this turn
- Enable account deletion approvals on Hostly | NEEDS YOU (permission) | "Wants to run: ssh hostly systemctl restart api" | main | 2m
- Purchases unavailable in production | NEEDS YOU (reply) | "Found it: product IDs differ between sandbox and production" | main | 14m
- Preview improvement suggestions | IDLE | last active 3h ago | main
- Codex usage credits analysis | IDLE | last active yesterday | main

Zone "garden-dashboard" (4 cards)
- Database visualization dashboard | WORKING | "Running tests" | feat/db-viz | 11m in this turn
  This card has two subagents, shown nested inside or tucked under it as small child items:
  "schema-explorer" (working) and "chart-builder" (done).
- Dashboard as MCP | IDLE | last active 1h ago | main
- Agent setup 3D graph visualization | IDLE | last active 5h ago | main
- trying to analyze the progression shown | IDLE | last active 2d ago | main

Zone "sailcloth-io" (1 card)
- Deploy changes | IDLE | last active 40m ago | main

Zone "No folder" (1 card)
- System discussion with friend notes | WORKING | "Laying out visual directions" | 1m in this turn
  This is the SELECTED card; the side panel shows it.

## Card anatomy
Status mark, title (up to two lines), one line of current activity or "last active", and a
quiet footer with branch and time. The three states must be distinguishable without relying
on colour alone (shape, fill, label or motion as well). NEEDS YOU is the loudest thing on the
screen; IDLE recedes; WORKING is visibly alive but calm.

## Side panel content (selected card)
- Title: System discussion with friend notes
- Rows: Folder "No folder" · Model "Fable 5.2" · Started "17:42" · State "Working, 1m"
- Section "You last said": Standalone canvas
- Section "Its last answer" (two short paragraphs):
  "The check is back, and it narrows the choice to two real options."
  "I recommend the standalone canvas because all 11 of your live sessions are desktop-app
  sessions; the other route makes you change how you work before you get any value."
- Actions: primary "Open in Claude", secondary "Copy resume command"

## Quality bar (all directions)
- A deliberate type scale (three or four sizes), consistent 4px spacing rhythm, aligned edges.
- Text contrast at least 4.5:1 for anything meant to be read; idle items may be quieter but
  still legible.
- Restraint: one accent for attention, zone colours muted and used sparingly.
- Banned: emoji as icons, purple/blue gradients, gradient text, glassmorphism, neon glow,
  stacked drop shadows, decorative blobs, pill badges on everything, centered hero text,
  lorem ipsum, any extra content not listed above.
- Hover state on cards (CSS only). Any motion must respect `prefers-reduced-motion`.
- Before you finish, reread your file once as a critical designer: fix overlaps, clipped
  text, misaligned baselines, and anything that looks default or generic.

## Report back
Under 120 words: the file path, fonts used, the palette (hex list), and anything you were
unsure about. Do not paste the HTML.
