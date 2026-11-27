# Motion on the canvas

How things on Agent canvas arrive, answer and leave, and how to add motion that matches. Read this
before animating anything; read `web/src/motion.css` beside it, since that file is the system.

Motion here has one job: tell the owner what just changed and where to look. A card that needs you
rings once and then glows; a dialog rises from where the page was; the view travels to the card you
jumped to, so you know where on the desk it is. If a motion does not say something like that, it
does not go in.

## Where it lives

| Piece | File |
|---|---|
| Tokens: easings, durations, stagger step | `web/src/theme.css` (`--ease-*`, `--t-*`, `--stagger`) |
| Every entrance, exit, hover, press, loop and keyframe | `web/src/motion.css` (loaded last) |
| The view travelling (Fit, jump to a card, zoom reset) | `glide` in `web/src/canvas/usePanZoom.ts` |
| Cards moving to a new slot instead of arriving again; a removed card's exit | `web/src/canvas/cardGlide.ts`, run by `Canvas.tsx` after every render |
| Exits for surfaces React unmounts (the dialogs) | `web/src/useClosing.ts` plus `.is-closing` in `motion.css` |
| Exits for side panels (the chat panel, the preview, the project explorer), and "it just opened" | `web/src/useLingering.ts` (`Lingering`, `useLingering`, `useArriving`) plus `.is-closing` and `.is-*-opening` in `motion.css` |
| How far open a side is: the chat panel's column, a dock's width | `--panel-open` and `--dock-open`, registered in `web/src/theme.css`, used in `app.css`, `chat.css`, `explorer.css` |
| The canvas agent's orb becoming its panel and back | `web/src/agent/morph.ts` (the frames and the layer), `web/src/agent/useOrbFlight.ts` (when, and what the page hides meanwhile) |
| Stagger order | `--i` set inline by `Zone.tsx` (zone index) and `Card.tsx` (card index in its zone); rows in the explorer take theirs once, when they arrive (`web/src/explorer/cascade.ts`) |

`motion.css` has three parts. **Feel** is how controls look at rest, hovered, pressed and focused,
and is always on. **Motion** is everything that moves, inside
`@media (prefers-reduced-motion: no-preference)`. **Quiet** stops live-looking motion while the
reader is unreachable (`.app.is-stale`).

## Tokens

| Token | Value | Use it for |
|---|---|---|
| `--ease-snap` | quick start, long soft landing | things that travel: zones gliding, the panel, menus, thread items |
| `--ease-spring` | lands a little past its mark | things that arrive or answer a press: cards, dialogs, buttons, counters |
| `--ease-out` | plain ease-out | colour, border and shadow fades |
| `--ease-in` | accelerates away | exits only |
| `--t-fast` 120 ms | | hover colour |
| `--t-base` 180 ms | | press, small state changes |
| `--t-slow` 280 ms | | small entrances (a row, a banner) |
| `--t-enter` 340 ms | | main entrances (card, toast, counter pop) |
| `--t-exit` 140 ms | | every exit; must match `EXIT_MS` in `useClosing.ts` |
| `--t-panel` 320 ms, `--t-panel-exit` 200 ms | | a side panel travelling its own width in and out; the exit must match `PANEL_EXIT_MS` in `useLingering.ts` |
| `--stagger` 34 ms | | delay per card; zones use 55 ms; both are capped (10 cards, 8 zones) |
| `--stagger-row` 16 ms | | delay per row in a list (the explorer's tree, the Git changes, the activity log), capped at 10 rows, so the last row starts within 160 ms |
| `--t-wait` 160 ms | | how long a read may take before the page says it is loading; see "Lists and loading" |

Exits are always shorter than entrances. Nothing the owner is waiting on takes longer than about
400 ms; the view's trip is 360 ms (`GLIDE_MS`). The one longer thing is the agent orb's flight
(480 ms out, 420 ms home, `FLIGHT_MS` in `morph.ts`), and the panel under it takes typing from the
first frame.

## The vocabulary

Reuse these keyframes before writing a new one.

| Keyframe | Says | Used by |
|---|---|---|
| `card-in`, `zone-in` | this is new on the desk | cards that are really new (staggered), zones |
| `card-out` | this left the desk | the copy a removed card leaves behind |
| `rise`, `drop-in`, `step-in`, `reveal` | this row arrived (from below, above, the left, or unfolded) | thread items, waiting tags, tool rows and live calls, opened details |
| `bubble` | you sent this | your own message |
| `menu-in`, `dialog-in` / `dialog-out`, `toast-pop` | a surface opened or closed | menus, dialogs, undo toast |
| `panel-in` / `panel-out` | the panel came into focus, or left | the chat panel, on top of the slide its column gives it |
| `dock-in` / `dock-out` | a dock opened beside the canvas, or closed | a preview docked left, the project explorer and the file opened beside it: the width eases, so the canvas gives way (the preview beside the chat does the same with a transition, see "Side panels") |
| `unfold`, `turn-in` | this opened under its heading | the preview's controls, and the chevron that closes them |
| `turn` | asked again | the explorer's Reload arrow, once for each press |
| `pop` | this number changed | zone count, "need you" count, the waiting row's counts |
| `wake`, `settle` | this control is now live or chosen | Send and Start becoming ready, the chosen segment or option |
| `ripple`, `ask-ring` | look here, once | a card turning needs-you or done, an approval arriving |
| `halo` | still waiting on you | needs-you cards, for as long as they wait |
| `breathe` | still going | Stop while a turn runs; a running tool call's dot (the row itself stays still: no bar, no glow); the Git button whose action is running; the shapes standing in for a list that is still being read |
| `link-flow` | the session this waits for is still working | a link line's dash, flowing toward the card that waits (docs/links.md); still once done, under reduced motion, and when the reader is stale |
| `nudge` | that did not work | error lines |
| Provider portraits | idle, working, or attending to the pointer | hovering the card turns the portrait toward the viewer and pauses typing at the computer until the pointer leaves |

## Rules that keep it working

No motion or state ever arrives as a stripe down one side of a row, card or panel (a "left accent
bar"): the owner dislikes them. Selection, hover, running and attention show as a fill, a ring, a
glow around the whole shape, a dot or a word. See "No side stripes" in `AGENTS.md`;
`web/src/noSideStripes.test.ts` fails on any that creep in.

1. **Position and motion use different properties.** A zone's place and a dragged card's offset
   are the `translate` property (inline). Keyframes and states use `scale`, `rotate`, `opacity`,
   and `translate` only on elements that do not own one. The provider portrait follows the pointer within its fixed frame.
   This is why a card can be lifted, tilted and dragged at once, and why a zone can scale about its
   own middle wherever it sits. Never put `translate` in a keyframe that runs on `.zone`.
2. **Loops move by opacity and scale only**, on a pseudo-element when a glow is involved (the halo
   is a static shadow whose opacity breathes). One-shots on a single element may repaint
   (`ask-ring`). Every loop marks something still going on (working, waiting on you, a turn that
   can be stopped, reconnecting, loading); a loop that marks nothing does not go in.
3. **Motion never changes layout on the board.** Sizes are measured with
   `offsetWidth`/`offsetHeight` to place zones and stack cards; animating width, height, margin or
   padding there would feed back into that. Entrances in the thread stay within its bottom
   padding, so following the newest message is undisturbed. Outside the board a few things do
   change size, each in a way that costs one cheap layout a frame: the page's panel column and a
   dock's width (see "Side panels"), and one small row that folds (see "Folding").
4. **State changes replay by remounting.** A counter that should pop when it changes gets
   `key={value}`; the current-activity line is keyed by its text. Adding a class restarts an
   animation only if the animation's name is new to the element, which is how a card rings when it
   turns needs-you without replaying its entrance (`card-in` stays first in the list).
5. **What stays, moves; only what is new enters, and only what is gone exits.** When a zone
   restacks or a card changes zone, React draws the card in a new element. `cardGlide.ts` reads
   the board after every render: a card it has seen before glides from where it was drawn to its
   new slot (FLIP, 320 ms, picking up mid-way if it was already gliding, and from the pointer if
   it was just dropped) and is marked `data-moved`, which turns off its entrance and the cues it
   already played (`data-quiet`, `data-still`). A card it has not seen plays `card-in`. A card
   gone from the whole board leaves a copy of itself for `card-out`. Never fade or scale a card
   that is only changing place. With reduced motion cards jump and nothing is left behind.
6. **The view travels; the owner's hand does not wait.** `fit`, `centerOn` and `zoomTo` glide; a
   wheel or a drag stops the trip where it is; panning, wheel zoom and dragging are never eased.
   The first framing of a fresh board is instant. A hidden window, or reduced motion, jumps.
7. **Exits need help.** Surfaces unmount when closed, so an exit needs one of two things. A
   surface that closes itself (a dialog, a row with its own ×) uses `useClosing(onClose)`: it sets
   `closing`, the surface takes `.is-closing`, and `onClose` runs after `EXIT_MS`. A surface the
   page's state opens and closes (a side panel: Esc, ×, Back, another chat, its session gone) is
   wrapped in `Lingering` instead; see "Side panels". Small things (menus, toasts) just go.
8. **Reduced motion keeps the information.** Everything that moves is inside the media query; the
   amber edge, the state line and the selection outline say the same thing without it. Do not put
   meaning only in a motion.
9. **Stale means still.** Anything that looks live gets a line in the Quiet block.
10. **Colour keeps its job.** Amber is "needs you", green is live or done, the highlight (purple)
   is focus and selection. Glows follow the same rule: the composer's focus ring is the highlight,
   an approval's ring is amber.

## Side panels

The chat panel, a docked preview and the project explorer open beside the canvas, and the canvas
gives way. All three work the same way.

- **The width is a number.** The chat panel's grid column is multiplied by `--panel-open`, a
  dock's flex basis (and the gap beside it) by `--dock-open`: registered `<number>` properties,
  so a transition or a keyframe can ease them from 0 to 1. The canvas narrows and widens in the
  same movement, and nothing else is animated to make room. The chat panel keeps its full width
  while its column is narrower and the page clips it (`overflow-x: clip`, which cannot be
  scrolled sideways by a focused field), so the slide costs the conversation one layout, not one
  a frame. Dragging a panel's edge is never eased: it changes `--panel-w`, not `--panel-open`.
- **Entering is opening, not appearing.** The entrance plays only while `.app` carries
  `.is-panel-opening`, `.is-preview-opening` or `.is-explorer-opening` (`useArriving`, about one
  entrance long). One chat taking another's place in an open panel is not an opening: the panel
  stays, and the new header and conversation, which are keyed by the chat, fade and rise in.
  The same goes for a preview that follows the chat to another session, and for the explorer
  moving to another zone's folder.
- **Leaving is lingering.** `Lingering` (or `useLingering`) keeps the last element it drew for
  `PANEL_EXIT_MS` with `closing` set; the component adds `.is-closing` and `inert`, and the exit
  keyframes run on the real element with the scroll place and draft it closed with. The page's
  state has already moved on: focus is back on the canvas, the hash is clear, and tests see no
  panel by role. A panel reopened while it leaves is the same element, no longer closing. With
  reduced motion nothing lingers.
- **The preview beside the chat slides out from under it.** The header's preview toggle (or
  ⇧⌘P) opens it; it starts collapsed for every session. Docked right it keeps its whole width:
  `--dock-open` sets how much room it takes and how much of it the clip shows, so it comes out
  from the chat's edge while the canvas gives way, and goes back under it, shorter, when closed.
  It is a transition on `--dock-open` (entering from `@starting-style` while `.app` is
  `.is-preview-opening`), not keyframes, so a toggle pressed mid-way turns it round from where
  it is.
- **The native page follows, or waits.** The Browser tab is a native view laid over a frame; it
  cannot fade or scale with the page. Beside the chat, where the page only slides and is cropped,
  `BrowserTab` places it every frame while the window's transition runs (the area beside the chat
  is its clip, so the page keeps its layout size and never reflows mid-way). Anywhere else
  (docked left, on the canvas, in a zone) `PreviewWorkspace` hides it while its window plays an
  entrance or an exit (`moving`) and places it once the window stands still.
- On the board a preview is a thing on the desk, not a side: a tile placed on the canvas or
  opened in a zone plays `card-in`, a closed one `card-out` in its place before its row takes
  over, and the row itself arrives and leaves the same way. Zone layout and drop targets take their
  final sizes in one step. The painted rim and header ease to the measured bounds, with a small
  overshoot on automatic changes and immediate feedback during a manual resize. Displaced tiles
  and neighbouring zones glide to their slots. Removing a whole zone leaves its rim and label
  just long enough to fade, and a removed thread note fades where it stood.

## Lists and loading

The project explorer's two tabs (Files, Git) are the model for a list that is read from disk and
shown in a panel.

- **The frame stands first.** What does not depend on the read is drawn from the first frame and
  keeps its place: in the Git tab the branch row, the staged row and the composer, with the line
  that says why Commit is off holding the room for "Reading Git changes…". When the read is back
  nothing under the list moves; only the list fills in. Do not swap a loading line for the whole
  surface.
- **A quick read shows only its result.** A loading line (`.is-loading`) and the shapes that stand
  in for the Git list (`.git-ghost`) are in the page at once, for assistive tech (`role="status"`,
  `aria-busy`), but unseen for `--t-wait`; then they fade in, and the shapes breathe one after
  another. A read that is back sooner never flashes them. With reduced motion they show at once,
  and still.
- **What was read last is shown at once.** A tab is drawn afresh each time it is entered, so the
  explorer keeps the Git status it last showed and hands it back (`seen` in `GitPanel.tsx`): the
  list is there on the first frame and Git is read again behind it. A diff keeps its lines while it
  is read again, and takes a fixed share of the panel, so the list above does not move from one
  file to the next. Only another file starts from "Loading diff…".
- **Rows that arrive together follow one another.** Each row's entrance waits `--i` times
  `--stagger-row`, capped. A row takes its `--i` once, when it is first drawn (`cascade.ts`), and
  never again, because a delay that changes under a playing entrance makes it jump. The whole list
  counts from its top when the tab is entered; a folder's or a group's own rows count from their
  heading when it opens.
- **The chosen tab's fill travels.** A two-way switch (`.ex-seg`) draws its fill as one thumb under
  both labels and moves it with `translate`, so it slides from one choice to the other.
- **A base animation stays first in the list.** `.explorer` fades in when another zone's folder
  takes its place, and docks in when it opens. The opening rule lists `fade-in` first and
  `dock-in` second; with `dock-in` alone, `fade-in` would be a name new to the element the moment
  `.is-explorer-opening` goes, and the whole explorer would fade in a second time (rule 4).

## Folding

One row changes height, outside the board: the preview's controls (`#pv-options`). It eases
between `0` and its own height with `interpolate-size: allow-keywords`, clipped only while it
moves. It is `hidden` when folded, so its way out is a transition with `display … allow-discrete`
and its way in the `unfold` keyframes. Do not fold anything inside a zone this way.

## The shared-element morph

Pressing the agent's orb (or ⌘J) from the bare canvas does not slide a panel in: the orb flies
out and becomes the panel, and closing sends it home. It is the only shared-element transition
here, and it is built to be copied only with care.

- **One layer, measured once (FLIP).** `useOrbFlight` reads the button's box and the panel's
  (the panel's final place is worked out, since its column is still opening), then `fly` appends
  one fixed layer to `body`: a surface laid out at the panel's size and a copy of the orb. Only
  `transform`, `border-radius`, `border-width`, colour and `opacity` change after that; nothing
  on the page is measured again.
- **The frames are computed, not eased between two ends.** `flightFrames` samples the flight
  about once a frame: the centre follows a bowed path (a quadratic curve, `BOW`), the size grows
  by ratio so it stays a small round thing for most of the trip and blooms on arrival, and the
  corners and border are divided by the scale so they stay round and a pixel wide. The orb rides
  the surface to where the panel draws its own orb beside the title. Home, the surface holds
  while the panel's content fades on it, gathers, and lands a little small before it springs to
  size: the one overshoot, on the small end only.
- **The real things are swapped in under it.** While the layer flies, `.app[data-morph]` hides
  the button and the panel's surface and content; the panel is laid out and focused throughout,
  so typing works from the first frame. On landing the layer is removed in the same step the
  real surface shows (`flushSync`), its content fades in, and the layer's orb stays a moment
  over the panel's own. Going home, the leaving panel (a lingering one) stays put as `fixed`
  while its column closes around it.
- **Interruptions turn it round.** The page's state changes at once, as always; only the layer
  is in the air. Closed again before it lands, or opened again on the way home: the same
  animations are reversed from where they are (`back`, `open`). A session taking the panel
  mid-flight cancels the layer there and then. A new flight clears any layer left, and a timer
  lands one whose frames stopped coming, so nothing can be left over the page.
- **When it does not fly.** A panel already open only swaps its content, and the orb in the
  button dims. Reduced motion, or a page without the button, opens and closes at once.

## Adding motion

1. Say what the motion tells the owner. Pick the keyframe from the vocabulary that says it.
2. Add the rule to the matching section of `motion.css`, inside the media query, using tokens.
3. If the element appears in a list, give it a stagger with `--i` or `:nth-child`, capped.
4. If it is a control, add it to the two control lists at the top of the Motion part (transition,
   press) instead of writing its own.
5. Check it in the demo (`npm run app -- --demo`, or the e2e shots): first paint, the state change
   itself, hover and press, the narrowest panel, and with "Reduce motion" on in System Settings.
6. Run `npm test` and `npm run test:e2e`. Tests that measure a box right after something opens
   call `settled(page)` first (it waits for every finite animation; loops are ignored).

## Room to play

The rules above are about not breaking the desk; they are not a ceiling. Good places for a new
idea, none of them built yet:

- The subagent progress bar filling, and a small burst when the last one finishes.
- Sound is off the table unless the owner asks.

Try an idea in the demo first. If it survives a minute of ordinary use without drawing the eye
away from a card that needs you, it probably belongs.
