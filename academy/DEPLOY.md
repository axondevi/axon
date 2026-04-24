# Como colocar o Axon Academy no ar

Guia rápido pra levar o site de `localhost:4321/learn` pra `axon-5zf.pages.dev/learn`.

## Opção A: Deploy separado (mais simples — recomendado)

Deploya o Academy como projeto Cloudflare Pages independente, depois adiciona um proxy no landing principal.

### 1. Commit e push

```bash
cd "C:\Users\Usuario(a) Master\Desktop\axon"
git add academy/
git commit -m "feat: add Axon Academy (Astro site)"
git push
```

### 2. Cria projeto novo no Cloudflare Pages

1. https://dash.cloudflare.com → Workers & Pages → Create
2. Pages → Connect to Git → seleciona repo `axondevi/axon`
3. **Project name:** `axon-academy`
4. **Production branch:** `main`
5. **Framework preset:** Astro
6. **Build settings:**
   - Build command: `cd academy && npm install && npm run build`
   - Build output directory: `academy/dist`
   - Root directory: (vazio)
7. **Environment variables:** nenhuma por enquanto
8. Save and Deploy

Depois do primeiro build (~2-3 min), ficará disponível em:
**`https://axon-academy.pages.dev/learn`**

### 3. Adiciona proxy no landing principal

Pra ficar em `axon-5zf.pages.dev/learn` (mesmo domínio), edita o `_redirects` do landing:

```
# C:\Users\Usuario(a) Master\Desktop\axon\landing\_redirects

/learn       https://axon-academy.pages.dev/learn/  301
/learn/*     https://axon-academy.pages.dev/learn/:splat  301
```

Commit e push o landing. Pronto.

**Importante:** `301` redireciona (muda URL no browser). Se quiser preservar URL, use um Cloudflare Worker ou Custom Domain (mais complexo).

## Opção B: Copiar dist pro landing (mais simples ainda)

Se quer tudo num projeto Pages só, faz o Academy buildar DENTRO do landing:

### 1. No `astro.config.mjs`, muda outDir

```js
export default defineConfig({
  outDir: '../landing/learn',
  // ...
});
```

### 2. Build

```bash
cd academy
npm run build
# agora landing/learn/ tem os arquivos
```

### 3. Ajusta landing deploy

O landing já deployado em `axon-5zf.pages.dev` agora também serve `/learn`. Commita e pusha.

**Problema:** toda vez que atualizar Academy, tem que rebuildar manual. Opção A é melhor long-term.

## Opção C: Custom domain (futuro)

Quando comprar `axon.dev`:

1. Adiciona domain em Cloudflare Pages (no projeto axon-academy)
2. Configura subpath `/learn` ou subdomain `learn.axon.dev`
3. Remove os redirects.

---

## ⚠️ IMPORTANTE — CORS para Playground funcionar

O Playground e widgets interativos fazem chamadas diretas do browser pro backend Axon. **Precisa que o backend aceite o origin da Academy**. Se deployar em domínio diferente do landing, veja [CORS-SETUP.md](./CORS-SETUP.md) antes.

**Resumo rápido:**
- Academy em `axon-5zf.pages.dev/learn` (via proxy do landing) → CORS já OK
- Academy em `axon-academy.pages.dev` → adicionar origin em `CORS_ALLOWED_ORIGINS` no Render

## Checklist pré-deploy

- [ ] `npm run build` roda sem erro local
- [ ] `npm run preview` mostra o site corretamente
- [ ] Testou hub page (/learn)
- [ ] Testou tutorial page (/learn/tutorials/primeiro-agente-apis-brasileiras)
- [ ] Testou guide (/learn/guides/why-we-built-axon)
- [ ] Testou glossary (/learn/glossary/x402)
- [ ] Commit feito
- [ ] Push feito

## Como atualizar conteúdo

Depois do primeiro deploy, adicionar tutorial novo é:

1. Criar arquivo em `academy/src/content/tutorials/nome.md`
2. `git commit -am "docs: novo tutorial X"`
3. `git push`
4. Cloudflare detecta push → build automático → ao vivo em 2-3 min

## Monitoramento

- **Analytics:** Cloudflare Web Analytics (grátis, automático no Pages)
- **SEO:** Google Search Console (precisa adicionar o domínio manual)
- **Errors:** Cloudflare dashboard → Pages → axon-academy → Functions (se usar)

## Custo

**$0/mês.** Cloudflare Pages free tier cobre:
- 500 builds/mês (a gente vai usar ~20)
- Tráfego ilimitado
- Todos os domínios
- Sem expiração
