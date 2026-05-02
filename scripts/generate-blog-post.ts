/**
 * Daily blog post generator — Nexus Inovation.
 *
 * Picks the next pending topic from blog-topics.json, generates one PT-BR
 * post AND one EN post (sharing the same topicId), writes them as .md
 * files into academy/src/content/blog/, then marks the topic as published.
 *
 * Anti-repetition by design:
 *   1. Topic queue has unique numeric ids; once published_at is set, the
 *      topic is skipped forever.
 *   2. The LLM prompt receives the titles of the LAST 30 published posts
 *      with explicit "do NOT write a post that overlaps with these angles".
 *
 * Quality strategy:
 *   - Single Gemini 2.5 Flash Lite call per language with a structured
 *     prompt: target length, tone, format (markdown sections), CTA shape.
 *   - PT and EN are generated INDEPENDENTLY from the same angle (not
 *     translated) — keeps cultural references appropriate to each
 *     audience (e.g. PIX in PT-BR, Stripe Link in EN).
 *
 * Run manually:
 *   GEMINI_API_KEY=... bun run scripts/generate-blog-post.ts
 *
 * Run via cron (GitHub Action workflow_dispatch / schedule daily 9am BR /
 * 12 UTC) — see .github/workflows/blog-daily.yml.
 *
 * Exit codes:
 *   0 = post(s) generated and written
 *   1 = no pending topics left (refill blog-topics.json)
 *   2 = LLM failure / write failure
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const TOPICS_PATH = join(REPO, 'scripts', 'blog-topics.json');
const BLOG_DIR = join(REPO, 'academy', 'src', 'content', 'blog');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = process.env.BLOG_GEN_MODEL || 'gemini-2.5-flash-lite';
const MAX_RECENT_TITLES_IN_PROMPT = 30;

// ─── Types ─────────────────────────────────────────────────
interface Topic {
  id: number;
  slug_pt: string;
  slug_en: string;
  title_pt: string;
  title_en: string;
  category: string;
  tags: string[];
  angle_pt: string;
  angle_en: string;
  published_at: string | null;
}
interface TopicsFile {
  $comment?: string;
  topics: Topic[];
}

// ─── Topic queue ───────────────────────────────────────────
function loadTopics(): TopicsFile {
  return JSON.parse(readFileSync(TOPICS_PATH, 'utf-8'));
}

function saveTopics(file: TopicsFile): void {
  writeFileSync(TOPICS_PATH, JSON.stringify(file, null, 2) + '\n', 'utf-8');
}

function pickNextPending(topics: Topic[]): Topic | null {
  return topics.find((t) => !t.published_at) ?? null;
}

// ─── Recent titles (anti-repetition signal) ────────────────
function listExistingTitles(lang: 'pt-BR' | 'en'): string[] {
  // Posts live under blog/pt/ and blog/en/ — clean URL slugs without
  // ".pt" / ".en" dot suffixes, since Astro strips dots from path params.
  const subdir = join(BLOG_DIR, lang === 'pt-BR' ? 'pt' : 'en');
  if (!existsSync(subdir)) return [];
  const titles: string[] = [];
  for (const file of readdirSync(subdir)) {
    if (!file.endsWith('.md') && !file.endsWith('.mdx')) continue;
    const text = readFileSync(join(subdir, file), 'utf-8');
    const m = text.match(/^title:\s*['"]?([^'\n"]+)['"]?\s*$/m);
    if (m) titles.push(m[1]);
  }
  return titles.slice(-MAX_RECENT_TITLES_IN_PROMPT);
}

// ─── Gemini call ───────────────────────────────────────────
async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 4000 },
  };
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryable = res.status >= 500 || res.status === 429;
      if (retryable && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw new Error(`Gemini ${res.status}: ${text.slice(0, 240)}`);
    }
    const data: any = await res.json();
    const out = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!out) {
      throw new Error(
        `Gemini empty response (finish=${data?.candidates?.[0]?.finishReason ?? 'n/a'})`,
      );
    }
    return out;
  }
  throw new Error('unreachable');
}

// ─── Prompt builder ────────────────────────────────────────
function buildPrompt(opts: {
  lang: 'pt-BR' | 'en';
  topic: Topic;
  recentTitles: string[];
}): string {
  const isPt = opts.lang === 'pt-BR';
  const langName = isPt ? 'Portuguese (PT-BR)' : 'English';
  const title = isPt ? opts.topic.title_pt : opts.topic.title_en;
  const angle = isPt ? opts.topic.angle_pt : opts.topic.angle_en;

  const audienceNote = isPt
    ? 'Audiência: donos de pequenos e médios negócios brasileiros (clínica, comércio, salão, advocacia, imobiliária). Tom profissional mas direto, sem jargão de tech bro. Use exemplos brasileiros (PIX, BR, LGPD, casos reais BR).'
    : 'Audience: owners of US/global small-to-medium businesses (clinics, retail, professional services). Professional but direct tone, no tech-bro jargon. Use examples relevant to the global market (Stripe, GDPR, etc).';

  const recentBlock = opts.recentTitles.length > 0
    ? `\n\nIMPORTANT — Do NOT write a post whose angle overlaps with any of these recently published titles. Pick a fresh perspective:\n${opts.recentTitles.map((t) => `- ${t}`).join('\n')}`
    : '';

  return [
    `You are a senior content writer for Nexus Inovation, a SaaS that builds AI agents for WhatsApp / Instagram / web — focused on Brazilian and global SMBs. Write in ${langName}.`,
    '',
    `Title (you MUST use this exact title): "${title}"`,
    `Category: ${opts.topic.category}`,
    `Tags: ${opts.topic.tags.join(', ')}`,
    '',
    `Angle / hook to develop:`,
    angle,
    '',
    audienceNote,
    '',
    'Output requirements:',
    '- Length: ~900-1300 words.',
    '- Format: pure Markdown. NO frontmatter (the script adds it).',
    '- Structure: hook intro (~100 words) → 4-6 H2 sections (## Title) → conclusion → CTA.',
    '- Use real numbers / stats when relevant — but be honest, do NOT invent specific company names or fabricate quotes.',
    '- Include code snippets ONLY if the topic genuinely calls for it. If included, use ```language``` fences.',
    '- Avoid filler ("In today\'s fast-paced world...", "It is important to note that..."). Get to the point.',
    '- Final CTA is a short paragraph linking to the Nexus Inovation product:',
    isPt
      ? '  Texto algo como: "Quer testar um agente assim no seu negócio? [Crie o seu em /build](https://nexusinovation.com.br/build) — sem cartão, primeiro contato em 5 minutos."'
      : '  Use something like: "Want to deploy an agent like this for your business? [Build yours at /build](https://nexusinovation.com.br/build) — no credit card, first contact in 5 minutes."',
    '- End with a one-line italicized disclosure:',
    isPt
      ? '  *Post gerado com IA, revisado pela equipe Nexus Inovation.*'
      : '  *AI-assisted post, reviewed by the Nexus Inovation team.*',
    recentBlock,
    '',
    'Begin the post now (Markdown body only, no preamble):',
  ].join('\n');
}

// ─── Frontmatter writer ────────────────────────────────────
function writePost(opts: {
  lang: 'pt-BR' | 'en';
  topic: Topic;
  body: string;
  publishedAt: Date;
}): string {
  const slug = opts.lang === 'pt-BR' ? opts.topic.slug_pt : opts.topic.slug_en;
  const counterpartSlug = opts.lang === 'pt-BR' ? opts.topic.slug_en : opts.topic.slug_pt;
  const title = opts.lang === 'pt-BR' ? opts.topic.title_pt : opts.topic.title_en;
  // Description: first non-heading paragraph, cut at sentence boundary so
  // SEO snippet doesn't dangle mid-word. Skip H1 (which usually equals the
  // title) so the description doesn't repeat the title.
  const paragraphs = opts.body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#'));
  const firstPara = paragraphs[0] || opts.body.trim();
  let desc = firstPara.replace(/\s+/g, ' ').trim();
  if (desc.length > 220) {
    // Truncate to last sentence end before 220 chars; fallback to last
    // word boundary if no sentence end found.
    const slice = desc.slice(0, 220);
    const lastSentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
    if (lastSentence > 100) desc = slice.slice(0, lastSentence + 1);
    else {
      const lastSpace = slice.lastIndexOf(' ');
      desc = (lastSpace > 100 ? slice.slice(0, lastSpace) : slice) + '…';
    }
  }
  // Estimate read time: ~220 words/min
  const wordCount = opts.body.split(/\s+/).filter(Boolean).length;
  const readMinutes = Math.max(2, Math.round(wordCount / 220));
  const subdir = join(BLOG_DIR, opts.lang === 'pt-BR' ? 'pt' : 'en');
  const fullPath = join(subdir, `${slug}.md`);

  if (!existsSync(subdir)) mkdirSync(subdir, { recursive: true });

  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(desc)}`,
    `lang: ${JSON.stringify(opts.lang)}`,
    `category: ${JSON.stringify(opts.topic.category)}`,
    `publishedAt: ${opts.publishedAt.toISOString()}`,
    `topicId: ${opts.topic.id}`,
    `counterpartSlug: ${JSON.stringify(counterpartSlug)}`,
    `tags: ${JSON.stringify(opts.topic.tags)}`,
    `authorshipMode: "ai-generated"`,
    `readMinutes: ${readMinutes}`,
    '---',
    '',
    opts.body.trim(),
    '',
  ].join('\n');

  writeFileSync(fullPath, frontmatter, 'utf-8');
  return fullPath;
}

// ─── Main ──────────────────────────────────────────────────
async function main(): Promise<number> {
  const file = loadTopics();
  const topic = pickNextPending(file.topics);
  if (!topic) {
    console.error('No pending topics in blog-topics.json — refill the queue.');
    return 1;
  }

  console.log(`→ Generating topic #${topic.id}: ${topic.title_pt}`);
  console.log(`  category=${topic.category}  tags=${topic.tags.join(',')}`);

  const recentPt = listExistingTitles('pt-BR');
  const recentEn = listExistingTitles('en');
  console.log(`  anti-repeat sample sizes: PT=${recentPt.length} EN=${recentEn.length}`);

  let ptBody: string;
  let enBody: string;
  try {
    console.log('  ✦ generating PT-BR…');
    ptBody = await callGemini(buildPrompt({ lang: 'pt-BR', topic, recentTitles: recentPt }));
    console.log(`    ${ptBody.split(/\s+/).length} words`);

    console.log('  ✦ generating EN…');
    enBody = await callGemini(buildPrompt({ lang: 'en', topic, recentTitles: recentEn }));
    console.log(`    ${enBody.split(/\s+/).length} words`);
  } catch (err: any) {
    console.error('LLM failure:', err.message || err);
    return 2;
  }

  const publishedAt = new Date();
  try {
    const ptFile = writePost({ lang: 'pt-BR', topic, body: ptBody, publishedAt });
    const enFile = writePost({ lang: 'en', topic, body: enBody, publishedAt });
    console.log(`  ✓ wrote ${ptFile}`);
    console.log(`  ✓ wrote ${enFile}`);
  } catch (err: any) {
    console.error('Write failure:', err.message || err);
    return 2;
  }

  // Mark topic as published — locks it from future runs.
  topic.published_at = publishedAt.toISOString();
  saveTopics(file);
  console.log(`  ✓ topic #${topic.id} marked published.`);
  return 0;
}

main().then((code) => process.exit(code));
