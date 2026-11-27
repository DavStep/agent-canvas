export const ZONE_ICONS = ['square', 'folder', 'code', 'terminal', 'layers', 'gamepad', 'star', 'bolt'] as const;
export type ZoneIcon = typeof ZONE_ICONS[number];

export function isZoneIcon(value: unknown): value is ZoneIcon {
  return ZONE_ICONS.some((icon) => icon === value);
}

export function isZoneColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}
