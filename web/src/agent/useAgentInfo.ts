// Whether the canvas agent can run and what it is connected to, asked each time its panel opens
// (a sign-in may have changed since).
import { useEffect, useState } from 'react';
import { useSettings } from '../settings.ts';
import { agentBridge } from '../bridge.ts';
import type { AgentInfo } from './agent.ts';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The answer, or null while asking. A question that fails reads as "not available", with why. */
export function useAgentInfo(open: boolean): AgentInfo | null {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const settings = useSettings();
  useEffect(() => {
    if (!open) return;
    let live = true;
    agentBridge.info().then(
      (answer) => { if (live) setInfo(answer); },
      (err: unknown) => { if (live) setInfo({ connection: settings?.agentConnection ?? 'claude-login', available: false, reason: message(err) }); },
    );
    return () => { live = false; };
  }, [open, settings]);
  return info;
}
