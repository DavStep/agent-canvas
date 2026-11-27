// When the canvas agent's panel opens from the bare canvas its orb flies out and becomes it; when
// it closes to the canvas the panel becomes the orb and flies home (morph.ts). This reads the two
// ends from the page, starts the flight, and tells the page what to hide meanwhile:
//   open   the layer is on its way to the panel: the real panel is laid out but unseen
//   close  the layer is on its way home: the leaving panel's content fades where it stood
//   back   it turned round before it arrived and is on its way home: no panel was ever seen
//   rest   it has just landed as the panel: the panel's own entrance must not play over it
//   home   it has just landed as the button: what is left of the leaving panel stays unseen
// Anything else is a plain panel: a panel already open only swaps its content, reduced motion
// opens and closes at once. A change of mind mid-air turns the flight round; a session taking
// the panel ends it. See docs/motion.md.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { instant } from '../useClosing.ts';
import { fly, type Box, type Flight, type FlightDir, type FlightOptions } from './morph.ts';

export interface OrbMorph {
  phase: FlightDir | 'back' | 'rest' | 'home';
  /** Where the panel stands, for the leaving panel to stay put while the page closes around it. */
  box: Box;
}

/** How long after landing the page still counts as morphing (longer than a panel's entrance or exit). */
const REST_MS = 400;

/** The page as it stands: the button, the agent's panel, and the flight between them. */
function measure(dir: FlightDir): Omit<FlightOptions, 'onLand'> | null {
  const button = document.querySelector<HTMLElement>('button.agent-btn');
  const panel = document.querySelector<HTMLElement>('.app > .chat-screen.is-agent.is-panel');
  const app = panel?.parentElement;
  const glyph = button?.querySelector<HTMLElement>('.agent-orb');
  if (!button || !panel || !app || !glyph) return null;
  const page = app.getBoundingClientRect();
  const style = getComputedStyle(panel);
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  if (width === 0 || height === 0) return null;
  // Layout positions, not drawn ones: the panel may be mid-entrance. Opening, its column is still
  // closed, so its place is worked out: the page's right edge, less its margin.
  const x = dir === 'open'
    ? page.right - (parseFloat(style.marginRight) || 0) - width
    : page.left + panel.offsetLeft - app.offsetLeft;
  const y = page.top + panel.offsetTop - app.offsetTop;
  const drawn = panel.getBoundingClientRect();
  const markEl = panel.querySelector<HTMLElement>('.cs-heading .agent-orb');
  const m = markEl?.getBoundingClientRect();
  const mark = m && m.width > 0 ? { x: x + m.left - drawn.left, y: y + m.top - drawn.top, width: m.width, height: m.height } : null;
  const b = button.getBoundingClientRect();
  // The button's colours where they are heading, not mid-fade: it is unseen while the layer flies.
  button.style.transition = 'none';
  const bs = getComputedStyle(button);
  const buttonSurface = { background: bs.backgroundColor, border: bs.borderTopColor };
  button.style.transition = '';
  return {
    dir,
    plan: {
      orb: { x: b.left, y: b.top, width: b.width, height: b.height },
      glyph: glyph.offsetWidth || 30,
      panel: { x, y, width, height },
      mark,
      radius: parseFloat(style.borderTopLeftRadius) || 14,
    },
    glyph,
    button: buttonSurface,
    panel: { background: style.backgroundColor, border: style.borderTopColor },
  };
}

/**
 * @param agentOpen the agent's panel is open
 * @param chatOpen any panel is open (the agent's included)
 */
export function useOrbFlight(agentOpen: boolean, chatOpen: boolean): OrbMorph | null {
  const [morph, setMorph] = useState<OrbMorph | null>(null);
  const flight = useRef<Flight | null>(null);
  const rest = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const was = useRef({ agent: agentOpen, chat: chatOpen });

  useLayoutEffect(() => {
    const before = was.current;
    was.current = { agent: agentOpen, chat: chatOpen };
    if (before.agent === agentOpen) return;
    const start = (dir: FlightDir) => {
      if (instant()) return;
      const found = measure(dir);
      if (found === null) return;
      const f = fly({
        ...found,
        onLand: (landed) => {
          flight.current = null;
          // In one step with the layer going: the real panel or button is there in the same frame.
          flushSync(() => setMorph((m) => m && { ...m, phase: landed === 'open' ? 'rest' : 'home' }));
          rest.current = setTimeout(() => setMorph(null), REST_MS);
        },
      });
      if (f === null) return;
      clearTimeout(rest.current);
      flight.current = f;
      setMorph({ phase: dir, box: found.plan.panel });
    };
    const f = flight.current;
    if (agentOpen) {
      // Asked for again while flying home: back to the panel from where it is.
      if (f) { if (f.dir === 'close') { f.reverse(); setMorph((m) => m && { ...m, phase: 'open' }); } }
      else if (!before.chat) start('open');
    } else if (f) {
      // A session took the panel mid-flight: there is no panel of the agent's to become, or to leave.
      if (chatOpen) { f.cancel(); flight.current = null; setMorph(null); }
      // Closed again before it arrived: home from where it is. The panel stays unseen throughout.
      else if (f.dir === 'open') { f.reverse(); setMorph((m) => m && { ...m, phase: 'back' }); }
    } else if (!chatOpen) {
      start('close');
    }
  }, [agentOpen, chatOpen]);

  useEffect(() => () => { flight.current?.cancel(); flight.current = null; clearTimeout(rest.current); }, []);
  return morph;
}
