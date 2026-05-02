import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// ============== TUTORIALS ==============
const tutorials = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/tutorials' }),
  schema: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    description: z.string().max(180),
    category: z.enum(['agents', 'apis', 'production', 'brazil', 'concepts', 'integration']),
    difficulty: z.enum(['iniciante', 'intermediario', 'avancado']),
    lang: z.enum(['pt-BR', 'en']).default('pt-BR'),
    timeMinutes: z.number(),
    author: z.string().default('Nexus Inovation Team'),
    authorUrl: z.string().url().optional(),
    publishedAt: z.date(),
    updatedAt: z.date().optional(),
    tags: z.array(z.string()).default([]),
    relatedTutorials: z.array(z.string()).optional(),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

// ============== GUIDES (conceptual, no-code content) ==============
const guides = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/guides' }),
  schema: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    description: z.string().max(180),
    lang: z.enum(['pt-BR', 'en']).default('pt-BR'),
    timeMinutes: z.number(),
    author: z.string().default('Nexus Inovation Team'),
    publishedAt: z.date(),
    updatedAt: z.date().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

// ============== RECIPES (cookbook snippets) ==============
const recipes = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/recipes' }),
  schema: z.object({
    title: z.string(),
    description: z.string().max(180),
    lang: z.enum(['pt-BR', 'en']).default('pt-BR'),
    stack: z.array(z.string()).default([]),
    publishedAt: z.date(),
    tags: z.array(z.string()).default([]),
  }),
});

// ============== GLOSSARY ==============
const glossary = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/glossary' }),
  schema: z.object({
    term: z.string(),
    shortDefinition: z.string().max(240),
    lang: z.enum(['pt-BR', 'en']).default('pt-BR'),
    relatedTerms: z.array(z.string()).optional(),
  }),
});

// ============== PATHS (curated learning sequences) ==============
const paths = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/paths' }),
  schema: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    description: z.string().max(240),
    lang: z.enum(['pt-BR', 'en']).default('pt-BR'),
    difficulty: z.enum(['iniciante', 'intermediario', 'avancado']),
    tutorials: z.array(z.string()),
    estimatedHours: z.number(),
    icon: z.string().default('book'),
  }),
});

// ============== BLOG (daily auto-generated AI posts, PT + EN) ==============
// Every topic in scripts/blog-topics.json produces TWO files: <slug>.pt.md
// and <slug>.en.md, sharing the same topic_id so cross-language linking
// just swaps the suffix. The cron generator commits new files daily;
// existing ones are never overwritten.
const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    description: z.string().max(240),
    lang: z.enum(['pt-BR', 'en']).default('pt-BR'),
    category: z.enum([
      'casos_de_uso',
      'tutoriais',
      'ia_para_negocio',
      'comparativos',
      'noticias',
    ]),
    publishedAt: z.date(),
    updatedAt: z.date().optional(),
    /** Stable topic id from blog-topics.json — pairs PT and EN versions. */
    topicId: z.number(),
    /** Counterpart slug in the other language; allows lang-toggle on the post page. */
    counterpartSlug: z.string().optional(),
    tags: z.array(z.string()).default([]),
    /** "ai-generated" / "human" / "hybrid" — surfaces in the disclaimer. */
    authorshipMode: z.enum(['ai-generated', 'human', 'hybrid']).default('ai-generated'),
    /** Time-to-read estimate in minutes. */
    readMinutes: z.number().default(5),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

export const collections = {
  tutorials,
  guides,
  recipes,
  glossary,
  paths,
  blog,
};
