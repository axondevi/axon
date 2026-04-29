/**
 * Public agent preview + sandbox.
 *
 * Two endpoints:
 *
 *   GET  /v1/agents/:slug/preview         — public metadata for preview UI
 *   POST /v1/agents/:slug/preview/chat    — sandbox chat turn (rate-limited)
 *
 * Sandbox vs production: sandbox uses a separate session bucket
 * (`session_id=preview:<sessionToken>`) so messages don't appear in the
 * Cérebro / WhatsApp dashboard, don't pollute contact_memory, and are
 * easy to filter out of analytics. Cost still comes from owner's wallet
 * (the agent runs through the same /v1/run gate) — keeps things honest
 * and avoids special-casing payment.
 *
 * Rate limit: 10 turns per IP per agent per hour. Enough to evaluate
 * the agent's behavior, low enough to deny abuse.
 */
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '~/db';
import { agents, users, wallets } from '~/db/schema';
import { Errors } from '~/lib/errors';
import { runAgent, type ChatMessage } from '~/agents/runtime';
import { redis } from '~/cache/redis';

export const previewRoutes = new Hono();

const RATE_LIMIT_PER_HOUR = 10;
const SESSION_TURN_CAP = 20;

function getClientIp(c: any): string {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  );
}

/**
 * Public preview metadata. Shows:
 *  - Hero (avatar, name, description, primary color)
 *  - Capability list (tools enabled, language, NFT verified, etc.)
 *  - Welcome message + quick prompts (the seeds for the sandbox)
 *  - Sample conversations (canned demos showing the agent's voice)
 */
previewRoutes.get('/:slug/preview', async (c) => {
  const slug = c.req.param('slug');
  const [a] = await db.select().from(agents).where(eq(agents.slug, slug)).limit(1);
  if (!a || !a.public) throw Errors.notFound('Agent');

  const tools = Array.isArray(a.allowedTools) ? (a.allowedTools as string[]) : [];

  // Group tools by capability category for the badge cloud.
  const toolGroups = {
    consultas_br: tools.filter((t) =>
      ['lookup_cep', 'lookup_cnpj', 'brasilapi_holidays', 'brasilapi_ddd', 'brasilapi_rates'].includes(t),
    ),
    pesquisa: tools.filter((t) =>
      ['search_web', 'scrape_url', 'wikipedia_summary', 'wikipedia_search', 'search_hn', 'exa_search', 'search_arxiv'].includes(t),
    ),
    financeiro: tools.filter((t) =>
      ['convert_currency', 'crypto_price', 'generate_pix'].includes(t),
    ),
    multimodal: tools.filter((t) => ['generate_image', 'embed_text'].includes(t)),
    locale: tools.filter((t) => ['current_weather', 'weather_forecast', 'lookup_country', 'get_datetime'].includes(t)),
  };

  // NFT URL (mainnet/sepolia auto-detect, mirroring agents.ts logic).
  let nftUrl: string | null = null;
  if (process.env.NFT_CONTRACT_ADDRESS) {
    const isSepolia = /sepolia/i.test(process.env.NFT_RPC_URL || '');
    const explorer = isSepolia ? 'https://sepolia.basescan.org' : 'https://basescan.org';
    const tokenIdHex = a.id.replace(/-/g, '');
    const tokenIdDec = BigInt('0x' + tokenIdHex).toString();
    nftUrl = `${explorer}/nft/${process.env.NFT_CONTRACT_ADDRESS}/${tokenIdDec}`;
  }

  return c.json({
    id: a.id,
    slug: a.slug,
    name: a.name,
    description: a.description,
    template: a.template,
    primary_color: a.primaryColor,
    welcome_message: a.welcomeMessage,
    quick_prompts: a.quickPrompts,
    ui_language: a.uiLanguage,
    capabilities: {
      memory_per_contact: true,        // contact_memory always on
      semantic_cache: true,             // agent_cache always on
      time_aware_greeting: true,        // baked into runtime
      vision: !!process.env.GEMINI_API_KEY,
      voice_in: !!process.env.DEEPGRAM_API_KEY,
      voice_out: !!process.env.ELEVENLABS_API_KEY,
      pix_in_chat: tools.includes('generate_pix') && !!process.env.MP_ACCESS_TOKEN,
      image_generation: tools.includes('generate_image'),
    },
    tool_count: tools.length,
    tools_by_group: toolGroups,
    nft_url: nftUrl,
    pay_mode: a.payMode,
  });
});

/**
 * Sandbox chat turn. Stateless — frontend sends the full message history
 * each turn (capped at SESSION_TURN_CAP). Rate limited per (ip, agent).
 *
 * This intentionally does NOT use the agent's owner wallet/auth — the
 * preview is public and free. We run a stripped-down version: same
 * system prompt + tools, but bypass debit/cache/persistence.
 */
previewRoutes.post('/:slug/preview/chat', async (c) => {
  const slug = c.req.param('slug');
  const ip = getClientIp(c);
  const bucket = Math.floor(Date.now() / 1000 / 3600);
  const key = `preview:rl:${ip}:${slug}:${bucket}`;

  // Atomic incr + expire
  const pipe = redis.multi();
  pipe.incr(key);
  pipe.expire(key, 3600 + 60);
  const r = await pipe.exec();
  const count = Number(r?.[0]?.[1] ?? 0);
  if (count > RATE_LIMIT_PER_HOUR) {
    return c.json({
      error: 'rate_limited',
      message: `Você atingiu o limite de ${RATE_LIMIT_PER_HOUR} mensagens/hora pra testar este agente. Volte em uma hora ou crie sua conta pra liberado.`,
    }, 429);
  }

  const [a] = await db.select().from(agents).where(eq(agents.slug, slug)).limit(1);
  if (!a || !a.public) throw Errors.notFound('Agent');

  const body = await c.req.json().catch(() => ({} as any));
  const incoming: ChatMessage[] = Array.isArray(body.messages) ? body.messages : [];
  if (incoming.length === 0) {
    return c.json({ error: 'bad_request', message: 'messages array required' }, 400);
  }
  if (incoming.length > SESSION_TURN_CAP) {
    return c.json({
      error: 'session_too_long',
      message: `Sessão de teste limitada a ${SESSION_TURN_CAP} turnos. Inicie uma nova conversa.`,
    }, 400);
  }
  // Accept only user/assistant roles + reasonable content lengths.
  const messages: ChatMessage[] = incoming
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 2000) }));

  // Resolve owner wallet — preview runs use the OWNER's funds (same as
  // public agent runs). Owner can disable preview by setting agent to private.
  const [owner] = await db.select().from(users).where(eq(users.id, a.ownerId)).limit(1);
  if (!owner) throw Errors.notFound('Owner');
  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, a.ownerId)).limit(1);
  if (!wallet) throw Errors.notFound('Wallet');

  // Set context for downstream tool execution (same shape as the authed flow)
  c.set('user', owner);
  c.set('axon:agent_id', a.id);

  const previewSystemPrompt =
    a.systemPrompt +
    `\n\n## Modo TESTE (sandbox)
Você está sendo testado por um visitante curioso (NÃO é um cliente real).
Demonstre suas capacidades de forma clara mas NÃO invente dados específicos
(CNPJ, pedido, conta) — quando a tool retornar dado real, use-o; quando o
visitante perguntar algo que dependeria do contexto do dono, fale "no modo
real, eu teria essa info do dono — aqui no teste estou demonstrando minha
capacidade".`;

  try {
    const result = await runAgent({
      c,
      systemPrompt: previewSystemPrompt,
      allowedTools: Array.isArray(a.allowedTools) ? (a.allowedTools as string[]) : [],
      messages,
      ownerId: a.ownerId,
      enableCache: false,
    });
    return c.json({
      content: result.content,
      tool_calls: result.tool_calls_executed.map((t) => ({
        name: t.name,
        ok: t.ok,
        cost_usdc: t.cost_usdc,
      })),
      images: result.images?.map((i) => ({ base64: i.base64, mimetype: i.mimetype })) || [],
      // Pix preview: don't actually create the charge (sandbox shouldn't
      // bill anyone), just show what the QR would have looked like.
      pix_preview: result.pixPayments?.map((p) => ({
        amount_brl: p.amountBrl,
        description: p.description,
        qr_code_base64: p.qrCodeBase64,
        qr_code: p.qrCode,
        note: 'Preview — Pix real seria criado em produção.',
      })) || [],
      remaining_quota: Math.max(0, RATE_LIMIT_PER_HOUR - count),
    });
  } catch (err: any) {
    return c.json({
      error: 'agent_error',
      message: err.message || 'Falha ao processar.',
    }, 500);
  }
});
