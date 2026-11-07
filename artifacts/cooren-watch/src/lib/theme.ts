import type { CSSProperties } from 'react';

// Profile theme colour: one #rrggbb value drives the site's accent (buttons, highlights, active states).
export const THEME_PRESETS = ['#ff6b3d', '#ff4d6d', '#e879f9', '#a78bfa', '#6d8dff', '#38bdf8', '#2dd4bf', '#4ade80', '#a3e635', '#facc15', '#fb923c', '#f1f1f5'];
export const DEFAULT_THEME = '#ff6b3d';
const HEX = /^#[0-9a-f]{6}$/i;

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c: number[]) => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const luminance = (hex: string) => { const [r, g, b] = rgb(hex).map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

export function themeVars(color?: string | null): CSSProperties | undefined {
  if (!color || !HEX.test(color)) return undefined;
  const hover = toHex(rgb(color).map(v => v + (255 - v) * 0.18)); // a little lighter on hover
  const ink = luminance(color) > 0.32 ? '#14100c' : '#ffffff'; // readable text on top of the colour
  return { '--accent': color, '--accent-hover': hover, '--accent-ink': ink } as CSSProperties;
}

export function applyTheme(color?: string | null) {
  const root = document.documentElement;
  for (const k of ['--accent', '--accent-hover', '--accent-ink']) root.style.removeProperty(k);
  const vars = themeVars(color) as Record<string, string> | undefined;
  if (vars) for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}
