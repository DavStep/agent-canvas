// The shell command that resumes a session in a terminal.
import type { SessionView } from '../../shared/types.ts';

/** POSIX shell quoting: bare when safe, else single quotes. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/.,:@%+=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resumeCommand(s: Pick<SessionView, 'cwd' | 'id' | 'provider' | 'hostId'>): string {
  const resume = s.provider === 'codex'
    ? `codex resume ${shellQuote(s.hostId ?? s.id)}`
    : `claude --resume ${shellQuote(s.id)}`;
  return s.cwd === '' ? resume : `cd ${shellQuote(s.cwd)} && ${resume}`;
}
