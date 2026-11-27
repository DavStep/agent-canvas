import { Creature } from '../creature/Creature.tsx';
// The canvas agent's panel before a conversation exists (or after "New conversation"): the same
// docked panel a chat uses, holding one line on what the agent does, example prompts that fill
// the message field, and the chat's own composer, whose send starts the agent's session.
import { useState, type CSSProperties } from 'react';
import type { ImageRef } from '../../../shared/chat.ts';
import { MetaLine, PanelHeader } from '../chat/ChatScreen.tsx';
import { Composer } from '../chat/Composer.tsx';
import { PanelEdge } from '../chat/PanelEdge.tsx';
import { AGENT_LEAD, AGENT_PROMPTS, AGENT_TITLE, agentBlocked, agentMeta, type AgentInfo } from './agent.ts';
import type { ZoneLayout } from '../../../shared/types.ts';
import { zoneHue } from '../components/ZoneMark.tsx';
import { AgentOrb } from './AgentOrb.tsx';

const nothing = (): Promise<void> => Promise.resolve();

export interface AgentStartProps {
  /** Whether the agent can run and what it is connected to; null while asking. */
  info: AgentInfo | null;
  project?: ZoneLayout;
  /** Sends the first message: starts the agent's session, and the panel moves to its chat. */
  onStart(text: string, images: ImageRef[]): Promise<void>;
  /** Back to the conversation there already is, when "New conversation" left one behind. */
  onResume?: () => void;
  onClose(): void;
  panelWidth: number | null;
  onPanelResize(width: number | null, done: boolean): void;
  /** Closed already and only playing its exit (useLingering). */
  closing?: boolean;
}

export function AgentStart({ info, project, onStart, onResume, onClose, panelWidth, onPanelResize, closing }: AgentStartProps) {
  const [fill, setFill] = useState<{ text: string } | null>(null);
  const blocked = agentBlocked(info);
  return (
    <div className={`chat-screen is-panel is-agent${closing ? ' is-closing' : ''}`} style={project ? { '--zone-hue': zoneHue(project) } as CSSProperties : undefined} aria-label="Chat panel" role="complementary" inert={closing} aria-hidden={closing || undefined}>
      <PanelHeader
        title={project ? 'Project orchestrator' : AGENT_TITLE}
        mark={project ? <Creature provider="orchestrator" state="idle" size={24} /> : <AgentOrb kind="idle" size={18} />}
        meta={<MetaLine parts={project ? [project.name] : agentMeta(info)} />}
        actions={onResume && (
          <div className="cs-actions">
            <button type="button" className="cs-act" data-testid="agent-resume" onClick={onResume}>Back to conversation</button>
          </div>
        )}
        onClose={onClose}
      />
      <section className="desk" aria-label="Chat">
        <div className="agent-start" data-testid="agent-start">
          <p className="agent-lead">{project ? 'What would you like to work on? I can pick up an existing chat or start one for the task.' : AGENT_LEAD}</p>
          {!project && <ul className="agent-chips" aria-label="Examples">
            {AGENT_PROMPTS.map((p) => (
              <li key={p.label}>
                <button type="button" className="agent-chip" disabled={blocked !== null} onClick={() => setFill({ text: p.text })}>{p.label}</button>
              </li>
            ))}
          </ul>}
        </div>
        {blocked !== null && <div className="cs-banner is-provider" role="alert" data-testid="agent-unavailable"><span>{blocked}</span></div>}
        <Composer
          provider={info?.connection === 'codex-api' ? 'codex' : 'claude'}
          name={project ? 'the project orchestrator' : 'the canvas agent'}
          models={[]}
          model={null}
          modes={[]}
          mode=""
          running={false}
          blocked={blocked}
          offHint={project ? 'Project chat unavailable' : "The canvas agent can't run right now"}
          fill={fill}
          autoFocus
          onSend={onStart}
          onStop={nothing}
          onModel={nothing}
          onMode={nothing}
        />
      </section>
      <PanelEdge width={panelWidth} onResize={onPanelResize} />
    </div>
  );
}
