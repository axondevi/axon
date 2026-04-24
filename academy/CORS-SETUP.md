# CORS Setup — requisito pro Playground funcionar em produção

O Playground e os widgets `<TryCall />` fazem **chamadas diretas do browser** pra `axon-kedb.onrender.com`. Pra isso funcionar em produção, o backend Axon precisa permitir o domínio da Academy na whitelist CORS.

## Situação atual (memória do projeto)

```
CORS_ALLOWED_ORIGINS=https://axon-5zf.pages.dev
```

## Cenários e o que fazer

### Cenário A — Academy no mesmo domínio `/learn`
Se o deploy ficar em `https://axon-5zf.pages.dev/learn` (via Opção A do DEPLOY.md ou proxy no landing), CORS já está OK. **Não precisa mudar nada.**

### Cenário B — Academy em subdomínio `axon-academy.pages.dev`
Se deployar como projeto Pages separado, precisa **adicionar o novo origin** no backend:

```bash
# Atualizar env var no Render
curl -X PATCH https://api.render.com/v1/services/srv-d7k49tdf420s7385ud10/env-vars \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "key": "CORS_ALLOWED_ORIGINS",
      "value": "https://axon-5zf.pages.dev,https://axon-academy.pages.dev"
    }
  ]'
```

Ou via dashboard Render:
1. https://dashboard.render.com/web/srv-d7k49tdf420s7385ud10/env
2. Edit `CORS_ALLOWED_ORIGINS`
3. Set: `https://axon-5zf.pages.dev,https://axon-academy.pages.dev`
4. Save → triggers redeploy (2-3 min)

### Cenário C — Domínio custom no futuro (ex: `learn.axon.dev`)
Adicionar no mesmo env var:
```
https://axon-5zf.pages.dev,https://axon-academy.pages.dev,https://learn.axon.dev
```

## Como testar se CORS está OK

No console do browser na página `/playground`:

```js
fetch('https://axon-kedb.onrender.com/v1/signup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'test@example.com' })
}).then(r => console.log(r.status));
```

Se aparecer `Status: 200` ou `409` (email já existe): ✅ CORS OK.
Se aparecer erro `Access to fetch ... has been blocked by CORS`: ❌ precisa adicionar origin.

## Alternativa — Proxy via landing (sem mexer em CORS)

Se não quiser mexer no backend, pode **rodar Academy sob o mesmo origin** do landing:

1. No landing `_redirects`, adicionar:
```
/learn/*  https://axon-academy.pages.dev/learn/:splat  200
```

2. Ou usar Cloudflare Worker pra reescrever:
```js
addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/learn')) {
    url.hostname = 'axon-academy.pages.dev';
    return fetch(new Request(url, event.request));
  }
});
```

Opção do redirect 200 é mais simples. Com isso, o browser do usuário vê `axon-5zf.pages.dev/learn/*` como origin → CORS original já funciona.

## Segurança

- `CORS_ALLOWED_ORIGINS` rejeita qualquer origem não listada. Pré-flight OPTIONS retorna 403.
- Credentials (Authorization header) só são aceitas com origin na whitelist.
- Wildcards (`*`) **não são aceitos** em produção — hardcode origens específicas.
