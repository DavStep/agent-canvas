import type { ZoneLayout } from '../../../shared/types.ts';
import type { ZoneIcon } from '../../../shared/zoneAppearance.ts';

export const hueToken = (index: number): string =>
  index >= 0 && index <= 5 ? `--chart-${index + 1}` : '--chart-quiet';

export function zoneHue(zone: Pick<ZoneLayout, 'color' | 'hueIndex'>): string {
  return zone.color ?? `var(${hueToken(zone.hueIndex)})`;
}

const paths: Record<Exclude<ZoneIcon, 'square'>, string> = {
  folder: 'M2 4a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z',
  code: 'm5 5-3 3 3 3m6-6 3 3-3 3M9.5 3l-3 10',
  terminal: 'M2 3h12v10H2zM4.5 6l2 2-2 2m4 0h3',
  layers: 'm8 2 6 3.5L8 9 2 5.5Zm-6 7 6 3.5L14 9M2 12l6 3 6-3',
  gamepad: 'M5 4h6c1.6 0 2.2 1.3 2.6 3l.9 3.6c.5 2.3-1.1 3.3-2.7 1.9L10 11H6l-1.8 1.5c-1.6 1.4-3.2.4-2.7-1.9L2.4 7C2.8 5.3 3.4 4 5 4Zm.2 2v3m-1.5-1.5h3M10 8h.1m1.5-1.5h.1',
  star: 'm8 1.6 1.9 4 4.4.6-3.2 3.1.8 4.4L8 11.6l-3.9 2.1.8-4.4-3.2-3.1 4.4-.6Z',
  bolt: 'M9.5 1.5 3 9h4l-.5 5.5L13 7H9Z',
};

export function ZoneMark({ icon = 'square' }: { icon?: ZoneIcon }) {
  return <svg className="zone-mark" data-icon={icon} viewBox="0 0 16 16" aria-hidden="true">
    {icon === 'square'
      ? <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
      : <path d={paths[icon]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />}
  </svg>;
}
