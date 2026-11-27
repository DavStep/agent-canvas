// Pure layout operations. Imported by the reader and by the browser page,
// so this file must not import anything from `node:`.
import { isZoneColor, isZoneIcon } from '../shared/zoneAppearance.ts';
import type { Layout, LayoutOp, SessionView, ZoneLayout } from '../shared/types.ts';
import { folderOf } from './activity.ts';
import { applyNoteOp, releaseNotes } from '../shared/boardNotes.ts';
import { applyItemOp, releaseItems } from '../shared/boardItems.ts';
import { applySlotOp, dropSlots } from '../shared/cardSlots.ts';

const MAX_NAME = 60;
const QUIET_HUE = 6;

function cleanName(name: string): string | null {
  const trimmed = name.trim().slice(0, MAX_NAME).trim();
  return trimmed === '' ? null : trimmed;
}

/** Next hue in creation order: one past the highest in use, capped at the quiet grey. */
function nextHue(zones: ZoneLayout[]): number {
  const highest = zones.reduce((max, z) => Math.max(max, z.hueIndex), -1);
  return Math.min(highest + 1, QUIET_HUE);
}

function randomHex8(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function ensureFolderZones(layout: Layout, folders: string[]): Layout {
  let zones = layout.zones;
  for (const folder of folders) {
    const id = `folder:${folder}`;
    if (zones.some((z) => z.id === id)) continue;
    zones = [...zones, {
      id, name: folder === '' ? 'No folder' : folder, kind: 'folder', folder,
      x: null, y: null, hueIndex: nextHue(zones),
    }];
  }
  return zones === layout.zones ? layout : { ...layout, zones };
}

function replaceZone(layout: Layout, id: string, patch: Partial<ZoneLayout>): Layout {
  if (!layout.zones.some((z) => z.id === id)) return layout;
  return { ...layout, zones: layout.zones.map((z) => (z.id === id ? { ...z, ...patch } : z)) };
}

export function applyLayoutOp(layout: Layout, op: LayoutOp): Layout {
  switch (op.type) {
    case 'moveZone':
      if (!Number.isFinite(op.x) || !Number.isFinite(op.y)) return layout;
      return replaceZone(layout, op.id, { x: op.x, y: op.y });

    case 'createZone': {
      const name = cleanName(op.name);
      if (name === null) return layout;
      let id = `custom:${randomHex8()}`;
      while (layout.zones.some((z) => z.id === id)) id = `custom:${randomHex8()}`;
      const zone: ZoneLayout = {
        id, name, kind: 'custom', folder: null, x: null, y: null, hueIndex: nextHue(layout.zones),
      };
      return { ...layout, zones: [...layout.zones, zone] };
    }

    case 'renameZone': {
      const name = cleanName(op.name);
      if (name === null) return layout;
      return replaceZone(layout, op.id, { name });
    }

    case 'editZone': {
      const name = cleanName(op.name);
      if (name === null || !isZoneColor(op.color) || !isZoneIcon(op.icon)) return layout;
      return replaceZone(layout, op.id, { name, color: op.color, icon: op.icon });
    }

    case 'deleteZone': {
      const zone = layout.zones.find((z) => z.id === op.id);
      if (!zone || zone.kind !== 'custom') return layout;
      const assignments = Object.fromEntries(
        Object.entries(layout.assignments).filter(([, zoneId]) => zoneId !== op.id),
      );
      // Its images stay on the board, free where the zone was.
      return dropSlots(releaseNotes(releaseItems({ ...layout, zones: layout.zones.filter((z) => z.id !== op.id), assignments }, zone), zone), op.id);
    }

    case 'hideZone': {
      const zone = layout.zones.find((z) => z.id === op.id);
      if (!zone || zone.kind !== 'folder') return layout;
      if (op.at === null) {
        if (zone.hiddenAt === undefined) return layout;
        const { hiddenAt: _shown, ...rest } = zone;
        return { ...layout, zones: layout.zones.map((z) => (z.id === op.id ? rest : z)) };
      }
      if (!Number.isFinite(op.at)) return layout;
      return replaceZone(layout, op.id, { hiddenAt: op.at });
    }

    case 'addFolderZone': {
      // An absolute folder path; its zone is keyed like every folder zone, by the folder's name.
      // A worktree stands for the repository it belongs to, as its sessions do.
      const worktree = op.path.indexOf('/.claude/worktrees/');
      const folderPath = (worktree === -1 ? op.path : op.path.slice(0, worktree)).replace(/(?<=.)\/+$/, '');
      const folder = folderPath.startsWith('/') ? folderOf(folderPath) : '';
      if (folder === '') return layout;
      const id = `folder:${folder}`;
      const zone = layout.zones.find((z) => z.id === id);
      if (!zone) {
        const added = ensureFolderZones(layout, [folder]);
        return { ...added, zones: added.zones.map((z) => (z.id === id ? { ...z, path: folderPath } : z)) };
      }
      if (zone.path === folderPath && zone.hiddenAt === undefined) return layout;
      const { hiddenAt: _shown, ...rest } = zone;
      return { ...layout, zones: layout.zones.map((z) => (z.id === id ? { ...rest, path: folderPath } : z)) };
    }

    case 'assign': {
      if (op.zoneId === null) {
        if (!(op.sessionId in layout.assignments)) return layout;
        const { [op.sessionId]: _removed, ...assignments } = layout.assignments;
        return { ...layout, assignments };
      }
      if (!layout.zones.some((z) => z.id === op.zoneId)) return layout;
      return { ...layout, assignments: { ...layout.assignments, [op.sessionId]: op.zoneId } };
    }

    case 'addNote': case 'editNote': case 'removeNote': case 'moveNote': case 'resizeNote':
      return applyNoteOp(layout, op);

    case 'setSlots':
      return applySlotOp(layout, op);

    case 'addItem': case 'placeItem': case 'resizeItem': case 'editItem': case 'removeItem':
      return applyItemOp(layout, op);

    default:
      return layout;
  }
}

export function zoneIdFor(session: SessionView, layout: Layout): string {
  const assigned = layout.assignments[session.id];
  if (assigned !== undefined && layout.zones.some((z) => z.id === assigned)) return assigned;
  return `folder:${session.folder}`;
}
