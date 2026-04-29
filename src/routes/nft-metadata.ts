/**
 * NFT Token Metadata (OpenSea / EIP-721 Metadata standard).
 *
 * Each minted agent NFT has its tokenURI pointing here. Marketplaces
 * (OpenSea, Rodeo, Blur, Basescan) fetch this JSON to display name,
 * image, attributes. Without it the NFT shows up as "Unknown" — making
 * the whole stealth-NFT feature useless for marketing.
 *
 * Public, no auth, cacheable. Returns 404 for missing or non-public agents.
 *
 * Format reference: https://docs.opensea.io/docs/metadata-standards
 */
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '~/db';
import { agents } from '~/db/schema';

export const nftMetaRoutes = new Hono();

/**
 * Build OpenSea-compatible metadata JSON for an agent slug.
 *
 * Trade-offs:
 * - `image` points to a deterministic SVG generator at the frontend
 *   (`/agent-card/:slug.svg`) so each agent has a unique visual without
 *   needing IPFS upload. If you later upload real renders, just change
 *   the URL here — the on-chain tokenURI stays the same since it points
 *   to this endpoint, not the image directly.
 * - `external_url` deep-links into the live agent page so anyone holding
 *   the NFT can chat with their agent from the wallet UI.
 */
async function buildMetadata(slug: string) {
  const [a] = await db.select().from(agents).where(eq(agents.slug, slug)).limit(1);
  if (!a || !a.public) return null;

  const tools = Array.isArray(a.allowedTools) ? (a.allowedTools as string[]) : [];
  const frontendBase = process.env.FRONTEND_BASE_URL || 'https://axon-5zf.pages.dev';

  return {
    name: a.name,
    description:
      a.description ||
      `${a.name} — agente de IA criado em Axon. Cada agente é um NFT único na Base, comprovando autoria e permitindo transferência on-chain.`,
    // Deterministic per-slug fallback — replace with real renders later.
    image: `${frontendBase}/agent-card/${encodeURIComponent(a.slug)}.svg`,
    external_url: `${frontendBase}/agent/${encodeURIComponent(a.slug)}`,
    background_color: (a.primaryColor || '#7c5cff').replace('#', ''),
    attributes: [
      { trait_type: 'Template', value: a.template || 'custom' },
      { trait_type: 'Tools', value: tools.length, display_type: 'number' },
      { trait_type: 'Pay Mode', value: a.payMode },
      { trait_type: 'Tier Required', value: a.tierRequired },
      { trait_type: 'Language', value: a.uiLanguage },
      ...(a.createdAt
        ? [{ trait_type: 'Created', display_type: 'date', value: Math.floor(new Date(a.createdAt).getTime() / 1000) }]
        : []),
    ],
  };
}

// /:slug.json — Basescan / OpenSea convention (file extension)
nftMetaRoutes.get('/:slugJson', async (c) => {
  const param = c.req.param('slugJson');
  const slug = param.endsWith('.json') ? param.slice(0, -5) : param;
  const meta = await buildMetadata(slug);
  if (!meta) return c.json({ error: 'not_found' }, 404);
  // 1h cache + revalidation: agents rarely change, marketplaces hammer this.
  c.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  // Cross-origin: marketplaces (OpenSea, Basescan) on different domains
  // need to fetch metadata. Override secureHeaders default.
  c.header('Cross-Origin-Resource-Policy', 'cross-origin');
  return c.json(meta);
});
