/**
 * Agent factory CRUD + public config endpoint.
 *
 * - Authed routes (mounted under /v1/agents): owner-only CRUD.
 * - Public routes (mounted before auth):
 *     GET /v1/agents/templates     → list of starter templates
 *     GET /v1/agents/by-slug/:slug → public-flagged agent config (drives /agent/:slug)
 */
import { Hono } from 'hono';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '~/db';
import { agents, requests, agentMessages, users, wallets, whatsappConnections, contactMemory } from '~/db/schema';
import { Errors } from '~/lib/errors';
import { decrypt } from '~/lib/crypto';
import { AGENT_TEMPLATES, getTemplate, AXON_SOUL_PROMPT } from '~/agents/templates';
import { getCacheStats } from '~/agents/knowledge-cache';
import { mintAgentNft, buildMetadataUrl, isNftEnabled } from '~/nft/agent-nft';
import { deleteInstance } from '~/whatsapp/evolution';
import { fromMicro, toMicro } from '~/wallet/service';
import { effectiveTier, type Tier } from '~/subscription';

// Order: free < pro < team < enterprise
const TIER_RANK: Record<string, number> = { free: 0, pro: 1, team: 2, enterprise: 3 };
function userMeetsTier(user: { tier: string; tierExpiresAt: Date | null }, required: string): boolean {
  const eff = effectiveTier({ tier: user.tier, tierExpiresAt: user.tierExpiresAt });
  return TIER_RANK[eff] >= (TIER_RANK[required] ?? 0);
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reservedSlug(s: string) {
  return ['new', 'templates', 'by-slug', 'admin', 'api'].includes(s);
}

// Accept either UUID or slug as the path identifier. Postgres throws
// "invalid input syntax for type uuid" if you eq() a non-UUID against a uuid
// column, so we route to slug when the param doesn't look like a UUID.
function whereAgentByIdOrSlug(idOrSlug: string, ownerId: string) {
  const match = UUID_RE.test(idOrSlug)
    ? eq(agents.id, idOrSlug)
    : eq(agents.slug, idOrSlug);
  return and(match, eq(agents.ownerId, ownerId));
}

// ============ Public routes (no auth) ============
export const publicRoutes = new Hono();

publicRoutes.get('/templates', (c) => {
  return c.json({
    templates: AGENT_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      emoji: t.emoji,
      image_url: t.imageUrl,
      description: t.description,
      category: t.category,
      target: t.target,
      monthly_price_brl: t.monthly_price_brl,
      primary_color: t.primaryColor,
      tool_count: t.tools.length,
    })),
  });
});

publicRoutes.get('/templates/:id', (c) => {
  const t = getTemplate(c.req.param('id'));
  if (!t) throw Errors.notFound('Template');
  return c.json(t);
});

// Public shape for runner. system_prompt(_b) IS exposed so the client-side
// runner can build the LLM messages array — it isn't a secret in practice
// (anyone can probe a deployed agent's behavior anyway).
async function publicShape(a: typeof agents.$inferSelect) {
  return {
    slug: a.slug,
    name: a.name,
    description: a.description,
    system_prompt: a.systemPrompt,
    system_prompt_b: a.systemPromptB,
    ab_split: a.abSplit,
    allowed_tools: a.allowedTools,
    primary_color: a.primaryColor,
    welcome_message: a.welcomeMessage,
    quick_prompts: a.quickPrompts,
    budget_per_session_usdc: fromMicro(a.budgetPerSession),
    hard_cap_usdc: fromMicro(a.hardCap),
    pay_mode: a.payMode,
    daily_budget_usdc: fromMicro(a.dailyBudgetMicro),
    ui_language: a.uiLanguage,
  };
}

// Public discovery feed — drives /explore. Lists public agents with
// derived popularity (call count over last 30d) + the same metadata
// the runner needs so cards can be rendered without a second fetch.
publicRoutes.get('/explore', async (c) => {
  const category = c.req.query('category');  // optional filter (matches template id substring)
  const language = c.req.query('language');  // 'pt' | 'en' | 'es' | undefined
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10), 1), 100);

  // Pull public agents + 30d call count from requests
  const rows = await db.execute(sql`
    SELECT
      a.id, a.slug, a.name, a.description, a.primary_color,
      a.template, a.ui_language, a.welcome_message,
      a.allowed_tools, a.pay_mode, a.created_at,
      COALESCE(r.cnt, 0)::bigint AS calls_30d
    FROM agents a
    LEFT JOIN (
      SELECT agent_id, COUNT(*) AS cnt
      FROM requests
      WHERE created_at >= NOW() - INTERVAL '30 days'
        AND agent_id IS NOT NULL
      GROUP BY agent_id
    ) r ON r.agent_id = a.id
    WHERE a.public = true
      ${category ? sql`AND a.template ILIKE ${'%' + category + '%'}` : sql``}
      ${language ? sql`AND (a.ui_language = ${language} OR a.ui_language = 'auto')` : sql``}
    ORDER BY calls_30d DESC, a.created_at DESC
    LIMIT ${limit}
  `);
  const data = ((rows as any).rows ?? (rows as any) ?? []) as any[];

  // Resolve each agent's template id to its hero image, so the /explore
  // page can render real photos instead of emojis without an extra lookup.
  // Falls back to undefined if the agent's `template` field doesn't match
  // a known template (legacy agents or hand-crafted ones).
  const templateImageBySlug: Record<string, string | undefined> = {};
  for (const t of AGENT_TEMPLATES) templateImageBySlug[t.id] = t.imageUrl;

  return c.json({
    data: data.map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      primary_color: r.primary_color,
      template: r.template,
      template_image: r.template ? templateImageBySlug[r.template] || null : null,
      ui_language: r.ui_language,
      tool_count: Array.isArray(r.allowed_tools) ? r.allowed_tools.length : 0,
      pay_mode: r.pay_mode,
      free_to_chat: r.pay_mode === 'owner',
      calls_30d: Number(r.calls_30d || 0),
      created_at: r.created_at,
    })),
    count: data.length,
  });
});

publicRoutes.get('/by-slug/:slug', async (c) => {
  const slug = c.req.param('slug');
  const [a] = await db.select().from(agents).where(eq(agents.slug, slug)).limit(1);
  if (!a || !a.public) throw Errors.notFound('Agent');
  return c.json(await publicShape(a));
});

// Vanity domain lookup — embed.js / DNS proxy hits this when serving a
// custom domain like agent.cliente.com to find which slug to render.
publicRoutes.get('/by-domain/:domain', async (c) => {
  const domain = c.req.param('domain').toLowerCase();
  const [a] = await db.select().from(agents).where(eq(agents.vanityDomain, domain)).limit(1);
  if (!a || !a.public) throw Errors.notFound('Agent');
  return c.json(await publicShape(a));
});

// ============ Authed routes (mounted under /v1) ============
const app = new Hono();

/**
 * Build the public NFT view URL for an agent. Shape depends on NFT_RPC_URL:
 * - sepolia → sepolia.basescan.org
 * - else    → basescan.org (mainnet)
 *
 * Returns null when NFT is disabled (no contract configured) so the dashboard
 * can omit the badge entirely.
 */
function nftViewUrlFor(agentId: string): string | null {
  const contract = process.env.NFT_CONTRACT_ADDRESS;
  if (!contract || !isNftEnabled()) return null;
  const isSepolia = /sepolia/i.test(process.env.NFT_RPC_URL || '');
  const explorer = isSepolia ? 'https://sepolia.basescan.org' : 'https://basescan.org';
  // tokenId derived deterministically from UUID (matches uuidToTokenId in agent-nft.ts).
  const tokenIdHex = agentId.replace(/-/g, '');
  const tokenIdDec = BigInt('0x' + tokenIdHex).toString();
  return `${explorer}/nft/${contract}/${tokenIdDec}`;
}

// List my agents
app.get('/', async (c) => {
  const user = c.get('user') as { id: string };
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.ownerId, user.id))
    .orderBy(desc(agents.updatedAt));
  return c.json({
    data: rows.map((a) => ({
      id: a.id,
      slug: a.slug,
      name: a.name,
      description: a.description,
      template: a.template,
      tool_count: Array.isArray(a.allowedTools) ? a.allowedTools.length : 0,
      primary_color: a.primaryColor,
      public: a.public,
      pay_mode: a.payMode,
      daily_budget_usdc: fromMicro(a.dailyBudgetMicro),
      budget_per_session_usdc: fromMicro(a.budgetPerSession),
      hard_cap_usdc: fromMicro(a.hardCap),
      nft_url: nftViewUrlFor(a.id),
      persona_id: a.personaId,
      routes_to: a.routesTo,
      paused: !!a.pausedAt,
      paused_at: a.pausedAt,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
    })),
    count: rows.length,
  });
});

// Get one (by uuid OR slug, owned)
app.get('/:id', async (c) => {
  const user = c.get('user') as { id: string };
  const idOrSlug = c.req.param('id');
  const [a] = await db
    .select()
    .from(agents)
    .where(whereAgentByIdOrSlug(idOrSlug, user.id));
  if (!a) throw Errors.notFound('Agent');
  return c.json({
    id: a.id,
    slug: a.slug,
    name: a.name,
    description: a.description,
    system_prompt: a.systemPrompt,
    system_prompt_b: a.systemPromptB,
    ab_split: a.abSplit,
    allowed_tools: a.allowedTools,
    primary_color: a.primaryColor,
    welcome_message: a.welcomeMessage,
    quick_prompts: a.quickPrompts,
    budget_per_session_usdc: fromMicro(a.budgetPerSession),
    hard_cap_usdc: fromMicro(a.hardCap),
    pay_mode: a.payMode,
    daily_budget_usdc: fromMicro(a.dailyBudgetMicro),
    tier_required: a.tierRequired,
    vanity_domain: a.vanityDomain,
    ui_language: a.uiLanguage,
    public: a.public,
    template: a.template,
    persona_id: a.personaId,
    owner_phone: a.ownerPhone,
    routes_to: a.routesTo,
    affiliate_enabled: a.affiliateEnabled,
    affiliate_payout_usdc: (Number(a.affiliatePayoutMicro) / 1_000_000).toFixed(6),
    paused_at: a.pausedAt,
    paused: !!a.pausedAt,
    business_info: a.businessInfo || '',
    voice_enabled: a.voiceEnabled !== false,
    voice_id_override: a.voiceIdOverride || '',
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  });
});

// Create
app.post('/', async (c) => {
  const user = c.get('user') as { id: string; tier: string; tierExpiresAt: Date | null };
  const body = await c.req.json().catch(() => ({}));
  const slug = String(body.slug || '').toLowerCase().trim();
  if (!SLUG_RE.test(slug)) throw Errors.badRequest('slug must be 2-40 chars, [a-z0-9-], not start/end with hyphen');
  if (reservedSlug(slug)) throw Errors.badRequest(`slug '${slug}' is reserved`);

  // Optional: clone from a template
  let seed: any = {};
  if (body.template) {
    const t = getTemplate(body.template);
    if (!t) throw Errors.badRequest(`Unknown template: ${body.template}`);
    seed = {
      name: t.name,
      description: t.description,
      // Append the Axon "soul" — memory recall, time-aware greetings, tool
      // transparency, vision/audio/pix awareness — to every template-cloned
      // agent. Keeps cross-agent behavior consistent so customers don't have
      // to manually wire these in.
      systemPrompt: t.systemPrompt + AXON_SOUL_PROMPT,
      allowedTools: t.tools,
      primaryColor: t.primaryColor,
      welcomeMessage: t.welcomeMessage,
      quickPrompts: t.quickPrompts,
      template: t.id,
    };
  }

  // Optional persona — accept either UUID (persona_id) or slug (persona_slug).
  // We resolve the slug here so the insert always stores the canonical id.
  let personaId: string | null = null;
  if (body.persona_id || body.persona_slug) {
    const { personas } = await import('~/db/schema');
    if (body.persona_id) {
      const [p] = await db.select().from(personas).where(eq(personas.id, String(body.persona_id))).limit(1);
      personaId = p?.id ?? null;
    } else if (body.persona_slug) {
      const [p] = await db.select().from(personas).where(eq(personas.slug, String(body.persona_slug))).limit(1);
      personaId = p?.id ?? null;
    }
    if (!personaId) {
      throw Errors.badRequest(`Unknown persona: ${body.persona_id || body.persona_slug}`);
    }
  }

  // Cap free-text fields at sane sizes. Without these caps a single
  // POST with a 1MB system_prompt amplifies into every LLM call, draining
  // the daily_budget in seconds. Caps mirror what the dashboard form
  // already enforces client-side; this is the server-side defence.
  const SYSTEM_PROMPT_MAX = 8000;
  const DESC_MAX = 1000;
  const WELCOME_MAX = 500;
  const QUICK_PROMPT_MAX = 200;
  const cap = (v: unknown, n: number) => String(v ?? '').slice(0, n);
  const rawPrompt = body.system_prompt ?? seed.systemPrompt ?? 'You are a helpful AI assistant.';

  const insert = {
    ownerId: user.id,
    slug,
    name: String(body.name || seed.name || 'Untitled agent').slice(0, 80),
    description: body.description != null ? cap(body.description, DESC_MAX) : seed.description ?? null,
    systemPrompt: cap(rawPrompt, SYSTEM_PROMPT_MAX),
    allowedTools: Array.isArray(body.allowed_tools)
      ? body.allowed_tools.slice(0, 64).map((t: unknown) => String(t).slice(0, 80))
      : (seed.allowedTools ?? []),
    primaryColor: body.primary_color ? String(body.primary_color).slice(0, 16) : seed.primaryColor ?? '#7c5cff',
    welcomeMessage: body.welcome_message != null ? cap(body.welcome_message, WELCOME_MAX) : seed.welcomeMessage ?? null,
    quickPrompts: Array.isArray(body.quick_prompts)
      ? body.quick_prompts.slice(0, 8).map((p: unknown) => String(p).slice(0, QUICK_PROMPT_MAX))
      : seed.quickPrompts ?? null,
    budgetPerSession: body.budget_per_session_usdc != null ? toMicro(String(body.budget_per_session_usdc)) : 500_000n,
    hardCap: body.hard_cap_usdc != null ? toMicro(String(body.hard_cap_usdc)) : 2_000_000n,
    payMode: body.pay_mode === 'owner' ? 'owner' : 'visitor',
    dailyBudgetMicro: body.daily_budget_usdc != null ? toMicro(String(body.daily_budget_usdc)) : 5_000_000n,
    tierRequired: ['free','pro','team','enterprise'].includes(body.tier_required) ? body.tier_required : 'free',
    systemPromptB: body.system_prompt_b != null ? cap(body.system_prompt_b, SYSTEM_PROMPT_MAX) : null,
    abSplit: Math.max(0, Math.min(100, parseInt(body.ab_split, 10) || 0)),
    vanityDomain: body.vanity_domain ? String(body.vanity_domain).toLowerCase().trim().slice(0, 200) : null,
    uiLanguage: ['auto','pt','en','es'].includes(body.ui_language) ? body.ui_language : 'auto',
    public: body.public !== false,
    template: seed.template ?? (body.template ? String(body.template).slice(0, 80) : null),
    personaId,
    voiceEnabled: typeof body.voice_enabled === 'boolean' ? body.voice_enabled : true,
    voiceIdOverride:
      body.voice_id_override && /^[A-Za-z0-9]{8,40}$/.test(String(body.voice_id_override).trim())
        ? String(body.voice_id_override).trim()
        : null,
  };

  // Enforce tier gate on the OWNER (current user). If they pick a
  // tier_required higher than their own active tier, bounce the request.
  if (insert.tierRequired !== 'free') {
    if (!userMeetsTier(user, insert.tierRequired)) {
      throw Errors.forbidden();
    }
  }

  try {
    const [created] = await db.insert(agents).values(insert).returning();

    // ─── NFT mint silencioso ─────────────────────────────────
    // Usuário não vê isso. Mintamos no background pra ter ownership on-chain.
    // Falha não bloqueia criação — agente funciona mesmo sem NFT.
    if (isNftEnabled()) {
      // Resolve user wallet address (Privy embedded or external)
      const [walletRow] = await db
        .select()
        .from(wallets)
        .where(eq(wallets.userId, user.id))
        .limit(1);
      const userWallet = walletRow?.address;
      if (userWallet && userWallet.startsWith('0x') && !userWallet.startsWith('0x0000000')) {
        // Fire-and-forget mint — don't block response on chain confirmation
        void mintAgentNft({
          to: userWallet,
          agentId: created.id,
          slug: created.slug,
          metadataUrl: buildMetadataUrl(created.slug),
        }).catch(() => {/* logged inside */});
      }
    }

    // Confirmation email — fire-and-forget. Looks up the user's email lazily
    // (the auth middleware only injects {id, tier, ...}, not always email).
    void (async () => {
      try {
        const [u] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
        if (!u || !u.email) return;
        const { sendEmail } = await import('~/email/client');
        const { agentCreatedEmail } = await import('~/email/templates');
        const t = agentCreatedEmail({
          agentName: created.name,
          agentSlug: created.slug,
          nftUrl: nftViewUrlFor(created.id),
        });
        await sendEmail({ to: u.email, subject: t.subject, html: t.html, text: t.text, tag: 'agent_created' });
      } catch {/* email is best-effort */}
    })();

    return c.json({
      ok: true,
      id: created.id,
      slug: created.slug,
      name: created.name,
      url: `/agent/${created.slug}`,
    }, 201);
  } catch (e: any) {
    if (String(e?.message || e).includes('agents_slug_idx')) {
      throw Errors.badRequest(`slug '${slug}' is already taken`);
    }
    throw e;
  }
});

// Update
app.patch('/:id', async (c) => {
  const user = c.get('user') as { id: string };
  const idOrSlug = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  const [existing] = await db
    .select()
    .from(agents)
    .where(whereAgentByIdOrSlug(idOrSlug, user.id));
  if (!existing) throw Errors.notFound('Agent');
  const id = existing.id;

  const update: any = { updatedAt: new Date() };
  if (body.name != null) update.name = String(body.name).slice(0, 80);
  if (body.description != null) update.description = String(body.description);
  if (body.system_prompt != null) update.systemPrompt = String(body.system_prompt);
  if (Array.isArray(body.allowed_tools)) update.allowedTools = body.allowed_tools;
  if (body.primary_color != null) update.primaryColor = String(body.primary_color);
  if (body.welcome_message != null) update.welcomeMessage = String(body.welcome_message);
  if (Array.isArray(body.quick_prompts)) update.quickPrompts = body.quick_prompts;
  if (body.budget_per_session_usdc != null) update.budgetPerSession = toMicro(String(body.budget_per_session_usdc));
  if (body.hard_cap_usdc != null) update.hardCap = toMicro(String(body.hard_cap_usdc));
  if (body.pay_mode === 'visitor' || body.pay_mode === 'owner') update.payMode = body.pay_mode;
  if (body.daily_budget_usdc != null) update.dailyBudgetMicro = toMicro(String(body.daily_budget_usdc));
  if (typeof body.public === 'boolean') update.public = body.public;
  if (['free','pro','team','enterprise'].includes(body.tier_required)) update.tierRequired = body.tier_required;
  if (body.system_prompt_b !== undefined) update.systemPromptB = body.system_prompt_b ? String(body.system_prompt_b) : null;
  if (body.ab_split !== undefined) update.abSplit = Math.max(0, Math.min(100, parseInt(body.ab_split, 10) || 0));
  if (body.vanity_domain !== undefined) update.vanityDomain = body.vanity_domain ? String(body.vanity_domain).toLowerCase().trim() : null;
  if (['auto','pt','en','es'].includes(body.ui_language)) update.uiLanguage = body.ui_language;
  if (body.owner_phone !== undefined) {
    // Empty string clears it; otherwise normalize to digits-only and validate length.
    if (body.owner_phone === null || body.owner_phone === '') {
      update.ownerPhone = null;
    } else {
      const digits = String(body.owner_phone).replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) {
        return c.json({ error: 'bad_request', message: 'owner_phone must be 10–15 digits (E.164 without +)' }, 400);
      }
      update.ownerPhone = digits;
    }
  }
  if (body.affiliate_enabled !== undefined) {
    update.affiliateEnabled = !!body.affiliate_enabled;
  }
  // Pause/resume — accepts boolean. true sets paused_at=now (mutes the
  // agent on every channel until unpaused). false clears it.
  if (body.paused !== undefined) {
    update.pausedAt = body.paused ? new Date() : null;
  }
  // Persona — accept either UUID (persona_id) or slug (persona_slug). The
  // canonical id is what we store. null/empty clears the persona so the
  // agent reverts to its default voice.
  if (body.persona_id !== undefined || body.persona_slug !== undefined) {
    if (!body.persona_id && !body.persona_slug) {
      update.personaId = null;
    } else {
      const { personas } = await import('~/db/schema');
      let resolved: string | null = null;
      if (body.persona_id) {
        const [p] = await db.select().from(personas).where(eq(personas.id, String(body.persona_id))).limit(1);
        resolved = p?.id ?? null;
      } else if (body.persona_slug) {
        const [p] = await db.select().from(personas).where(eq(personas.slug, String(body.persona_slug))).limit(1);
        resolved = p?.id ?? null;
      }
      if (!resolved) {
        return c.json({ error: 'unknown_persona', message: `Unknown persona: ${body.persona_id || body.persona_slug}` }, 400);
      }
      update.personaId = resolved;
    }
  }
  // Business info — free-text reference data the owner wants the agent
  // to know (address, hours, prices, etc). Empty string clears it.
  if (body.business_info !== undefined) {
    const v = String(body.business_info || '').slice(0, 4000);
    update.businessInfo = v.trim() ? v : null;
  }
  // Voice on/off + per-agent voice override. Aceita ElevenLabs (20-32
  // alfanuméricos) ou Cartesia (UUID v4). Empty string clears the
  // override (revert pra persona default ou DEFAULT_VOICE_ID do provider).
  if (typeof body.voice_enabled === 'boolean') {
    update.voiceEnabled = body.voice_enabled;
  }
  if (body.voice_id_override !== undefined) {
    const raw = String(body.voice_id_override || '').trim();
    const ELEVEN_RE = /^[A-Za-z0-9]{8,40}$/;
    const CARTESIA_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!raw) {
      update.voiceIdOverride = null;
    } else if (!ELEVEN_RE.test(raw) && !CARTESIA_RE.test(raw)) {
      return c.json({ error: 'bad_request', message: 'voice_id_override deve ser ElevenLabs id (8-40 alfanum) ou Cartesia UUID' }, 400);
    } else {
      update.voiceIdOverride = raw;
    }
  }
  if (body.affiliate_payout_usdc !== undefined) {
    // USDC value comes as a string (e.g. "0.20"). Convert to micro-USDC,
    // clamp to a reasonable range so the owner can't accidentally configure
    // an absurd payout (the form validates too but defense in depth).
    const v = parseFloat(String(body.affiliate_payout_usdc));
    if (!isFinite(v) || v < 0 || v > 5) {
      return c.json({ error: 'bad_request', message: 'affiliate_payout_usdc must be between 0 and 5' }, 400);
    }
    update.affiliatePayoutMicro = BigInt(Math.round(v * 1_000_000));
  }
  if (body.routes_to !== undefined) {
    // routes_to: { sales?: agentId, personal?: agentId, support?: agentId }
    // null/empty clears routing — agent goes back to handling everything itself.
    // Each value MUST point to another agent owned by the same user; we
    // verify ownership here so a misconfigured routes_to can't leak chats
    // to another tenant's agent.
    if (body.routes_to === null || (typeof body.routes_to === 'object' && Object.keys(body.routes_to).length === 0)) {
      update.routesTo = null;
    } else if (typeof body.routes_to === 'object') {
      const wanted = body.routes_to as Record<string, unknown>;
      const cleaned: Record<string, string> = {};
      for (const key of ['sales', 'personal', 'support']) {
        const targetId = wanted[key];
        if (typeof targetId === 'string' && targetId.length > 0) {
          // Validate target ownership against the SAME user.id we're
          // updating with. The full PATCH runs in a single transaction
          // below so this read participates in the same snapshot — the
          // attacker can't transfer the target between this check and
          // the UPDATE.
          const [target] = await db.select().from(agents).where(eq(agents.id, targetId)).limit(1);
          if (!target || target.ownerId !== user.id) {
            return c.json({ error: 'bad_request', message: `routes_to.${key} must point to an agent you own` }, 400);
          }
          cleaned[key] = targetId;
        }
      }
      update.routesTo = Object.keys(cleaned).length ? cleaned : null;
    } else {
      return c.json({ error: 'bad_request', message: 'routes_to must be an object or null' }, 400);
    }
  }
  // Belt-and-suspenders ownership: include ownerId in the WHERE so even
  // if the agent was transferred between the lookup at the top of this
  // handler and now, we never UPDATE someone else's row.
  await db.update(agents).set(update).where(and(eq(agents.id, id), eq(agents.ownerId, user.id)));
  return c.json({ ok: true });
});

// Analytics — owner-only
app.get('/:id/analytics', async (c) => {
  const user = c.get('user') as { id: string };
  const idOrSlug = c.req.param('id');
  const days = Math.min(Math.max(parseInt(c.req.query('days') || '30', 10), 1), 90);

  // Verify ownership (slug or uuid)
  const [a] = await db
    .select()
    .from(agents)
    .where(whereAgentByIdOrSlug(idOrSlug, user.id));
  if (!a) throw Errors.notFound('Agent');
  const id = a.id;

  // Totals across the window
  const totalsRow = await db.execute(sql`
    SELECT
      COUNT(*)::bigint                                              AS calls,
      COALESCE(SUM(cost_micro + markup_micro), 0)::bigint            AS gross_micro,
      COALESCE(SUM(markup_micro), 0)::bigint                          AS net_micro,
      COUNT(*) FILTER (WHERE cache_hit)::bigint                       AS cache_hits,
      COALESCE(AVG(latency_ms), 0)::float                             AS avg_latency_ms,
      COUNT(*) FILTER (WHERE status >= 400)::bigint                   AS errors
    FROM requests
    WHERE agent_id = ${id}
      AND created_at >= NOW() - (${days} || ' days')::interval
  `);
  const totals = (totalsRow as any).rows?.[0] ?? (totalsRow as any)[0] ?? {};

  // Daily timeseries
  const tsRow = await db.execute(sql`
    SELECT
      DATE(created_at) AS day,
      COUNT(*)::bigint AS calls,
      COALESCE(SUM(cost_micro + markup_micro), 0)::bigint AS gross_micro
    FROM requests
    WHERE agent_id = ${id}
      AND created_at >= NOW() - (${days} || ' days')::interval
    GROUP BY day
    ORDER BY day
  `);
  const ts = ((tsRow as any).rows ?? (tsRow as any) ?? []) as Array<any>;

  // Top tools
  const toolsRow = await db.execute(sql`
    SELECT
      api_slug,
      endpoint,
      COUNT(*)::bigint AS calls,
      COALESCE(SUM(cost_micro + markup_micro), 0)::bigint AS gross_micro,
      COUNT(*) FILTER (WHERE cache_hit)::bigint AS cache_hits
    FROM requests
    WHERE agent_id = ${id}
      AND created_at >= NOW() - (${days} || ' days')::interval
    GROUP BY api_slug, endpoint
    ORDER BY calls DESC
    LIMIT 10
  `);
  const byTool = ((toolsRow as any).rows ?? (toolsRow as any) ?? []) as Array<any>;

  const calls = Number(totals.calls ?? 0);
  const errors = Number(totals.errors ?? 0);
  const cacheHits = Number(totals.cache_hits ?? 0);

  return c.json({
    window_days: days,
    agent_id: a.id,
    agent_slug: a.slug,
    totals: {
      calls,
      gross_usdc: fromMicro(BigInt(totals.gross_micro ?? 0)),
      net_usdc: fromMicro(BigInt(totals.net_micro ?? 0)),
      cache_hit_rate: calls > 0 ? Number((cacheHits / calls).toFixed(4)) : 0,
      error_rate: calls > 0 ? Number((errors / calls).toFixed(4)) : 0,
      avg_latency_ms: Math.round(Number(totals.avg_latency_ms ?? 0)),
    },
    timeseries: ts.map((r: any) => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
      calls: Number(r.calls),
      gross_usdc: fromMicro(BigInt(r.gross_micro ?? 0)),
    })),
    by_tool: byTool.map((r: any) => ({
      api_slug: r.api_slug,
      endpoint: r.endpoint,
      calls: Number(r.calls),
      gross_usdc: fromMicro(BigInt(r.gross_micro ?? 0)),
      cache_hit_rate: Number(r.calls) > 0 ? Number((Number(r.cache_hits) / Number(r.calls)).toFixed(4)) : 0,
    })),
  });
});

// Agent health — Wave 2C of brain instrumentation.
//
// Aggregates the judge eval verdicts across the last N assistant turns
// into a single dashboard pill: "saúde 84% ↗ +6 vs semana passada".
// Plus the top recurring issues so the operator can spot patterns
// (e.g. "agente ignorou alergia salva: 4×").
//
// Returns nulls when there's no data yet (fewer than 5 judged turns) —
// frontend hides the pill in that case rather than showing "0%".
app.get('/:id/health', async (c) => {
  const user = c.get('user') as { id: string };
  const idOrSlug = c.req.param('id');
  const [a] = await db
    .select()
    .from(agents)
    .where(whereAgentByIdOrSlug(idOrSlug, user.id))
    .limit(1);
  if (!a) throw Errors.notFound('Agent');

  // Pull the last 100 assistant turns with eval populated. We do this in two
  // SELECTs because Drizzle's jsonb path operators don't play well with the
  // generic builder — easier to filter in JS.
  const rows = await db
    .select({ meta: agentMessages.meta, createdAt: agentMessages.createdAt })
    .from(agentMessages)
    .where(and(eq(agentMessages.agentId, a.id), eq(agentMessages.role, 'assistant')))
    .orderBy(desc(agentMessages.createdAt))
    .limit(200);

  const judged = rows
    .map((r) => {
      const meta = r.meta as { eval?: { score?: number; issues?: string[]; veredito?: string } } | null;
      if (!meta?.eval || typeof meta.eval.score !== 'number') return null;
      return {
        score: meta.eval.score,
        issues: Array.isArray(meta.eval.issues) ? meta.eval.issues : [],
        veredito: meta.eval.veredito,
        createdAt: r.createdAt as Date,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Knowledge-use aggregates — independent of judge eval, computed
  // across ALL recent assistant turns that have meta. Tells the operator
  // whether the agent is actually USING what's been stored in memory and
  // configured in business_info, not just sitting on it.
  const withMeta = rows.filter((r) => r.meta && typeof r.meta === 'object').slice(0, 100);
  let memoryUseHits = 0;
  let memoryUseEligible = 0;       // turns where memory had at least one fact loaded
  let businessUseHits = 0;
  let businessUseEligible = 0;     // turns where business_info was used in injection
  let totalContextChars = 0;
  for (const r of withMeta) {
    const m = r.meta as Record<string, unknown>;
    const factsLoaded = Array.isArray(m.facts_loaded) ? m.facts_loaded : [];
    const factsUsed = Array.isArray(m.facts_used) ? m.facts_used : [];
    if (factsLoaded.length > 0) {
      memoryUseEligible++;
      if (factsUsed.length > 0) memoryUseHits++;
    }
    // We can't tell from here whether business_info was non-empty per
    // turn (the field isn't stored). Approximate: if any turn ever shows
    // business_info_used=true, treat all turns as eligible. For agents
    // with empty business_info this whole rate stays 0.
    if (m.business_info_used === true) businessUseHits++;
    if (typeof m.context_chars === 'number') totalContextChars += m.context_chars;
  }
  // Eligibility for business_info: count any turn where context_chars > 200
  // as eligible (a non-trivial system prompt). Avoids dividing by zero
  // and gives a usable percentage for agents with business_info filled in.
  businessUseEligible = withMeta.filter((r) => {
    const m = r.meta as Record<string, unknown>;
    return typeof m.context_chars === 'number' && m.context_chars > 200;
  }).length;

  const memoryUseRate = memoryUseEligible > 0
    ? Math.round((memoryUseHits / memoryUseEligible) * 100)
    : null;
  const businessInfoUseRate = businessUseEligible > 0
    ? Math.round((businessUseHits / businessUseEligible) * 100)
    : null;
  const avgContextChars = withMeta.length > 0
    ? Math.round(totalContextChars / withMeta.length)
    : null;

  // Cost-per-resolved-arc: pull contact_memory rows where arc.state='resolved'
  // and sum cost_usdc from their assistant turns. Useful "is this agent
  // economically viable?" signal.
  const resolvedContacts = await db
    .select({ phone: contactMemory.phone })
    .from(contactMemory)
    .where(and(
      eq(contactMemory.agentId, a.id),
      // jsonb path: arc->>'state' = 'resolved'
      sql`${contactMemory.arc}->>'state' = 'resolved'`,
    ))
    .limit(50);
  let costPerResolvedArc: number | null = null;
  if (resolvedContacts.length > 0) {
    const sessionIds = resolvedContacts.map((c) => 'wa:' + c.phone);
    // Pull just the cost field from each session's assistant rows.
    const costRows = await db
      .select({ meta: agentMessages.meta })
      .from(agentMessages)
      .where(and(
        eq(agentMessages.agentId, a.id),
        eq(agentMessages.role, 'assistant'),
        sql`${agentMessages.sessionId} IN (${sql.raw(sessionIds.map((s) => `'${s.replace(/'/g, "''")}'`).join(','))})`,
      ))
      .limit(2000);
    let totalCost = 0;
    for (const row of costRows) {
      const m = row.meta as Record<string, unknown> | null;
      const c = m && typeof m.cost_usdc === 'string' ? parseFloat(m.cost_usdc) : 0;
      if (Number.isFinite(c)) totalCost += c;
    }
    costPerResolvedArc = parseFloat((totalCost / resolvedContacts.length).toFixed(6));
  }

  if (judged.length < 5) {
    return c.json({
      avg_score: null,
      score_trend: null,
      total_judged: judged.length,
      total_assistant_turns: rows.length,
      top_issues: [],
      bucket_counts: { great: 0, ok: 0, ok_com_ressalva: 0, ruim: 0 },
      memory_use_rate: memoryUseRate,
      business_info_use_rate: businessInfoUseRate,
      avg_context_chars: avgContextChars,
      cost_per_resolved_arc: costPerResolvedArc,
    });
  }

  const last = judged.slice(0, 100);
  const avgScore = Math.round(last.reduce((s, x) => s + x.score, 0) / last.length);

  // Trend: last 7 days avg vs previous 7 days avg. Slice by createdAt.
  const now = Date.now();
  const week = 7 * 24 * 3600 * 1000;
  const thisWeek = last.filter((x) => now - x.createdAt.getTime() < week);
  const lastWeek = last.filter(
    (x) => now - x.createdAt.getTime() >= week && now - x.createdAt.getTime() < 2 * week,
  );
  let trend: number | null = null;
  if (thisWeek.length >= 3 && lastWeek.length >= 3) {
    const a1 = thisWeek.reduce((s, x) => s + x.score, 0) / thisWeek.length;
    const a2 = lastWeek.reduce((s, x) => s + x.score, 0) / lastWeek.length;
    trend = Math.round(a1 - a2);
  }

  // Top recurring issues. Lowercase + collapse whitespace so near-duplicates
  // ("não confirmou horário" vs "Não confirmou horário ") count together.
  const issueCounts = new Map<string, number>();
  for (const t of last) {
    for (const raw of t.issues) {
      const k = String(raw).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!k) continue;
      issueCounts.set(k, (issueCounts.get(k) || 0) + 1);
    }
  }
  const topIssues = Array.from(issueCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([issue, count]) => ({ issue, count }));

  const bucketCounts = { great: 0, ok: 0, ok_com_ressalva: 0, ruim: 0 };
  for (const t of last) {
    if (t.veredito && t.veredito in bucketCounts) {
      bucketCounts[t.veredito as keyof typeof bucketCounts]++;
    }
  }

  return c.json({
    avg_score: avgScore,
    score_trend: trend,
    total_judged: last.length,
    total_assistant_turns: rows.length,
    top_issues: topIssues,
    bucket_counts: bucketCounts,
    memory_use_rate: memoryUseRate,
    business_info_use_rate: businessInfoUseRate,
    avg_context_chars: avgContextChars,
    cost_per_resolved_arc: costPerResolvedArc,
  });
});

// Improvement loop — Wave 2D.
//
// GET → list of suggested system_prompt patches based on recurring issues.
// POST /apply → owner approves a patch; it gets appended to the agent's
// system_prompt as a "## Correções aprendidas" section. Idempotent —
// duplicate text isn't appended twice.
app.get('/:id/patches', async (c) => {
  const user = c.get('user') as { id: string };
  const idOrSlug = c.req.param('id');
  const [a] = await db
    .select()
    .from(agents)
    .where(whereAgentByIdOrSlug(idOrSlug, user.id))
    .limit(1);
  if (!a) throw Errors.notFound('Agent');

  // Reuse the same scan as /health but only surface issues that hit ≥3 times.
  // Each one becomes a suggested patch the owner can accept.
  const rows = await db
    .select({ meta: agentMessages.meta })
    .from(agentMessages)
    .where(and(eq(agentMessages.agentId, a.id), eq(agentMessages.role, 'assistant')))
    .orderBy(desc(agentMessages.createdAt))
    .limit(200);

  const counts = new Map<string, number>();
  for (const r of rows) {
    const meta = r.meta as { eval?: { issues?: string[] } } | null;
    if (!meta?.eval?.issues) continue;
    for (const raw of meta.eval.issues) {
      const k = String(raw).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!k) continue;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }

  // Map issue → suggested patch text. Keep it simple: turn the issue into
  // an instruction. If the issue is already in the system_prompt verbatim,
  // skip — owner already accepted it.
  const currentPrompt = a.systemPrompt || '';
  const patches = Array.from(counts.entries())
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([issue, count]) => ({
      issue,
      count,
      patch_text: issueToPatchText(issue),
      already_applied: currentPrompt.toLowerCase().includes(issueToPatchText(issue).toLowerCase().slice(0, 40)),
    }));

  return c.json({ patches });
});

app.post('/:id/patches/apply', async (c) => {
  const user = c.get('user') as { id: string };
  const idOrSlug = c.req.param('id');
  const body = await c.req.json().catch(() => ({} as any));
  const patchText = String(body?.patch_text || '').trim();
  if (!patchText) {
    return c.json({ error: 'bad_request', message: 'patch_text required' }, 400);
  }
  if (patchText.length > 500) {
    return c.json({ error: 'bad_request', message: 'patch_text too long (max 500)' }, 400);
  }

  const [a] = await db
    .select()
    .from(agents)
    .where(whereAgentByIdOrSlug(idOrSlug, user.id))
    .limit(1);
  if (!a) throw Errors.notFound('Agent');

  // Append to a stable section so multiple patches accumulate cleanly. If
  // the section already contains this text, no-op (idempotent).
  const SECTION = '\n\n## Correções aprendidas\n';
  const current = a.systemPrompt || '';
  if (current.toLowerCase().includes(patchText.toLowerCase().slice(0, 60))) {
    return c.json({ ok: true, applied: false, reason: 'already_present' });
  }
  const newPrompt = current.includes(SECTION)
    ? current.replace(SECTION, SECTION + `- ${patchText}\n`)
    : current + SECTION + `- ${patchText}\n`;

  // Hard cap so we don't let the prompt grow unboundedly via patches.
  if (newPrompt.length > 16000) {
    return c.json({ error: 'prompt_too_long', message: 'system_prompt would exceed 16000 chars' }, 400);
  }

  await db.update(agents).set({ systemPrompt: newPrompt, updatedAt: new Date() }).where(eq(agents.id, a.id));
  return c.json({ ok: true, applied: true, system_prompt_length: newPrompt.length });
});

// ─── Catalog management ─────────────────────────────────────
// Owner uploads a CSV or JSON of inventory items. The parser detects
// well-known fields (name, price, region, etc) by alias and stores
// the normalized array in agents.catalog (jsonb). Agent runtime
// injects a preview into the system prompt and exposes search_catalog
// as a tool for dynamic lookups. Source of truth so the LLM doesn't
// invent properties / products to fill silence.
app.post('/:id/catalog/upload', async (c) => {
  const user = c.get('user') as { id: string };
  const idOrSlug = c.req.param('id');
  const [a] = await db
    .select()
    .from(agents)
    .where(whereAgentByIdOrSlug(idOrSlug, user.id))
    .limit(1);
  if (!a) throw Errors.notFound('Agent');

  // Three input paths supported, ordered by typical end-user friendliness:
  //   1. JSON body { items: [...] } — pre-parsed from the inline table
  //      editor (no parsing, just validation + save). Friendliest path
  //      because operator never touches a spreadsheet.
  //   2. JSON body { content: string, format: 'csv'|'json' } — paste
  //      from Excel/Sheets dumped into a textarea. parseCatalog auto-
  //      detects tab vs comma vs semicolon delimiter.
  //   3. multipart/form-data with file — the original CSV/JSON file
  //      upload, kept for SDK / curl usage and bulk imports.
  const ctype = c.req.header('content-type') || '';
  let directItems: unknown[] | null = null;
  let content = '';
  let format = 'csv';

  if (ctype.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    if (file && typeof file !== 'string') {
      content = await file.text();
      format = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
    }
  } else {
    const body = await c.req.json().catch(() => ({} as { items?: unknown[]; content?: string; format?: string }));
    if (Array.isArray(body.items)) {
      directItems = body.items;
    } else {
      content = String(body.content || '');
      format = String(body.format || 'csv');
    }
  }

  // Path 1: pre-parsed items — light validation only, no parser run.
  if (directItems) {
    if (directItems.length === 0) {
      return c.json({ error: 'bad_request', message: 'array de itens vazio' }, 400);
    }
    if (directItems.length > 1000) {
      return c.json({ error: 'bad_request', message: 'máximo 1000 itens — divida em mais agentes' }, 413);
    }
    // Drop rows without name (the only required field). Coerce + trim.
    const cleaned = directItems
      .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
      .map((it) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(it)) {
          if (v === null || v === undefined || v === '') continue;
          out[k] = typeof v === 'string' ? v.trim() : v;
        }
        return out;
      })
      .filter((it) => it.name && String(it.name).trim());
    if (cleaned.length === 0) {
      return c.json({ error: 'bad_request', message: 'nenhum item com nome preenchido' }, 400);
    }
    await db
      .update(agents)
      .set({ catalog: cleaned as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(agents.id, a.id));
    return c.json({
      ok: true,
      item_count: cleaned.length,
      preview: cleaned.slice(0, 5),
      warnings: directItems.length > cleaned.length
        ? [`${directItems.length - cleaned.length} linha(s) ignorada(s) por falta de nome.`]
        : [],
      field_map: { name: 'name', price: 'price', region: 'region', description: 'description', image_url: 'image_url' },
    });
  }

  // Paths 2 + 3: parse free-form content
  if (!content.trim()) {
    return c.json({ error: 'bad_request', message: 'content vazio — envie CSV, JSON, ou cole de uma planilha' }, 400);
  }
  if (content.length > 1_000_000) {
    return c.json({ error: 'bad_request', message: 'arquivo muito grande (>1MB) — divida em mais agentes' }, 413);
  }

  const { parseCatalog } = await import('~/agents/catalog');
  const result = parseCatalog(content, format);

  if (result.items.length === 0) {
    return c.json({
      error: 'parse_failed',
      message: 'Nenhum item válido no arquivo. Veja warnings.',
      warnings: result.warnings,
      field_map: result.fieldMap,
    }, 400);
  }

  await db
    .update(agents)
    .set({ catalog: result.items as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(agents.id, a.id));

  return c.json({
    ok: true,
    item_count: result.items.length,
    field_map: result.fieldMap,
    warnings: result.warnings,
    preview: result.items.slice(0, 5),
  });
});

// Import catalog from a website URL — owner pastes their site, we
// fetch + extract via JSON-LD then Gemini fallback. By default returns
// only a preview (so the owner can review before committing); pass
// {save:true} to overwrite the agent's catalog atomically.
app.post('/:id/catalog/import-url', async (c) => {
  const user = c.get('user') as { id: string };
  const [a] = await db
    .select()
    .from(agents)
    .where(whereAgentByIdOrSlug(c.req.param('id'), user.id))
    .limit(1);
  if (!a) throw Errors.notFound('Agent');

  const body = (await c.req.json().catch(() => ({}))) as {
    url?: string;
    save?: boolean;
    save_business?: boolean;
  };
  const url = String(body.url || '').trim();
  if (!url) {
    return c.json({ error: 'bad_request', message: 'campo "url" obrigatório' }, 400);
  }

  const { importCatalogFromUrl } = await import('~/agents/site-importer');
  const result = await importCatalogFromUrl(url);

  // Even on item-extraction failure, return business info if we got any
  // — owner still benefits from an auto-filled profile.
  if (!result.ok || result.items.length === 0) {
    return c.json(
      {
        error: 'import_failed',
        message: result.error || 'Não consegui extrair itens dessa URL.',
        warnings: result.warnings,
        page_title: result.page_title,
        source: result.source,
        business: result.business,
        business_info_text: result.business_info_text,
      },
      400,
    );
  }

  if (body.save) {
    // Atomic write — catalog + business_info together when both
    // present. If owner already has business_info, only overwrite
    // when explicitly requested via save_business=true (default true
    // for backwards-compat with the simpler {save:true} flow but the
    // UI is smart enough to ask first).
    const update: { catalog: unknown; updatedAt: Date; businessInfo?: string } = {
      catalog: result.items as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    };
    const wantBiz = body.save_business !== false;
    if (wantBiz && result.business_info_text) {
      update.businessInfo = result.business_info_text.slice(0, 4000);
    }
    await db
      .update(agents)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set(update as any)
      .where(eq(agents.id, a.id));
  }

  return c.json({
    ok: true,
    saved: !!body.save,
    item_count: result.items.length,
    items: result.items,
    source: result.source,
    page_title: result.page_title,
    warnings: result.warnings,
    business: result.business,
    business_info_text: result.business_info_text,
    photo_stats: result.photo_stats,
  });
});

// Read current catalog (preview / debug)
app.get('/:id/catalog', async (c) => {
  const user = c.get('user') as { id: string };
  const [a] = await db
    .select()
    .from(agents)
    .where(whereAgentByIdOrSlug(c.req.param('id'), user.id))
    .limit(1);
  if (!a) throw Errors.notFound('Agent');
  const items = Array.isArray(a.catalog) ? a.catalog : [];
  return c.json({
    item_count: items.length,
    items: items.slice(0, 50),
    truncated: items.length > 50,
  });
});

// Catalog PDF — generates a cover-page + 2-col-grid PDF of the agent's
// full catalog, with photos embedded. Cached by content hash in Supabase
// Storage so a second call with the same catalog is instant. The agent
// runtime calls this internally via the send_catalog_pdf tool, and the
// dashboard calls it for the "Baixar PDF" button.
//
// Design: returning the bytes directly (instead of a presigned URL) keeps
// the auth simple (uses the route's existing user-auth) and lets the
// frontend trigger a download via a blob without a second round-trip.
app.get('/:id/catalog/pdf', async (c) => {
  const user = c.get('user') as { id: string };
  const [a] = await db
    .select()
    .from(agents)
    .where(whereAgentByIdOrSlug(c.req.param('id'), user.id))
    .limit(1);
  if (!a) throw Errors.notFound('Agent');
  const items = Array.isArray(a.catalog) ? a.catalog as Record<string, unknown>[] : [];
  if (items.length === 0) {
    return c.json({ error: 'empty_catalog', message: 'Catálogo vazio. Importe ou cadastre itens antes de gerar o PDF.' }, 400);
  }

  // Hash the catalog payload + business info so we cache by content. Edit
  // the catalog -> hash changes -> next call regenerates. Stable across
  // requests for the same content so the second download is instant.
  const { createHash } = await import('node:crypto');
  const businessName = (a.name || 'Catálogo').slice(0, 100);
  const businessContact = (a.businessInfo || '').split('\n')[0]?.slice(0, 200) || '';
  const hashInput = JSON.stringify({ businessName, businessContact, items });
  const hash = createHash('sha1').update(hashInput).digest('hex').slice(0, 16);
  const storageKey = `catalogs/${a.id}/${hash}.pdf`;

  // Try cache first.
  const { isStorageConfigured, presignGet, putObject } = await import('~/storage/supabase-storage');
  const cacheUsable = isStorageConfigured();
  if (cacheUsable) {
    const presigned = presignGet({ key: storageKey, expiresIn: 600 });
    if (presigned.ok && presigned.url) {
      // HEAD-check by attempting a conditional fetch — if the object doesn't
      // exist, presignGet still returns a URL but the GET 404s. We use a
      // tiny range request to avoid downloading the whole file just to test.
      try {
        const head = await fetch(presigned.url, { method: 'GET', headers: { range: 'bytes=0-15' } });
        if (head.status === 200 || head.status === 206) {
          return c.json({ ok: true, url: presigned.url, cached: true, hash, item_count: items.length });
        }
      } catch { /* fall through to regen */ }
    }
  }

  // Cache miss — generate.
  const { renderCatalogPdf } = await import('~/agents/pdf-renderer');
  const t0 = Date.now();
  const pdfBytes = await renderCatalogPdf({
    businessName,
    businessContact,
    items: items.map((it) => ({
      name: String((it as { name?: unknown }).name || ''),
      price: typeof (it as { price?: unknown }).price === 'number' ? (it as { price: number }).price : null,
      region: typeof (it as { region?: unknown }).region === 'string' ? (it as { region: string }).region : null,
      description: typeof (it as { description?: unknown }).description === 'string' ? (it as { description: string }).description : null,
      image_url: typeof (it as { image_url?: unknown }).image_url === 'string' ? (it as { image_url: string }).image_url : null,
      url: typeof (it as { url?: unknown }).url === 'string' ? (it as { url: string }).url : null,
    })),
  });
  const renderMs = Date.now() - t0;

  // Persist to Supabase Storage (best effort — even on failure we still
  // return the bytes so the operator gets the PDF; just no cache benefit).
  if (cacheUsable) {
    const put = await putObject({ key: storageKey, bytes: pdfBytes, mimeType: 'application/pdf' });
    if (put.ok) {
      const presigned = presignGet({ key: storageKey, expiresIn: 600 });
      if (presigned.ok && presigned.url) {
        return c.json({ ok: true, url: presigned.url, cached: false, hash, item_count: items.length, render_ms: renderMs });
      }
    }
  }

  // No storage / upload failed — stream the bytes directly so the dashboard
  // can still download. The agent runtime takes a different path (uses the
  // bytes via direct render-call), so this is operator-fallback only.
  // Cast follows the same shape used by routes/voices.ts for binary blobs.
  return c.body(pdfBytes as unknown as ArrayBuffer, 200, {
    'content-type': 'application/pdf',
    'content-disposition': `attachment; filename="catalogo-${a.slug || a.id}.pdf"`,
  });
});

// Wipe catalog (owner can reset before re-uploading)
app.delete('/:id/catalog', async (c) => {
  const user = c.get('user') as { id: string };
  const [a] = await db
    .select()
    .from(agents)
    .where(whereAgentByIdOrSlug(c.req.param('id'), user.id))
    .limit(1);
  if (!a) throw Errors.notFound('Agent');
  await db.update(agents).set({ catalog: null, updatedAt: new Date() }).where(eq(agents.id, a.id));
  return c.json({ ok: true });
});

/** Turn a judge issue into a short imperative correction line. */
function issueToPatchText(issue: string): string {
  const trimmed = issue.trim().replace(/\s+/g, ' ');
  // Most issues already start with "não X" or "ignorou X" — flip into "Sempre X" / "Sempre confirmar X".
  if (/^não\s+/i.test(trimmed)) {
    return 'Sempre ' + trimmed.replace(/^não\s+/i, '').replace(/^.{1}/, (c) => c.toLowerCase());
  }
  if (/^ignor(ou|ar)\s+/i.test(trimmed)) {
    return 'Sempre considerar ' + trimmed.replace(/^ignor(ou|ar)\s+/i, '').replace(/^.{1}/, (c) => c.toLowerCase());
  }
  // Default: "Atenção: " + literal
  return 'Atenção: ' + trimmed;
}

// Knowledge Cache stats — owner-only
// Returns: { entries, total_hits, cost_saved_usdc, hit_rate_pct }
// Used by dashboard to show "your agent saved you $X via semantic cache".
app.get('/:id/cache-stats', async (c) => {
  const user = c.get('user') as { id: string };
  const idOrSlug = c.req.param('id');
  const [a] = await db
    .select()
    .from(agents)
    .where(whereAgentByIdOrSlug(idOrSlug, user.id));
  if (!a) throw Errors.notFound('Agent');
  const stats = await getCacheStats(a.id);
  return c.json(stats);
});

// Conversation messages — owner-only
app.get('/:id/messages', async (c) => {
  const user = c.get('user') as { id: string };
  const idOrSlug = c.req.param('id');
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10), 1), 200);
  const sessionId = c.req.query('session_id');

  // Ownership check (slug or uuid)
  const [a] = await db
    .select()
    .from(agents)
    .where(whereAgentByIdOrSlug(idOrSlug, user.id));
  if (!a) throw Errors.notFound('Agent');
  const id = a.id;

  // Optional filter by session (e.g. session_id=wa:5511995432538 for one WhatsApp contact)
  const where = sessionId
    ? and(eq(agentMessages.agentId, id), eq(agentMessages.sessionId, sessionId))
    : eq(agentMessages.agentId, id);

  const rows = await db
    .select()
    .from(agentMessages)
    .where(where)
    .orderBy(desc(agentMessages.createdAt))
    .limit(limit);

  return c.json({
    data: rows.map((m) => ({
      id: m.id,
      session_id: m.sessionId,
      role: m.role,
      content: m.content,
      variant: m.variant,
      created_at: m.createdAt,
      // Reasoning trace + judge eval (assistant rows only). Null for old
      // rows or any user row — the brain UI hides the panel when null.
      meta: m.meta ?? null,
    })),
    count: rows.length,
  });
});

// Delete
app.delete('/:id', async (c) => {
  const user = c.get('user') as { id: string };
  const idOrSlug = c.req.param('id');

  // Ownership check + connection lookup BEFORE deleting the agent. Once the
  // agent row is gone, the FK CASCADE drops whatsapp_connections — so we
  // need the URL/instance/key in hand to clean up the Evolution-side
  // resources. Doing this in-process (not as a background job) so that
  // operator gets immediate feedback on the disconnect, even if Evolution
  // is slow.
  const [a] = await db
    .select()
    .from(agents)
    .where(whereAgentByIdOrSlug(idOrSlug, user.id))
    .limit(1);
  if (!a) throw Errors.notFound('Agent');
  const id = a.id;

  const [conn] = await db
    .select()
    .from(whatsappConnections)
    .where(eq(whatsappConnections.agentId, id))
    .limit(1);

  if (conn) {
    try {
      const apiKey = decrypt(conn.apiKey);
      // Best-effort. Failing here would leak the Evolution instance, but
      // failing-closed (refusing the agent delete) would leave the user
      // unable to clean up their own data — worse trade-off.
      await deleteInstance({
        instanceUrl: conn.instanceUrl,
        instanceName: conn.instanceName,
        apiKey,
      });
    } catch {
      // decrypt failure or network error — proceed with agent delete anyway.
    }
  }

  const result = await db
    .delete(agents)
    .where(and(eq(agents.id, id), eq(agents.ownerId, user.id)))
    .returning({ id: agents.id });
  if (result.length === 0) throw Errors.notFound('Agent');
  return c.json({ ok: true });
});

export default app;
