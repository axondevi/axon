/**
 * Public personas API.
 *
 *   GET  /v1/personas                       — list all active personas
 *   GET  /v1/personas/:slug                 — single persona detail
 *   GET  /v1/personas/:slug/avatar.svg      — procedural avatar SVG
 *
 * No auth — these power the public personas gallery and are read by the
 * /build editor when customers pick a persona for a new agent.
 */
import { Hono } from 'hono';
import { eq, and, asc } from 'drizzle-orm';
import { db } from '~/db';
import { personas } from '~/db/schema';
import { renderPersonaAvatar } from '~/personas/avatar';

/**
 * Real-photo overrides keyed by persona slug. Replaces the SVG-with-emoji
 * avatar in customer-facing surfaces (gallery, agent build) with a human
 * portrait that matches the persona's vibe.
 *
 * These PNGs are AI-generated portraits (Stability XL, custom prompts
 * tuned to each persona's role + setting) checked into the landing/
 * folder and served by Cloudflare Pages at /personas/<slug>.png. We
 * tried curated Unsplash IDs first but couldn't visually verify each
 * photo without browsing — many landed on photos that didn't match
 * (Tia Zélia returned a young woman, Don Salvatore returned a grain
 * of sand, etc). Generated portraits give us deterministic, on-brand
 * imagery that matches the persona description exactly.
 *
 * The SVG avatar route still works as a fallback for places that haven't
 * adopted image_url yet (embeds, share previews) and for any new persona
 * added to the seed list before its photo is curated.
 */
const PERSONA_PHOTOS: Record<string, string> = {
  'tia-zelia':         'https://axon-5zf.pages.dev/personas/tia-zelia.png',
  'don-salvatore':     'https://axon-5zf.pages.dev/personas/don-salvatore.png',
  'cabra-da-peste':    'https://axon-5zf.pages.dev/personas/cabra-da-peste.png',
  'hacker-cyberpunk':  'https://axon-5zf.pages.dev/personas/hacker-cyberpunk.png',
  'carioca-maluco':    'https://axon-5zf.pages.dev/personas/carioca-maluco.png',
  'paulista-tubarao':  'https://axon-5zf.pages.dev/personas/paulista-tubarao.png',
  'mineirinho-curioso':'https://axon-5zf.pages.dev/personas/mineirinho-curioso.png',
  'mestra-yoba':       'https://axon-5zf.pages.dev/personas/mestra-yoba.png',
};

export const personaRoutes = new Hono();

personaRoutes.get('/', async (c) => {
  const rows = await db
    .select()
    .from(personas)
    .where(eq(personas.active, true))
    .orderBy(asc(personas.displayOrder), asc(personas.name));
  return c.json({
    data: rows.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      tagline: p.tagline,
      emoji: p.emoji,
      tone_description: p.toneDescription,
      sample_greeting: p.sampleGreeting,
      sample_signoff: p.sampleSignoff,
      avatar_color_primary: p.avatarColorPrimary,
      avatar_color_secondary: p.avatarColorSecondary,
      avatar_url: `/v1/personas/${p.slug}/avatar.svg`,
      image_url: PERSONA_PHOTOS[p.slug] || null,
      premium: p.premium,
      monthly_price_brl: p.monthlyPriceBrl,
    })),
    count: rows.length,
  });
});

personaRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const [p] = await db.select().from(personas).where(and(eq(personas.slug, slug), eq(personas.active, true))).limit(1);
  if (!p) return c.json({ error: 'not_found' }, 404);
  return c.json({
    id: p.id,
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    emoji: p.emoji,
    tone_description: p.toneDescription,
    // prompt_fragment intentionally NOT exposed — proprietary to Axon.
    sample_greeting: p.sampleGreeting,
    sample_signoff: p.sampleSignoff,
    avatar_color_primary: p.avatarColorPrimary,
    avatar_color_secondary: p.avatarColorSecondary,
    avatar_url: `/v1/personas/${p.slug}/avatar.svg`,
    image_url: PERSONA_PHOTOS[p.slug] || null,
    has_voice: !!p.voiceIdElevenlabs,
    premium: p.premium,
    monthly_price_brl: p.monthlyPriceBrl,
  });
});

personaRoutes.get('/:slug/avatar.svg', async (c) => {
  // Strip optional .svg suffix (some routers normalize differently)
  const slug = c.req.param('slug').replace(/\.svg$/, '');
  const [p] = await db.select().from(personas).where(and(eq(personas.slug, slug), eq(personas.active, true))).limit(1);
  if (!p) return c.json({ error: 'not_found' }, 404);

  const sizeParam = parseInt(c.req.query('size') || '400', 10);
  const showName = c.req.query('name') !== '0';

  const svg = renderPersonaAvatar({
    primary: p.avatarColorPrimary,
    secondary: p.avatarColorSecondary,
    emoji: p.emoji || '✨',
    name: showName ? p.name : '',
    size: sizeParam,
  });

  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  // Override the default secureHeaders 'same-origin' policy — avatars are
  // public marketing assets that load from Cloudflare Pages and the personas
  // gallery on any domain. Without this header the browser silently blocks
  // the <img> request and the avatar shows as a black square.
  c.header('Cross-Origin-Resource-Policy', 'cross-origin');
  return c.body(svg);
});
