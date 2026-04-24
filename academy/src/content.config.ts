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
    author: z.string().default('Axon Team'),
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
    author: z.string().default('Axon Team'),
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

export const collections = {
  tutorials,
  guides,
  recipes,
  glossary,
  paths,
};
