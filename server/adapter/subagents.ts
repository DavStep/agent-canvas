// Reads a session's subagents from <dir of transcript>/<sessionId>/subagents/agent-<id>.meta.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SubagentView } from '../../shared/types.ts';

const META = /^agent-(.+)\.meta\.json$/;
const MAX_SUBAGENTS = 6;

async function mtimeMs(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

export async function readSubagents(transcriptPath: string, sessionId: string, since: number): Promise<SubagentView[]> {
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const found: { view: SubagentView; modified: number }[] = [];
  for (const name of names) {
    const id = META.exec(name)?.[1];
    if (!id) continue;
    const metaFile = path.join(dir, name);
    const modified = Math.max((await mtimeMs(metaFile)) ?? -Infinity, (await mtimeMs(path.join(dir, `agent-${id}.jsonl`))) ?? -Infinity);
    if (!(modified >= since)) continue;
    let meta: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(metaFile, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) continue;
      meta = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    found.push({
      modified,
      view: {
        id,
        type: typeof meta.agentType === 'string' ? meta.agentType : '',
        description: typeof meta.description === 'string' ? meta.description : '',
        state: meta.finished === true ? 'done' : 'working',
      },
    });
  }
  return found
    .sort((a, b) => b.modified - a.modified)
    .slice(0, MAX_SUBAGENTS)
    .map((f) => f.view);
}
