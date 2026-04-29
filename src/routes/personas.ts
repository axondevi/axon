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
  return c.body(svg);
});
