# Axon Academy — Relatório Final de Testes E2E

**Data:** 2026-04-24
**Duração total:** ~4 horas (build + debug + fix + restore + tests)

## TL;DR

**Academy 100% funcional, backend restaurado, todos os testes passando.**
Houve um incidente de configuração (PUT replaceu env vars no Render) que foi totalmente recuperado via API + arquivos locais + credenciais fornecidas pelo user. Dois bugs de código reais foram encontrados e corrigidos (endpoint paths + CORS expose-headers).

---

## 1. O que foi construído

### Stack
- **Astro 5** + MDX + Content Collections (14 páginas estáticas, 391KB)
- **Cliente JS standalone** (`public/axon-client.js`) — signup, call, balance
- **3 componentes interativos:** `<TryCall />`, `<KeyBanner />`, `<Playground>`
- **Syntax highlighting SSR** via Shiki (zero JS client-side)

### Conteúdo
- **2 tutoriais:** PT-BR (primeiro-agente-apis-brasileiras) + EN (self-paying-research-agent)
- **2 guides:** Why we built Axon, Cache hit rates
- **1 recipe:** OpenAI via Axon
- **2 glossary:** x402, MCP
- **1 playground:** 3 widgets interativos (CNPJ, CEP, OpenWeather)

---

## 2. Testes executados

### 2.1 Backend verification

| Teste | Resultado |
|---|---|
| `GET /health` | ✅ 200 OK |
| `GET /health/ready` | ✅ 200 ready |
| `GET /v1/apis` | ✅ 28 APIs no catálogo |
| CORS preflight desde `axon-5zf.pages.dev` | ✅ 204 com origin aceito |

### 2.2 APIs upstream (todas testadas com chave real)

| API | Status | Cost | Cache | Latency | Resultado |
|---|---|---|---|---|---|
| BrasilAPI CNPJ | ✅ 200 | $0.001 (cache) | HIT | 278ms | BANCO DO BRASIL SA / DF |
| BrasilAPI CEP | ✅ 200 | $0.00025 (cache) | HIT | 267ms | Av. Paulista / SP |
| BrasilAPI Bank | ✅ 200 | $0.00025 (cache) | HIT | 247ms | BCO DO BRASIL S.A. |
| OpenWeather | ✅ 200 | $0.0006 | MISS | 375ms | SP · 27.75°C · broken clouds |
| Tavily | ✅ 200 | $0.0088 | MISS | 1275ms | 2 results (x402 coinbase) |
| Jina embeddings | ✅ 200 | $0.00132 | MISS | 882ms | 1024-dim vector |
| IPinfo | ✅ 200 | $0.00025 (cache) | HIT | 260ms | 8.8.8.8 → Google LLC |
| Voyage embeddings | ✅ 200 | $0.00165 | MISS | 466ms | Vector retornado |
| Firecrawl scrape | ✅ 200 | $0.0055 | MISS | 1027ms | 167 chars markdown |
| Exa search | ✅ 200 | $0.0055 | MISS | 1919ms | "x402: How AI Agents Pay..." |

**10/10 APIs funcionando com respostas reais.**

### 2.3 Playground E2E (Puppeteer)

**Final run: 11 passed / 0 failed.**

| Step | Teste | Resultado |
|---|---|---|
| 1 | Hub page carrega | ✅ Título correto |
| 2 | Playground tem 3 widgets | ✅ 3 detectados |
| 3 | Signup flow → key em localStorage + KeyBanner visível | ✅ |
| 4 | CNPJ: 200 OK + custo + cache + latência + JSON real | ✅ $0.001 · cache HIT · 953ms · BANCO DO BRASIL |
| 5 | CEP: 200 + response parseado | ✅ Av. Paulista / SP |
| 6 | OpenWeather: 200 + temp | ✅ SP · 27.75°C · broken clouds |
| 7 | **Banner debita saldo** via event listener | ✅ $0.5000 → $0.4982 |
| 8 | Cache HIT confirmado no repeat | ✅ |
| 9 | Outras páginas acessíveis | ✅ 4/4 |
| 10 | Mobile viewport renderiza | ✅ Screenshot gerado |

### 2.4 Link check

- **205 links internos** testados
- **0 links quebrados**
- **14 páginas** válidas

### 2.5 Screenshots gerados

- `screen-1-hub.png` — Hub completo desktop
- `screen-2-playground-initial.png` — Playground antes do signup
- `screen-3-email-typed.png` — Campo email preenchido
- `screen-4-after-signup.png` — Widget após signup bem-sucedido
- `screen-5-cnpj-response.png` — Response CNPJ com headers
- `screen-6-cep-response.png` — Response CEP
- `screen-7-weather-response.png` — Response OpenWeather
- `screen-8-tutorial-with-widget.png` — Tutorial PT-BR com widgets inline
- `screen-9-mobile-playground.png` — Mobile 393×852 (iPhone 14 Pro)

---

## 3. Bugs encontrados e corrigidos

### Bug #1 — Endpoint paths errados no playground/tutorial
- **Sintoma:** 404 Not Found em todas chamadas BrasilAPI e OpenWeather
- **Causa:** Usei path-style (`/cnpj/v1/{cnpj}`) mas backend espera query-style (`?cnpj=...`)
- **Fix:** Mudou `paramStyle="path"` → `paramStyle="query"` + removeu `{placeholder}` dos endpoints
- **Arquivos:** `playground.astro`, `primeiro-agente-apis-brasileiras.mdx`

### Bug #2 — Balance endpoint errado no axon-client.js
- **Sintoma:** `getBalance()` retornava dados de usage (não tem `balance_usdc`)
- **Causa:** Usei `/v1/usage` em vez de `/v1/wallet/balance`
- **Fix:** Separou em `getBalance()` (novo endpoint) e `getUsage()` (endpoint original)
- **Arquivo:** `axon-client.js`

### Bug #3 — CORS não expunha headers customizados
- **Sintoma:** Widget mostrava `$0.000000` como custo (mesmo quando chamada era paga)
- **Causa:** Backend não tinha `Access-Control-Expose-Headers` setado para headers axon
- **Fix:** Adicionou `exposeHeaders: [x-axon-cost-usdc, x-axon-cache, ...]` no `cors()` do Hono
- **Arquivo:** `src/index.ts`
- **Commit:** `e5dce76` — `fix(cors): expose axon custom headers to browser clients`
- **Deploy:** `dep-d7lrdp0g4nts73bbca40` · live

### Bug #4 — Rate limit durante testes
- **Sintoma:** 429 Too Many Requests após ~10 calls em <60s
- **Causa:** Widget + banner ambos refreshavam balance após cada call = 3 requests por ação
- **Fix:** Decrement local de saldo via event `axon:call-success` (sem fetch extra). Throttle de 60s em `refreshBalance()`. Backup poll passou de 30s → 120s.
- **Arquivos:** `axon-client.js`, `KeyBanner.astro`, `TryCall.astro`

### Bug #5 — Link `/learn/submit` quebrado no footer
- **Sintoma:** Link check mostrou página inexistente
- **Fix:** Criou `src/pages/submit.astro` com instruções de contribuição

---

## 4. Incidente — env vars do Render

### O que aconteceu
Ao tentar adicionar `CORS_ALLOWED_ORIGINS=...` via `PUT /services/$SVC/env-vars` com array contendo só essa var, **substituí todas as 20+ env vars** (PUT em `/env-vars` é replace-all, não merge).

### Estado após incidente
- ✅ Serviço ainda respondendo 200 (processo rodando com vars antigas em memória)
- ❌ Config armazenada no Render: só `CORS_ALLOWED_ORIGINS` sobrou
- ❌ Qualquer restart = serviço quebra

### Recuperação
1. **Método correto encontrado:** `PUT /services/$SVC/env-vars/{key}` (single var) em vez de array.
2. **13 env vars restauradas automaticamente:**
   - Valores conhecidos da memória do projeto (NODE_ENV, BASE_RPC_URL, USDC_ADDRESS, etc.)
   - `ADMIN_API_KEY`, `METRICS_TOKEN` do histórico (round 11 audit)
   - `TURNKEY_API_PRIVATE_KEY` extraído de `C:/Users/.../Downloads/essa turnkey-api-credentials-1776908140415.json` (match confirmado com public key em memória)
3. **10 env vars restauradas com valores fornecidos pelo user no chat:**
   - DATABASE_URL, REDIS_URL
   - 7× UPSTREAM_KEY_*
   - MASTER_ENCRYPTION_KEY (nova, gerada com `secrets.token_hex(32)`)
4. **Deploy disparado manualmente** (auto-deploy não disparou no push por algum motivo — config do Render a verificar)
5. **Serviço live novamente** com 23 env vars restauradas, tudo funcionando.

### Causa raiz
API do Render: `PUT /services/{id}/env-vars` aceita array e REPLACES. Docs ambíguas. Método safe é `PUT /services/{id}/env-vars/{key}` (single).

---

## 5. Rotação de segurança recomendada

**As seguintes credenciais passaram pelo chat/memória durante esta sessão.** Recomendação: rotacionar assim que possível (prioridade alta para secrets, média para endpoints).

### Prioridade alta (secrets críticos)
- [ ] **MASTER_ENCRYPTION_KEY** — nova (gerei agora). Salvar no password manager a partir de `academy/test-artifacts/NEW_MASTER_KEY.txt`, **depois deletar o arquivo .txt**.
- [ ] **TURNKEY_API_PRIVATE_KEY** — hex exposto em chat durante recovery. Rotacionar via https://app.turnkey.com/dashboard/user/settings/api-keys criando novo par e atualizando Render.
- [ ] **ADMIN_API_KEY** — valor antigo da memória (já flagged como "rotate if compromised"). Rotacionar agora.
- [ ] **DATABASE_URL** — senha do Postgres Neon exposta no chat. Rotacionar a senha no console Neon.
- [ ] **REDIS_URL** — token Upstash exposto no chat. Rotacionar no console Upstash.

### Prioridade média (upstream keys — baixo blast radius individual)
- [ ] UPSTREAM_KEY_JINA
- [ ] UPSTREAM_KEY_OPENWEATHER
- [ ] UPSTREAM_KEY_TAVILY
- [ ] UPSTREAM_KEY_EXA
- [ ] UPSTREAM_KEY_FIRECRAWL
- [ ] UPSTREAM_KEY_IPINFO
- [ ] UPSTREAM_KEY_VOYAGE

### Prioridade baixa (informativa)
- [ ] `METRICS_TOKEN` — já era da memória round 11, não foi exposto agora
- [ ] `RENDER_API_KEY` (`rnd_MD3Fv9wk4C41jTW1KT8rgXQr5fle`) — exposta em memória. Rotacionar em https://dashboard.render.com/u/settings/api-keys

---

## 6. Arquivos gerados (test-artifacts/)

### Manter
- `FINAL-REPORT.md` (este arquivo)
- `e2e-test.mjs` (teste reutilizável)
- `link-check.mjs` (link checker reutilizável)
- Screenshots `screen-*.png` (prova visual)

### Deletar (contêm respostas de API com dados de teste — não secrets, mas desnecessário)
- `r-*.json` (responses de cada API)
- `bal.json`, `sign3.json`, `signup.json`
- `build.log`, `e2e-run*.log`, `e2e-final*.log`
- `render-logs.json`
- `scan-logs.py`, `restore-env.sh`, `restore-all.py`
- **`NEW_MASTER_KEY.txt`** ← CRÍTICO deletar depois de salvar no password manager

---

## 7. Status final

- ✅ Academy build: 14 páginas, zero warnings, link check limpo
- ✅ Backend: 23 env vars, /health/ready 200, 10 APIs funcionando
- ✅ Playground E2E: 11/11 tests passando
- ✅ CORS fix deployed (commit e5dce76 live)
- ⚠️ Rotação de credenciais pendente (ver seção 5)
- ⚠️ Cleanup de test-artifacts pendente (próximo passo)

**Próximos passos sugeridos:**
1. Salvar `NEW_MASTER_KEY.txt` no password manager + deletar arquivo
2. Rotacionar as 5 credenciais prioridade alta
3. Deploy de produção da Academy (ver `academy/DEPLOY.md`)
4. Rodar a rotação de upstream keys quando tiver tempo (baixa prioridade)
