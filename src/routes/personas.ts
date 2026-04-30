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
 * portrait that matches the persona's vibe — Tia Zélia gets a warm
 * grandmother, Don Salvatore an older Italian-looking gentleman, etc.
 *
 * The SVG avatar route still works as a fallback for places that haven't
 * adopted image_url yet (embeds, share previews) and for any new persona
 * added to the seed list before its photo is curated.
 */
const PERSONA_PHOTOS: Record<string, string> = {
  'tia-zelia':         'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=400&h=400&q=80',
  'don-salvatore':     'https://images.unsplash.com/photo-1559963110-71b394e7494d?auto=format&fit=crop&w=400&h=400&q=80',
  'cabra-da-peste':    'https://images.unsplash.com/photo-1531123897727-8f129e1688ce?auto=format&fit=crop&w=400&h=400&q=80',
  'hacker-cyberpunk':  'https://images.unsplash.com/photo-1535378917042-10a22c95931a?auto=format&fit=crop&w=400&h=400&q=80',
  'carioca-maluco':    'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&w=400&h=400&q=80',
  'paulista-tubarao':  'https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=400&h=400&q=80',
  'mineirinho-curioso':'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=400&h=400&q=80',
  'mestra-yoba':       'https://images.unsplash.com/photo-1530268729831-4b0b9e170218?auto=format&fit=crop&w=400&h=400&q=80',
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
