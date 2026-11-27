import { Chevron, type ToolItem } from './ToolRow.tsx';

const counts: Record<ToolItem['tool'], [string, string]> = {
  command: ['command', 'commands'], read: ['read', 'reads'], edit: ['edit', 'edits'],
  search: ['search', 'searches'], web: ['web search', 'web searches'],
  mcp: ['tool call', 'tool calls'], other: ['tool call', 'tool calls'],
};

export function ToolGroupSummary({ items, expanded, onToggle }: {
  items: ToolItem[];
  expanded: boolean;
  onToggle(): void;
}) {
  const kinds = new Map<string, { plural: string; count: number }>();
  let running = 0, waiting = 0, failed = 0, denied = 0;
  for (const item of items) {
    const [singular, plural] = counts[item.tool];
    const kind = kinds.get(singular);
    if (kind) kind.count++;
    else kinds.set(singular, { plural, count: 1 });
    if (item.status === 'running') running++;
    else if (item.status === 'waiting') waiting++;
    else if (item.status === 'denied') denied++;
    else if (item.status === 'failed' || (item.exitCode !== null && item.exitCode !== 0)) failed++;
  }
  const label = Array.from(kinds, ([singular, { plural, count }]) => `${count} ${count === 1 ? singular : plural}`).join(', ');
  return (
    <button className="t-activity" type="button" aria-expanded={expanded} onClick={onToggle}>
      <Chevron open={expanded} />
      <span>{label}</span>
      {running > 0 && <span>· {running} running</span>}
      {waiting > 0 && <span className="is-waiting">· {waiting} waiting for you</span>}
      {failed > 0 && <span className="is-bad">· {failed} failed</span>}
      {denied > 0 && <span className="is-bad">· {denied} denied</span>}
    </button>
  );
}
