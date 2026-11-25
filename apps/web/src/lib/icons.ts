import type { ThreatType } from '@arpha/shared'

/** Colour per threat class — also used by the list UI. */
export const THREAT_COLORS: Record<ThreatType, string> = {
  shahed: '#ff8a00',
  jet_drone: '#ff5a1f',
  molniya: '#ff6b81',
  fpv: '#ff2d92',
  cruise_missile: '#ff2d55',
  ballistic: '#e00034',
  kab: '#b14aff',
  recon_drone: '#ffd60a',
  aircraft: '#ff375f',
  helicopter: '#ff9f0a',
  mlrs: '#bf5af2',
  artillery: '#a2845e',
  explosion: '#ffcc00',
  unknown: '#8e8e93',
}

/**
 * Glyphs point north (up) so MapLibre can rotate them by heading.
 * Drawn on a 64×64 grid, white on a coloured disc with a dark halo for contrast on any basemap.
 */
const GLYPHS: Record<ThreatType, string> = {
  // Delta wing with a pusher prop — the Shahed silhouette.
  shahed:
    '<path d="M32 12 L50 44 L32 38 L14 44 Z" fill="#fff"/><rect x="29" y="38" width="6" height="8" rx="2" fill="#fff"/>',
  jet_drone:
    '<path d="M32 10 L46 46 L32 40 L18 46 Z" fill="#fff"/><path d="M28 42 L32 52 L36 42 Z" fill="#ffd60a"/>',
  molniya:
    '<path d="M32 14 L35 28 L50 33 L50 36 L35 35 L34 46 L39 49 L25 49 L30 46 L29 35 L14 36 L14 33 L29 28 Z" fill="#fff"/>',
  fpv: '<path d="M18 18 L46 46 M46 18 L18 46" stroke="#fff" stroke-width="4" stroke-linecap="round"/><circle cx="18" cy="18" r="6" fill="none" stroke="#fff" stroke-width="3"/><circle cx="46" cy="18" r="6" fill="none" stroke="#fff" stroke-width="3"/><circle cx="18" cy="46" r="6" fill="none" stroke="#fff" stroke-width="3"/><circle cx="46" cy="46" r="6" fill="none" stroke="#fff" stroke-width="3"/><rect x="28" y="28" width="8" height="8" rx="2" fill="#fff"/>',
  cruise_missile:
    '<rect x="28" y="12" width="8" height="36" rx="4" fill="#fff"/><path d="M20 30 L44 30 L44 34 L20 34 Z" fill="#fff"/><path d="M24 46 L40 46 L36 52 L28 52 Z" fill="#fff"/>',
  ballistic:
    '<path d="M32 10 L40 26 L40 46 L24 46 L24 26 Z" fill="#fff"/><path d="M24 46 L18 54 L24 50 Z M40 46 L46 54 L40 50 Z" fill="#fff"/>',
  kab: '<ellipse cx="32" cy="30" rx="8" ry="15" fill="#fff"/><path d="M26 42 L22 52 L42 52 L38 42 Z" fill="#fff"/><path d="M18 26 L46 26" stroke="#fff" stroke-width="3" stroke-linecap="round"/>',
  recon_drone:
    '<path d="M32 14 L36 30 L52 34 L36 37 L34 48 L38 51 L26 51 L30 48 L28 37 L12 34 L28 30 Z" fill="#1c1c1e"/>',
  aircraft:
    '<path d="M32 8 L35 24 L54 34 L54 38 L35 33 L34 46 L40 50 L40 53 L32 51 L24 53 L24 50 L30 46 L29 33 L10 38 L10 34 L29 24 Z" fill="#fff"/>',
  helicopter:
    '<ellipse cx="32" cy="32" rx="7" ry="10" fill="#fff"/><rect x="30.5" y="40" width="3" height="14" fill="#fff"/><path d="M12 26 L52 38 M52 26 L12 38" stroke="#fff" stroke-width="3" stroke-linecap="round"/>',
  mlrs: '<path d="M18 46 L30 18 M28 46 L38 18 M38 46 L46 18" stroke="#fff" stroke-width="5" stroke-linecap="round"/>',
  artillery:
    '<path d="M26 46 L26 26 Q32 12 38 26 L38 46 Z" fill="#fff"/><rect x="24" y="46" width="16" height="5" rx="1" fill="#fff"/>',
  explosion:
    '<path d="M32 8 L36 22 L50 14 L42 28 L56 32 L42 36 L50 50 L36 42 L32 56 L28 42 L14 50 L22 36 L8 32 L22 28 L14 14 L28 22 Z" fill="#ff3b30"/>',
  unknown:
    '<text x="32" y="43" text-anchor="middle" font-family="system-ui,sans-serif" font-size="30" font-weight="700" fill="#fff">?</text>',
}

export function iconSvg(type: ThreatType): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
<circle cx="32" cy="32" r="29" fill="${THREAT_COLORS[type]}" stroke="#0b1220" stroke-width="4"/>
${GLYPHS[type]}
</svg>`
}

export const DESTROYED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
<path d="M14 14 L50 50 M50 14 L14 50" stroke="#0b1220" stroke-width="12" stroke-linecap="round"/>
<path d="M14 14 L50 50 M50 14 L14 50" stroke="#30d158" stroke-width="7" stroke-linecap="round"/>
</svg>`

export const iconId = (type: ThreatType) => `threat-${type}`

/** Bridge/dam status marker: red barrier when closed, green arch when open. */
export function infraSvg(status: 'closed' | 'open'): string {
  const color = status === 'closed' ? '#ff3b30' : '#30d158'
  const glyph =
    status === 'closed'
      ? '<rect x="14" y="27" width="36" height="10" rx="3" fill="#fff"/><path d="M18 27 L24 37 M30 27 L36 37 M42 27 L48 37" stroke="' +
        color +
        '" stroke-width="3"/>'
      : '<path d="M12 40 Q32 16 52 40" stroke="#fff" stroke-width="5" fill="none"/><path d="M12 40 L52 40" stroke="#fff" stroke-width="4"/>'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
<rect x="4" y="4" width="56" height="56" rx="14" fill="${color}" stroke="#0b1220" stroke-width="4"/>${glyph}</svg>`
}
