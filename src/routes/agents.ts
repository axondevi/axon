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
import { agents, requests, agentMessages, users, wallets } from '~/db/schema';
import { Errors } from '~/lib/errors';
import { AGENT_TEMPLATES, getTemplate } from '~/agents/templates';
import { getCacheStats } from '~/agents/knowledge-cache';
import { mintAgentNft, buildMetadataUrl, isNftEnabled } from '~/nft/agent-nft';
import { fromMicro, toMicro } from '~/wallet/service';
import { effectiveTier, type Tier } from '~/subscription';

// Order: free < pro < team < enterprise
const TIER_RANK: Record<string, number> = { free: 0, pro: 1, team: 2, enterprise: 3 };
function userMeetsTier(user: { tier: string; tierExpiresAt: Date | null }, required: string): boolean {
  const eff = effectiveTier({ tier: user.tier, tierExpiresAt: user.tierExpiresAt });
  return TIER_RANK[eff] >= (TIER_RANK[required] ?? 0);
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

function reservedSlug(s: string) {
  return ['new', 'templates', 'by-slug', 'admin', 'api'].includes(s);
}

// ============ Public routes (no auth) ============
export const publicRoutes = new Hono();

publicRoutes.get('/templates', (c) => {
  return c.json({
    templates: AGENT_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      emoji: t.emoji,
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

  return c.json({
    data: data.map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      primary_color: r.primary_color,
      template: r.template,
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
      created_at: a.createdAt,
      updated_at: a.updatedAt,
    })),
    count: rows.length,
  });
});

// Get one (by id, owned)
app.get('/:id', async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.ownerId, user.id)));
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
      systemPrompt: t.systemPrompt,
      allowedTools: t.tools,
      primaryColor: t.primaryColor,
      welcomeMessage: t.welcomeMessage,
      quickPrompts: t.quickPrompts,
      template: t.id,
    };
  }

  const insert = {
    ownerId: user.id,
    slug,
    name: String(body.name || seed.name || 'Untitled agent').slice(0, 80),
    description: body.description ?? seed.description ?? null,
    systemPrompt: String(body.system_prompt ?? seed.systemPrompt ?? 'You are a helpful AI assistant.'),
    allowedTools: Array.isArray(body.allowed_tools) ? body.allowed_tools : (seed.allowedTools ?? []),
    primaryColor: body.primary_color ?? seed.primaryColor ?? '#7c5cff',
    welcomeMessage: body.welcome_message ?? seed.welcomeMessage ?? null,
    quickPrompts: body.quick_prompts ?? seed.quickPrompts ?? null,
    budgetPerSession: body.budget_per_session_usdc != null ? toMicro(String(body.budget_per_session_usdc)) : 500_000n,
    hardCap: body.hard_cap_usdc != null ? toMicro(String(body.hard_cap_usdc)) : 2_000_000n,
    payMode: body.pay_mode === 'owner' ? 'owner' : 'visitor',
    dailyBudgetMicro: body.daily_budget_usdc != null ? toMicro(String(body.daily_budget_usdc)) : 5_000_000n,
    tierRequired: ['free','pro','team','enterprise'].includes(body.tier_required) ? body.tier_required : 'free',
    systemPromptB: body.system_prompt_b ?? null,
    abSplit: Math.max(0, Math.min(100, parseInt(body.ab_split, 10) || 0)),
    vanityDomain: body.vanity_domain ? String(body.vanity_domain).toLowerCase().trim() : null,
    uiLanguage: ['auto','pt','en','es'].includes(body.ui_language) ? body.ui_language : 'auto',
    public: body.public !== false,
    template: seed.template ?? body.template ?? null,
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
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  const [existing] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.ownerId, user.id)));
  if (!existing) throw Errors.notFound('Agent');

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

  await db.update(agents).set(update).where(eq(agents.id, id));
  return c.json({ ok: true });
});

// Analytics — owner-only
app.get('/:id/analytics', async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  const days = Math.min(Math.max(parseInt(c.req.query('days') || '30', 10), 1), 90);

  // Verify ownership
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.ownerId, user.id)));
  if (!a) throw Errors.notFound('Agent');

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

// Knowledge Cache stats — owner-only
// Returns: { entries, total_hits, cost_saved_usdc, hit_rate_pct }
// Used by dashboard to show "your agent saved you $X via semantic cache".
app.get('/:id/cache-stats', async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.ownerId, user.id)));
  if (!a) throw Errors.notFound('Agent');
  const stats = await getCacheStats(id);
  return c.json(stats);
});

// Conversation messages — owner-only
app.get('/:id/messages', async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10), 1), 200);
  const sessionId = c.req.query('session_id');

  // Ownership check
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.ownerId, user.id)));
  if (!a) throw Errors.notFound('Agent');

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
    })),
    count: rows.length,
  });
});

// Delete
app.delete('/:id', async (c) => {
  const user = c.get('user') as { id: string };
  const id = c.req.param('id');
  const result = await db
    .delete(agents)
    .where(and(eq(agents.id, id), eq(agents.ownerId, user.id)))
    .returning({ id: agents.id });
  if (result.length === 0) throw Errors.notFound('Agent');
  return c.json({ ok: true });
});

export default app;
