// A zone's appearance editor, opened from its marker or context menu.
// It sits outside the zoomed board (fixed to the window), so it reads at full size at any zoom.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ZONE_ICONS, isZoneColor, type ZoneIcon } from '../../../shared/zoneAppearance.ts';
import { hueToken, ZoneMark } from './ZoneMark.tsx';
import type { ZoneLayout } from '../../../shared/types.ts';
import { focusLeaves } from './TopBar.tsx';
import { removeNote } from './Zone.tsx';

/** Keeps a menu of size w×h opened at (x, y) inside a window of vw×vh, with a margin. */
export function clampMenu(x: number, y: number, w: number, h: number, vw: number, vh: number, margin = 8): { x: number; y: number } {
  return {
    x: Math.max(margin, Math.min(x, vw - w - margin)),
    y: Math.max(margin, Math.min(y, vh - h - margin)),
  };
}

export interface ZoneMenuProps {
  zone: ZoneLayout;
  at: { x: number; y: number };
  onSave(values: { name: string; color: string; icon: ZoneIcon }): Promise<void>;
  onDelete(): void;
  onClose(): void;
  /** Tidy the zone's cards by recent activity (shown when it has cards to order). */
  onTidy?(): void;
}

const colorNames = ['Purple', 'Teal', 'Orange', 'Pink', 'Blue', 'Green', 'Gray'];

export function ZoneMenu({ zone, at, onSave, onDelete, onClose, onTidy }: ZoneMenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  const [palette] = useState(() => {
    const style = getComputedStyle(document.documentElement);
    return colorNames.map((label, index) => ({ label, value: style.getPropertyValue(hueToken(index)).trim() }));
  });
  const [name, setName] = useState(zone.name);
  const [color, setColor] = useState(zone.color ?? palette[zone.hueIndex]!.value);
  const [icon, setIcon] = useState<ZoneIcon>(zone.icon ?? 'square');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const hex = color.trim().toLowerCase();
  const validColor = isZoneColor(hex);

  useLayoutEffect(() => {
    const el = panel.current!;
    const place = () => setPos(clampMenu(at.x, at.y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight));
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [at.x, at.y]);

  useLayoutEffect(() => {
    const back = document.activeElement;
    return () => { if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true }); };
  }, []);

  useLayoutEffect(() => {
    panel.current?.querySelector<HTMLElement>(confirming ? '.cancel' : 'input[name="zoneName"]')?.focus();
  }, [confirming]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !name.trim() || !validColor) return;
    setSaving(true);
    setError('');
    try {
      await onSave({ name: name.trim(), color: hex, icon });
      onClose();
    } catch {
      setError('Couldn’t save this zone. Try again.');
      setSaving(false);
    }
  };

  // Dismiss when the user returns to the board. Keep the draft while switching apps.
  useEffect(() => {
    const onOutside = (e: Event) => { if (e.target instanceof Node && !panel.current?.contains(e.target)) onClose(); };
    window.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('wheel', onOutside, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('wheel', onOutside, true);
    };
  }, [onClose]);

  const custom = zone.kind === 'custom';
  return createPortal(
    <div
      ref={panel}
      className="menu zone-menu"
      role="dialog"
      aria-label={confirming ? `${custom ? 'Delete' : 'Remove'} ${zone.name}` : `Edit ${zone.name} zone`}
      style={{ left: pos.x, top: pos.y } as CSSProperties}
      // Escape is handled here, so the page does not also close the chat panel.
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}
      onBlur={(e) => { if (focusLeaves(panel.current, e.relatedTarget)) onClose(); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {confirming ? <div className="menu-confirm">
        <p>{removeNote(zone, 'the Zones menu')}</p>
        <div>
          <button className="menu-btn danger" type="button" onClick={() => { onDelete(); onClose(); }}>
            {custom ? 'Delete' : 'Remove'}
          </button>
          <button className="menu-btn cancel" type="button" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      </div> : (
        <form className="zone-form" onSubmit={save} style={{ '--zone-hue': validColor ? hex : 'var(--muted)' } as CSSProperties}>
          <h2>Edit zone</h2>
          <label className="zone-field">Name
            <span className="zone-name-field">
              <ZoneMark icon={icon} />
              <input name="zoneName" value={name} maxLength={60} required autoComplete="off" onChange={(e) => setName(e.target.value)} />
            </span>
          </label>
          <fieldset>
            <legend>Color</legend>
            <div className="zone-colors">
              {palette.map(({ label, value }) => (
                <label key={label} className="zone-swatch" title={label} style={{ backgroundColor: value }}>
                  <input type="radio" name="zoneColor" aria-label={label} checked={hex === value} onChange={() => setColor(value)} />
                </label>
              ))}
              <input className="zone-hex" aria-label="Hex color" title="Hex color (#RRGGBB)" aria-invalid={!validColor} value={color}
                autoComplete="off" spellCheck={false} maxLength={7} onChange={(e) => setColor(e.target.value)} />
            </div>
          </fieldset>
          <fieldset>
            <legend>Icon</legend>
            <div className="zone-icons">
              {ZONE_ICONS.map((choice) => {
                const label = choice[0]!.toUpperCase() + choice.slice(1);
                return <label key={choice} className="zone-choice" title={label}>
                  <input type="radio" name="zoneIcon" aria-label={label} checked={choice === icon} onChange={() => setIcon(choice)} />
                  <ZoneMark icon={choice} />
                </label>;
              })}
            </div>
          </fieldset>
          {error && <p role="alert">{error}</p>}
          <footer>
            {onTidy && <button className="zone-tidy-action" type="button" title="Order the cards by recent activity" onClick={() => { onTidy(); onClose(); }}>Tidy cards</button>}
            <button className="zone-remove" type="button" onClick={() => setConfirming(true)}>{custom ? 'Delete…' : 'Remove…'}</button>
            <button className="menu-btn" type="button" onClick={onClose}>Cancel</button>
            <button className="menu-btn zone-save" type="submit" disabled={saving || !name.trim() || !validColor}>Save</button>
          </footer>
        </form>
      )}
    </div>,
    document.body,
  );
}
