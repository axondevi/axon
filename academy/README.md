# Axon Academy

Tutoriais, guias e recipes pra devs que constroem agentes de IA.

**Site:** https://axon-5zf.pages.dev/learn (após primeiro deploy)
**Repo:** este folder
**Stack:** [Astro 5](https://astro.build) + MDX + Content Collections

## Dev

```bash
npm install
npm run dev        # http://localhost:4321/learn
```

## Build

```bash
npm run build      # gera dist/
npm run preview    # serve dist/ em http://localhost:4321
```

## Estrutura de conteúdo

```
src/content/
  tutorials/       # passo-a-passo com código rodável (.md / .mdx)
  guides/          # artigos conceituais (.md)
  recipes/         # cookbook — snippets curtos (.md)
  glossary/        # definições de termos (.md)
  paths/           # trilhas curadas (.md)
```

## Adicionando um tutorial novo

1. Cria `src/content/tutorials/meu-tutorial.md` (ou `.mdx` se precisar de componentes)
2. Frontmatter obrigatório:

```yaml
---
title: Título claro e específico
description: Descrição de até 180 chars (aparece no Google)
category: agents    # agents | apis | production | brazil | concepts | integration
difficulty: intermediario  # iniciante | intermediario | avancado
lang: pt-BR         # pt-BR | en
timeMinutes: 25
author: Seu Nome
publishedAt: 2026-04-24
tags: [tag1, tag2]
---
```

3. Usa componentes custom (em `.mdx`):

```mdx
import Callout from '../../components/Callout.astro';

<Callout type="porque">
  Explicação importante.
</Callout>
```

Tipos de callout: `porque`, `dica`, `acao`, `armadilha`, `tradeoff`, `info`, `warning`.

4. Build: `npm run build`. Se frontmatter estiver quebrado, falha com mensagem clara.

## Deploy Cloudflare Pages

### Primeira vez (Dashboard Cloudflare)

1. Login em [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages
2. Create application → Pages → Connect to Git → escolhe repo `axondevi/axon`
3. Build settings:
   - **Build command:** `cd academy && npm install && npm run build`
   - **Build output:** `academy/dist`
   - **Root directory:** (deixa vazio)
4. Deploy

### Deploys seguintes
Cada `git push` em main auto-deploya.

### Deploy manual via wrangler

```bash
npm install -g wrangler
wrangler login
npm run build
wrangler pages deploy dist --project-name=axon-academy
```

## Integrando com o Axon principal

Essa Academy é deployada em projeto Cloudflare Pages separado (`axon-academy`). O landing principal (`axon-5zf.pages.dev`) precisa de um rewrite pra `/learn/*` apontar pra ela.

No `_redirects` do **landing** principal (não nesse repo):

```
/learn/*  https://axon-academy.pages.dev/learn/:splat  200
```

Alternativa: configurar Cloudflare Custom Domain apontando subpath.

## Componentes disponíveis

| Componente | Uso | Props |
|---|---|---|
| `Callout` | Destaques | `type` (porque/dica/acao/armadilha/tradeoff/info/warning), `title` |
| `TryOnAxon` | CTA final | `title`, `description`, `ctaText`, `ctaUrl` |
| `ArticleHeader` | Header de tutorial | frontmatter |
| `TableOfContents` | Sumário lateral | `headings` |
| `NextTutorial` | Cards "próximos passos" | `items[]` |
| `TutorialCard` | Cards de listagem | frontmatter |

## SEO por default

- Sitemap automático em `/learn/sitemap-index.xml`
- Open Graph + Twitter Card em toda página
- Canonical URL correto
- Schema de frontmatter valida keywords essenciais (description ≤180 chars, categoria válida, etc.)
- Shiki syntax highlighting (SSR, zero JS client-side)
- 0 JavaScript por default (Astro ship só HTML)

## Próximas features (backlog)

- [ ] Pagefind (busca client-side)
- [ ] Giscus comments
- [ ] RSS feed
- [ ] Search sitemap
- [ ] View counter (via Plausible)
- [ ] Trilha pages (`/learn/paths/[slug]`)

## Contribuir

- Bugs / sugestões: abrir issue em [axondevi/axon](https://github.com/axondevi/axon)
- Submit tutorial: enviar PR com novo arquivo em `src/content/tutorials/`
- Traduções: copiar tutorial + trocar `lang: pt-BR` → `en` (ou vice-versa) + traduzir conteúdo

## Licença

MIT — mesmo do repo principal do Axon.
