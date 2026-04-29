/**
 * Persona avatar — procedural SVG with rich gradient + emoji + name strip.
 *
 * Looks professional, scales smoothly, zero external dependencies, no
 * Stability call needed at render time. Each persona's color pair gives
 * its avatar a unique aesthetic — Tia Zélia warm gold, Don Salvatore deep
 * wine + amber, Hacker Cyberpunk electric blue + magenta, etc.
 *
 * Scales: serve at any pixel size with `width`/`height` query params.
 * Used as `<img src="/v1/personas/<slug>/avatar.svg">` in dashboards and
 * inline in HTML for marketing pages.
 */

export interface AvatarParams {
  /** Required: persona's primary brand color (CSS hex). */
  primary: string;
  /** Required: persona's secondary brand color (CSS hex). */
  secondary: string;
  /** Required: the persona's emoji glyph. */
  emoji: string;
  /** Optional: name printed at bottom in white strip. Empty = no strip. */
  name?: string;
  /** Pixel size — default 400. SVG scales but viewport hint matters. */
  size?: number;
}

/**
 * Produce a self-contained SVG string for a persona avatar.
 *
 * Layers (back to front):
 *   1. Diagonal linear gradient background (primary → secondary, 135deg)
 *   2. Subtle concentric-ring decoration (low opacity white) for depth
 *   3. Center emoji (60% of size)
 *   4. Optional bottom name strip (semi-transparent black + white text)
 *
 * The emoji renders via the user's system font fallback chain — works
 * across Linux/Mac/Windows/Android/iOS without bundling Twemoji.
 */
export function renderPersonaAvatar(p: AvatarParams): string {
  const size = p.size && p.size > 32 && p.size < 4096 ? p.size : 400;
  const stripHeight = p.name ? Math.round(size * 0.18) : 0;
  const emojiSize = Math.round(size * 0.55);
  const emojiY = p.name ? size * 0.5 - stripHeight * 0.25 : size * 0.55;
  const nameSize = Math.round(size * 0.075);

  // Sanitize colors — only allow hex / rgb / named to avoid CSS injection.
  const sanitize = (c: string) => /^#[0-9a-fA-F]{3,8}$|^rgb/.test(c) ? c : '#7c5cff';
  const primary = sanitize(p.primary);
  const secondary = sanitize(p.secondary);
  const emoji = (p.emoji || '✨').slice(0, 8);  // emoji can be multi-codepoint
  const name = (p.name || '').slice(0, 40);

  // Decorative ring count scales with size — keeps visual density consistent.
  const ringCount = 4;
  const rings = Array.from({ length: ringCount }, (_, i) => {
    const r = (size / 2) * (0.4 + i * 0.18);
    const opacity = 0.05 - i * 0.008;
    return `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="white" stroke-width="${1.5}" opacity="${opacity.toFixed(3)}" />`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="${size}" y2="${size}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${primary}"/>
      <stop offset="1" stop-color="${secondary}"/>
    </linearGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.4" r="0.7">
      <stop offset="0" stop-color="white" stop-opacity="0.12"/>
      <stop offset="1" stop-color="black" stop-opacity="0.18"/>
    </radialGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#bg)"/>
  <rect width="${size}" height="${size}" fill="url(#vignette)"/>
  ${rings}
  <text
    x="${size / 2}"
    y="${emojiY}"
    text-anchor="middle"
    dominant-baseline="middle"
    font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif"
    font-size="${emojiSize}"
    style="filter: drop-shadow(0 4px 12px rgba(0,0,0,0.3));"
  >${escapeXml(emoji)}</text>
  ${name ? `
  <rect y="${size - stripHeight}" width="${size}" height="${stripHeight}" fill="rgba(0,0,0,0.45)"/>
  <text
    x="${size / 2}"
    y="${size - stripHeight / 2}"
    text-anchor="middle"
    dominant-baseline="middle"
    font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
    font-size="${nameSize}"
    font-weight="700"
    fill="white"
    letter-spacing="0.02em"
  >${escapeXml(name)}</text>` : ''}
</svg>`;
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
