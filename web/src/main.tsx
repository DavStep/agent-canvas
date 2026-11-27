import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import './theme.css';
import './app.css';
import './chat/chat.css';
import './overlays.css';
import './agent/agent.css';
import './explorer/explorer.css';
import './board/board.css';
import './notes/appearance.css';
import './notes/notes.css';
import './profile/usage.css';
import './threads/threads.css';
import './links/links.css';
import './motion.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

// Inside the app the top bar doubles as the title bar (see .desktop in app.css).
if (window.canvas) document.documentElement.classList.add('desktop');

const root = createRoot(document.getElementById('root')!);

// The creature contact sheet is a dev tool; the production build leaves it out.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('sheet')) {
  void import('./creature/Sheet.tsx').then(({ Sheet }) => root.render(<StrictMode><Sheet /></StrictMode>));
} else {
  root.render(<StrictMode><App /></StrictMode>);
}
