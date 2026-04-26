/**
 * Agent factory CRUD + public config endpoint.
 *
 * - Authed routes (mounted under /v1/agents): owner-only CRUD.
 * - Public routes (mounted before auth):
 *     GET /v1/agents/templates     → list of starter templates
 *     GET /v1/agents/by-slug/:slug → public-flagged agent config (drives /agent/:slug)
 */
import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '~/db';
import { agents } from '~/db/schema';
import { Errors } from '~/lib/errors';
import { AGENT_TEMPLATES, getTemplate } from '~/agents/templates';
import { fromMicro, toMicro } from '~/wallet/service';

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

publicRoutes.get('/by-slug/:slug', async (c) => {
  const slug = c.req.param('slug');
  const [a] = await db.select().from(agents).where(eq(agents.slug, slug)).limit(1);
  if (!a || !a.public) throw Errors.notFound('Agent');
  return c.json({
    slug: a.slug,
    name: a.name,
    description: a.description,
    system_prompt: a.systemPrompt,
    allowed_tools: a.allowedTools,
    primary_color: a.primaryColor,
    welcome_message: a.welcomeMessage,
    quick_prompts: a.quickPrompts,
    budget_per_session_usdc: fromMicro(a.budgetPerSession),
    hard_cap_usdc: fromMicro(a.hardCap),
    pay_mode: a.payMode,
    daily_budget_usdc: fromMicro(a.dailyBudgetMicro),
    owner_id: a.ownerId,
  });
});

// ============ Authed routes (mounted under /v1) ============
const app = new Hono();

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
    allowed_tools: a.allowedTools,
    primary_color: a.primaryColor,
    welcome_message: a.welcomeMessage,
    quick_prompts: a.quickPrompts,
    budget_per_session_usdc: fromMicro(a.budgetPerSession),
    hard_cap_usdc: fromMicro(a.hardCap),
    pay_mode: a.payMode,
    daily_budget_usdc: fromMicro(a.dailyBudgetMicro),
    public: a.public,
    template: a.template,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  });
});

// Create
app.post('/', async (c) => {
  const user = c.get('user') as { id: string };
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
    public: body.public !== false,
    template: seed.template ?? body.template ?? null,
  };

  try {
    const [created] = await db.insert(agents).values(insert).returning();
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

  await db.update(agents).set(update).where(eq(agents.id, id));
  return c.json({ ok: true });
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
