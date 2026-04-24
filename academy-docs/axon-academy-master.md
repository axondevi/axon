# Axon Academy

## Documento Mestre — Estratégia, Arquitetura e Plano de Execução

**Versão 1.0** — 24 de abril de 2026
**Autor:** Planejamento conjunto com o operador do Axon
**Objetivo:** Plantar as fundações de uma plataforma de aprendizado sobre agentes de IA que sirva como (1) motor de aquisição de usuários via SEO, (2) ativo defensivo de marca, e (3) ferramenta de comunidade para o ecossistema Axon.

---

## Prefácio — Como usar este documento

Este documento foi escrito para quem vai **construir junto**, não apenas aprovar. Cada decisão aqui tem um *porquê* explicado antes do *quê* — quando você entender o raciocínio, vai conseguir tomar decisões futuras por conta própria, sem precisar me consultar em cada passo.

**Legenda que aparece ao longo do texto:**

- **PORQUÊ:** a motivação estratégica por trás da escolha
- **DICA:** atalho prático ou heurística
- **AÇÃO SUA:** algo que só você pode/deve fazer (autenticidade de BR, voz, contatos)
- **ARMADILHA:** erro comum que vamos evitar
- **TRADEOFF:** o que estamos trocando ao escolher este caminho

**Como ler:**

- **Se tem 30 minutos:** leia o Prefácio, a Parte 1 (Visão) e a Parte 10 (Como você contribui).
- **Se tem 2 horas:** leia na ordem. É construído para ler linearmente.
- **Se tem pressa pra aprovar e mandar eu construir:** vá direto na Parte 11 (Decisões pendentes) no fim.

---

## Sumário

1. Visão estratégica
2. SEO 101 — aula rápida pra você saber o que estamos fazendo
3. Arquitetura do site (a estrutura `/learn`)
4. Os 10 artigos-pilar — um por um, destrinchados
5. Design & UX
6. Stack técnica — por que cada ferramenta
7. Plano de execução — semana 1, mês 1, meses 2-6
8. Community & Marketing — como aprendizado vira audiência
9. Métricas & KPIs — como medir sucesso sem se iludir
10. Como você contribui — seu papel no projeto
11. Decisões pendentes que preciso de você para seguir
12. Apêndices — glossário, templates, links

---

# PARTE 1 — Visão estratégica

## 1.1 Por que criar uma Academy agora?

Axon hoje é um produto técnico bem executado em busca de usuários. Tem 28 APIs, self-service signup, wallet real via Turnkey, MCP server, SDK em 3 linguagens — mas zero USDC real entrou ainda. O gap entre "produto pronto" e "produto usado" é de **distribuição**.

Três caminhos clássicos de distribuição para ferramentas de dev:

1. **Outbound sales (DMs, email, vendas)** — funciona mas não escala sem time comercial
2. **Viral / launches (Show HN, Product Hunt)** — picos de tráfego, vale de morte depois
3. **Content / SEO / Comunidade** — construção lenta, mas que compõe juros

O plano atual de 14 dias foca em (1) outbound. Está certo pro curto prazo. Mas (3) é o único caminho que ainda está gerando usuários pro Axon daqui a 2 anos, sem você precisar acordar todo dia pra mandar DM.

**PORQUÊ começar Academy agora, não depois do primeiro cliente pagante:**
- SEO leva 3-6 meses para ranquear. Quanto antes plantar, antes colhe.
- Conteúdo novo serve de material para DMs imediatamente (dia 1).
- Repo público com documentação séria sinaliza profissionalismo para investidores/parceiros.
- Custo marginal = seu tempo + meu tempo. Infra é $0 (Cloudflare Pages).

**TRADEOFF:** Tempo gasto escrevendo conteúdo é tempo NÃO gasto conversando com usuários. Por isso o MVP é enxuto — plantamos semente e continuamos focados em conversar com os primeiros clientes.

## 1.2 O que a Academy resolve — para o Axon e para o leitor

### Para o Axon (nosso lado)
- **Funil de aquisição orgânica:** pessoa busca "como criar agente IA em Python" → encontra tutorial nosso → vê botão "$0.50 grátis pra testar no Axon" → assina.
- **Defensibilidade:** enquanto concorrentes (OpenRouter, Helicone) só têm docs técnicas, Axon tem tutoriais. Conteúdo é moat real — leva anos pra replicar.
- **Sinal de qualidade:** empresa séria publica conteúdo sério. Atalha confiança na hora de alguém decidir depositar dinheiro.
- **Feedback loop:** comentários nos tutoriais → entendemos dúvidas reais → melhoramos produto.

### Para o leitor (lado deles)
- **Aprende algo difícil** (agentes IA, pagamento autônomo, APIs brasileiras em IA) **em PT-BR**.
- **Código que roda de verdade** — não é tutorial fake de blog que não funciona.
- **Crédito grátis ($0.50)** pra testar sem cadastrar cartão.
- **Comunidade** onde perguntar dúvida e ser respondido.

**Princípio norteador:** se o leitor sair sem entender nada de Axon, mas tiver aprendido algo valioso, já ganhou. Isso gera reciprocidade e boca-a-boca.

## 1.3 Posicionamento — os 3 nichos que vamos dominar

Não vamos ensinar "IA do zero". Esse mercado está lotado (Andrej Karpathy no YouTube, fast.ai, DeepLearning.AI, Alura, Hashtag Treinamentos, centenas de cursos).

Vamos dominar três nichos específicos onde quase ninguém tem autoridade ainda:

### Nicho 1: **Agentes self-paying com x402**
Agentes que pagam pelas próprias APIs usando USDC na Base L2. Axon é um dos primeiros players. Esse nicho tem volume baixo hoje (~500 buscas/mês no Google), **mas 100% relevantes** e sem competição real.

- **PORQUÊ:** quem já busca "x402" ou "self-paying agents" é hyper-qualified. Taxa de conversão absurda.
- **Risco:** pode morrer se x402 não pegar. Mitigação: conteúdo reaproveita para outros protocolos.

### Nicho 2: **Agentes IA em PT-BR com dados brasileiros**
Tutoriais escritos em português, usando APIs brasileiras (CNPJ, CEP, FIPE, PIX). Zero competição. Volume alto (queries tipo "como criar agente de IA" têm >5k/mês só no Brasil).

- **PORQUÊ:** o mercado BR de dev IA está crescendo rápido, mas todo conteúdo sério está em inglês. Enorme arbitragem linguística.
- **Vantagem injusta:** você é brasileiro e sabe o que um PME brasileiro precisa. Concorrente americano não consegue replicar isso sem contratar alguém daqui.

### Nicho 3: **Produção real de agentes** (deploy, custo, escala)
A maioria dos tutoriais de IA para como rodar "hello world" no Jupyter. Poucos ensinam: como colocar em produção, como controlar custo, como escalar. Axon tem dados reais (cache hit rates, latências, custos por API) que ninguém mais tem.

- **PORQUÊ:** quem está pesquisando "how to deploy LangChain production" é alguém próximo de pagar. Alto intent.

**TRADEOFF:** ao focar em 3 nichos, deixamos tráfego genérico na mesa (ex: "what is an API"). Tudo bem — quem busca isso não vai virar cliente de API gateway pago.

## 1.4 O que a Academy NÃO é (proteção de foco)

Tão importante quanto definir o que vai ser, é definir o que **não** vamos construir. Sem isso, escopo incha e nada fica bom.

- **NÃO** é um curso de Python/JavaScript do zero.
- **NÃO** é tutorial de "o que é Machine Learning" ou "como treinar um modelo".
- **NÃO** é plataforma de vídeo-aula com certificado pago.
- **NÃO** é blog pessoal / opinião / thought leadership.
- **NÃO** é documentação do produto Axon (isso fica em `/docs`).

É tutorial **prático**, focado em **construir agentes que fazem alguma coisa útil**, usando Axon quando útil, sem empurrar. Parece contraintuitivo não empurrar o produto, mas é exatamente isso que cria confiança.

**ARMADILHA:** tentar transformar Academy em "tudo sobre IA". Vira sopão genérico que não ranqueia e não converte. Vamos ser chatos de focados.

## 1.5 Como Academy conversa com o plano de 14 dias

O plano atual (14 dias pra primeiro cliente pagante) continua intocado. A Academy roda em paralelo, com estas sinergias:

- **Dia 2 do plano (gravar demo video):** script já cita conceitos que serão explicados em profundidade na Academy. No futuro, cada tutorial pode ter mini-vídeo.
- **Dia 3-5 (DMs pra usuários):** anexamos tutorial relevante ao DM. "Achei interessante seu projeto X, escrevi esse tutorial sobre Y usando Axon — quer testar?" Taxa de resposta muito maior do que pitch puro.
- **Dia 7 (primeira entrevista com usuário):** perguntar "que tutorial você gostaria de ler?" — guia conteúdo futuro direto da necessidade do usuário.
- **Dia 11 (thread Twitter):** cada pillar vira mini-thread. Academy alimenta Twitter de graça.

Ou seja: Academy **não atrasa** lançamento, **acelera**.

---

# PARTE 2 — SEO 101: aula rápida

Você vai tomar dezenas de decisões de conteúdo. Sem entender SEO mínimo, vai ser "palpite". Aqui está o essencial.

## 2.1 O que é SEO de verdade

SEO não é "truques pro Google". É três coisas, nessa ordem de importância:

1. **Resposta útil à pergunta que a pessoa digitou.** 80% do SEO é isso.
2. **Estrutura técnica do site** (velocidade, HTML semântico, metadata).
3. **Autoridade** (outros sites linkando pro seu).

Empresas pequenas quase sempre perdem em (3) — concorrentes grandes têm mais backlinks. Só resta ganhar em (1) e (2): escrever melhor, responder mais completo, carregar mais rápido.

**PORQUÊ Astro é bom para isso:** ele vence em (2) por default (ship 0 JS, HTML puro, build time otimizado). Deixa você focado em (1).

## 2.2 Intent — a variável mais importante que ninguém explica

Toda busca no Google tem um **intent** por trás. Pense assim:

- **Informacional:** "o que é x402" → quer aprender
- **Navegacional:** "axon login" → quer ir pra lugar específico
- **Comercial:** "melhor api gateway ai" → tá comparando pra comprar
- **Transacional:** "contratar openai api" → quer comprar agora

Academy foca em **informacional + comercial**. Porque:

- **Informacional** traz volume (muita gente aprendendo).
- **Comercial** traz conversão (pouca gente, mas quase pagando).

**DICA:** quando for escrever um artigo, pergunte primeiro: "o que a pessoa que buscou isso quer no próximo minuto?". O artigo tem que dar isso, não sua opinião.

## 2.3 Pillar content vs cluster content

Essa é a arquitetura de conteúdo moderna. Imagine uma árvore:

```
        [Pillar: Como Criar Agente de IA]
       /          |           |           \
   [Cluster 1]  [Cluster 2] [Cluster 3]  [Cluster 4]
   LangChain    CrewAI      Cost         Deploy
   básico       básico      control      prod
```

- **Pillar:** artigo grande, abrangente (3000-5000 palavras), responde a query ampla.
- **Clusters:** artigos focados em sub-tópicos, linkam DE VOLTA pro pillar.

**PORQUÊ funciona:**
- Google entende que você é autoridade no tema (muitos artigos inter-linkados).
- Leitor pode ir do geral (pillar) pro específico (cluster) ou vice-versa.
- Você publica 1 pillar + 10 clusters = 11 portas de entrada pro mesmo tema.

**DICA:** comece pelos pillars. Depois, a cada tutorial novo, ligue ele ao pillar certo.

## 2.4 Long-tail vs head terms

- **Head term:** "agente IA" — volume alto, competição absurda, difícil ranquear.
- **Long-tail:** "como criar agente de IA para consultar CNPJ em Python" — volume baixo, competição zero, **fácil ranquear e altíssima intenção**.

**Estratégia Academy:** competir em long-tail. 100 long-tails ranqueando na primeira posição > 1 head term ranqueando na terceira página.

Vamos escrever pensando em perguntas reais que devs fazem. Cada pergunta é um long-tail potencial.

## 2.5 Por que PT-BR é ouro enterrado

Exemplos reais (estimativas de volume mensal Google):

| Query | Volume PT-BR | Competição | Em EN |
|---|---|---|---|
| "como criar agente de IA" | ~4.400 | baixa | "how to build AI agent" = 40k, competição alta |
| "integrar openai python" | ~1.900 | baixa | lotado |
| "api cnpj python" | ~880 | muito baixa | não existe em EN |
| "langchain tutorial portugues" | ~320 | zero | tutoriais em EN só |
| "chatbot empresa brasileira" | ~1.300 | média | irrelevante em EN |

Tradução: em PT-BR, competindo com 5-10 artigos meia-boca. Em EN, competindo com Vercel, OpenAI, DeepLearning.AI, Medium, etc.

**AÇÃO SUA:** conteúdo em PT-BR tem que ter voz natural brasileira. Você é imbatível aqui — eu traduzo ou reviso, mas a voz tem que ser sua.

## 2.6 Honestidade sobre timeline

Conteúdo demora. Eis o que esperar honestamente:

- **Semana 1-4:** quase zero tráfego orgânico. Alguns poucos visitantes via Twitter.
- **Mês 2-3:** Google começa a indexar. Primeiros ranks em long-tails (páginas 3-5 do Google).
- **Mês 4-6:** primeiros rankings em primeira página para long-tails bem trabalhados.
- **Mês 6-12:** tráfego orgânico começa a valer a pena (100-500 visitas/mês por artigo bom).
- **Ano 2:** tráfego composto, alguns artigos viram **evergreen** (trazem tráfego por anos).

**ARMADILHA:** desanimar no mês 2 quando "ninguém leu". Isso é normal. Conteúdo é juros compostos.

---

# PARTE 3 — Arquitetura do site

## 3.1 Estrutura de URLs

```
axon-5zf.pages.dev/learn                    → hub
axon-5zf.pages.dev/learn/paths              → lista de trilhas
axon-5zf.pages.dev/learn/paths/agents-101   → trilha iniciante
axon-5zf.pages.dev/learn/tutorials          → todos tutoriais (paginado)
axon-5zf.pages.dev/learn/tutorials/primeiro-agente-brasil
axon-5zf.pages.dev/learn/guides             → artigos conceituais
axon-5zf.pages.dev/learn/guides/o-que-e-x402
axon-5zf.pages.dev/learn/recipes            → cookbook de snippets
axon-5zf.pages.dev/learn/recipes/cache-openai-call
axon-5zf.pages.dev/learn/glossary           → definições curtas
axon-5zf.pages.dev/learn/glossary/mcp
```

**PORQUÊ essa estrutura em vez de /blog ou /docs:**
- `/blog` soa pessoal e efêmero; Academy é durável.
- `/docs` é reservado pra documentação de API.
- `/learn` é claro, simples, memorável, e traduz bem.

## 3.2 Tipos de conteúdo — por que cada um existe

### Trilhas (Paths)
Sequências curadas de 5-10 tutoriais que levam do zero a resultado concreto. Ex: "Do zero a um agente Telegram que consulta CNPJ".

- **PORQUÊ:** iniciante não sabe por onde começar. Trilha dá mão e conduz.
- **SEO:** baixo. Trilhas convertem, não atraem tráfego puro.
- **Marketing:** ótimas pra compartilhar no Twitter ("acabei de publicar uma trilha completa sobre X").

### Tutoriais
Artigos passo-a-passo de 15-60 min de leitura, produzindo resultado rodável.

- **PORQUÊ:** 80% do tráfego vem daqui. É o core do SEO.
- **Estrutura padrão:** problema → pré-requisitos → código → explicação → próximos passos.

### Guias (Conceituais)
Artigos que explicam uma ideia sem necessariamente ter código. Ex: "O que é o protocolo x402 e por que ele importa".

- **PORQUÊ:** muita busca é "o que é X" — quem está aprendendo antes de construir.
- **SEO:** excelente. Ranqueiam bem porque respondem pergunta direta.

### Recipes (Cookbook)
Snippets curtos de código (10-30 linhas) que resolvem um problema específico. Ex: "Cachear chamada OpenAI por 1 hora" ou "Migrar de OpenAI pra Anthropic em 3 linhas".

- **PORQUÊ:** developers buscam código pronto, não teoria. Recipes viralizam em ferramentas tipo Stack Overflow.
- **SEO:** long-tail forte. Títulos são queries literais.

### Glossário
Páginas curtas (200-400 palavras) definindo termos. Ex: "MCP", "x402", "Cache Hit Rate".

- **PORQUÊ:** captura quem busca apenas "what is MCP". Google gosta de páginas que respondem perguntas definicionais.
- **SEO:** alta relação volume/esforço.

## 3.3 Jornada de 3 personas

Entender personas ajuda a escrever pensando em leitor real.

### Persona A — **Gabi, dev full-stack BR que tá curioso sobre IA**
- 26 anos, trabalha com React/Node em SP
- Sabe o que é OpenAI mas nunca construiu nada além de um chatbot ReactLint
- Quer aprender **agentes** mas não quer passar 3 meses estudando
- Googla: "como criar agente de ia em portugues", "langchain tutorial", "openai api exemplo"

**Jornada na Academy:**
1. Chega via busca → tutorial "Primeiro Agente de IA com APIs Brasileiras"
2. Termina tutorial → vê CTA "Rode isso no Axon, $0.50 grátis"
3. Signup → dashboard → vê as 28 APIs disponíveis
4. Volta pra Academy → entra na trilha `agents-101` → constrói mais 3 coisas
5. Viciou → conta pro amigo → virou usuário

### Persona B — **Rafael, solopreneur construindo SaaS**
- 34 anos, construiu micro-SaaS que usa OpenAI
- Conta OpenAI tá custando $300/mês, quer otimizar
- Googla: "openai cost optimization", "llm cache strategy", "cheapest llm api"

**Jornada:**
1. Chega via busca → pillar "AI Agent Cost Optimization"
2. Lê, vê que Axon oferece cache automático 50%
3. Signup, testa em projeto dele
4. Se funcionar, vira usuário de pagamento

### Persona C — **Ana, PM curiosa sobre IA em empresa BR**
- 38 anos, PM em fintech
- Não codifica, mas precisa entender o que é possível com IA pra planejar roadmap
- Googla: "casos de uso ia para empresas brasileiras", "ia atendimento cliente"

**Jornada:**
1. Chega via busca → "Agente de IA para Negócios Brasileiros"
2. Lê casos de uso, mostra pro time dev
3. Time dev é quem converte (mas Ana foi porta de entrada)

**DICA:** sempre que escrever um artigo, pergunte "qual persona vai achar isso?". Se nenhuma, não escreva.

## 3.4 Mapa mental do site

```
                         [/learn]
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
    [Paths]            [Tutorials]           [Guides]
    (trilhas)          (passo-a-passo)       (conceitos)
        │                   │                   │
        ├─ agents-101       ├─ primeiro-agente  ├─ o-que-e-x402
        ├─ self-paying      ├─ cnpj-ia-tutorial ├─ mcp-explicado
        ├─ production       ├─ deploy-render    ├─ cache-semantico
        └─ agentes-br       └─ cost-opt-guia    └─ llm-cost-basics
                            │
                       [Recipes]          [Glossary]
                       (cookbook)         (definições)
                            │                   │
                       ├─ openai-cache    ├─ mcp
                       ├─ migrar-llm      ├─ x402
                       ├─ rate-limit-py   ├─ cache-hit-rate
                       └─ stream-response └─ usdc-base
```

Todo pillar puxa 5-15 clusters. Todo cluster aponta de volta pro pillar. Todo conteúdo tem CTA pro Axon quando faz sentido.

---

# PARTE 4 — Os 10 artigos-pilar, um por um

Esta é a seção mais longa e mais importante. Cada pillar é dissecado em:

- **Título + subtítulo**
- **Query-alvo no Google**
- **Por que esse pillar existe** (estratégia)
- **Outcome do leitor** (o que ele sabe/faz depois)
- **Outline do artigo** (H2/H3 principais)
- **CTA pro Axon** (como converte)
- **5 clusters que saem dele**

## Pillar 1 — How to Build AI Agents That Pay for Their Own API Calls

**Subtítulo:** *The complete developer's guide to self-paying agents with x402, USDC, and Base L2.*

**Query-alvo:** `self-paying ai agents`, `x402 protocol tutorial`, `autonomous ai payment`, `http 402 agents`

**PORQUÊ:**
Esse é o pillar de **ownership puro**. Ninguém mais tem um pillar sério sobre isso. Coinbase tem documentação do protocolo mas não tutorial de construir agente. Nós somos os primeiros. Volume baixo hoje (~500-1500 buscas/mês globais), mas **crescendo rápido** e **100% relevante**. Quem busca isso está a 1 clique de virar cliente.

**Outcome do leitor:**
Entender o que é x402, por que ele existe, como protocolos de pagamento baseados em HTTP 402 funcionam, e **construir um agente real** que gasta USDC da própria wallet.

**Outline:**
1. O problema: agentes autônomos não podem usar cartão de crédito
2. A solução histórica: créditos prepagos / chaves de API centralizadas
3. HTTP 402: o "código esquecido"
4. x402: Coinbase ressuscita 402 com USDC + Base L2
5. Anatomia de um request x402 (headers, fluxo)
6. Wallets custodiais vs não-custodiais para agentes
7. **Hands-on:** construir agente Node que gasta USDC próprio
8. Considerações de segurança (rate limits, spend caps, withdrawal)
9. O que vem a seguir: multi-chain, cross-provider

**CTA:**
> "Quer testar sem configurar Turnkey e gerenciar seed phrase? Axon cuida da custódia pra você. [Cria sua wallet com $0.50 grátis →]"

**Clusters:**
1. "What is HTTP 402? The forgotten status code" (glossary → pillar 1)
2. "Custodial vs Non-Custodial Wallets for AI Agents" (guide)
3. "Turnkey Tutorial: Creating an Agent Wallet in 10 Minutes" (tutorial)
4. "USDC on Base: Why L2 Matters for Micropayments" (guide)
5. "5 Use Cases for Self-Paying Agents in 2026" (recipes)

---

## Pillar 2 — The Complete Guide to AI Agent APIs (2026 Edition)

**Subtítulo:** *Every API worth calling from an AI agent, compared honestly: LLMs, search, embeddings, audio, Brazilian data, and more.*

**Query-alvo:** `ai agent apis`, `best apis for ai agents`, `api aggregator ai`, `llm gateway`

**PORQUÊ:**
Alto volume (~3k/mês globais), mas competitivo. Vamos vencer com **diferencial de dados reais** — Axon tem cache hit rate, latência p95, custo médio de cada uma das 28 APIs. Ninguém mais tem.

**Outcome do leitor:**
Saber **qual API usar pra qual task**, com números reais de custo e latência. Sair do "OpenAI pra tudo" pro stack certo.

**Outline:**
1. Taxonomia de APIs pra agentes (LLM / search / embeddings / audio / tools / data)
2. **Tabelas comparativas** com dados reais:
   - LLMs: OpenAI vs Anthropic vs Together vs OpenRouter
   - Search: Tavily vs Exa vs SerpAPI vs Brave
   - Embeddings: OpenAI vs Voyage vs Jina
   - Audio: Deepgram vs ElevenLabs vs Cartesia
3. **APIs brasileiras** (seção especial — diferencial): BrasilAPI, etc.
4. Como escolher: matriz decisão por caso de uso
5. Por que centralizar chamadas num gateway (não obrigatoriamente Axon)

**CTA:**
> "Testa as 28 APIs com uma chave só. Signup em 10s, $0.50 de crédito: [axon-5zf.pages.dev/signup]"

**Clusters:**
1. "OpenAI vs Anthropic: 2026 Benchmark" (comparativo)
2. "Tavily vs Exa vs SerpAPI: Melhor API de Search pra Agente" (tutorial de comparação)
3. "Quando Usar Embeddings (e Qual)" (guide)
4. "APIs Brasileiras que Todo Agente de IA Deveria Conhecer" (pillar 7 também!)
5. "OpenRouter vs Axon vs Helicone: API Gateway Comparison" (polêmico, traz tráfego)

---

## Pillar 3 — Building Production AI Agents with LangChain, CrewAI & Vercel AI SDK

**Subtítulo:** *From Jupyter notebook to production deployment, without losing your sanity.*

**Query-alvo:** `langchain production`, `crewai tutorial`, `vercel ai sdk agents`, `ai agent deployment`

**PORQUÊ:**
Enorme volume (10k+/mês combinando termos). Dev que googla isso está construindo AGORA, não estudando. Alto intent.

**Outcome do leitor:**
Entender os 3 frameworks principais, quando usar cada um, e sair com um agente rodando em produção (Render/Fly/Railway).

**Outline:**
1. Panorama dos frameworks (9 que Axon integra, 3 mais usados)
2. **LangChain:** quando faz sentido, quando é overkill
3. **CrewAI:** multi-agent, quando vale a pena
4. **Vercel AI SDK:** o mais leve, ótimo pra web apps
5. **Escolhendo:** matriz decisão
6. **Hands-on:** mesmo agente em cada framework (código lado a lado)
7. **Deploy:** Dockerfile + Render
8. **Observabilidade:** logging, traces, custo por request
9. **Armadilhas de produção** (timeouts, retries, idempotência)

**CTA:**
> "Axon oferece integração nativa em todos esses frameworks — troque 1 linha e todas as 28 APIs ficam disponíveis. [Ver exemplos no GitHub →]"

**Clusters:**
1. "LangChain em Português: Do Zero ao Deploy"
2. "CrewAI: Quando Multi-Agent Vale a Pena"
3. "Vercel AI SDK: O Framework Mais Leve pra Agentes Web"
4. "Deploying AI Agents: Render vs Fly vs Railway"
5. "Logging & Observability for AI Agents in Production"

---

## Pillar 4 — AI Agent Cost Optimization

**Subtítulo:** *Caching, batching, smart routing, and tier selection: cut your LLM bill 50%+ without sacrificing quality.*

**Query-alvo:** `ai agent cost`, `llm cost optimization`, `openai caching`, `reduce api costs ai`

**PORQUÊ:**
Dev com conta OpenAI de $500/mês é o alvo perfeito. Esse pillar captura ele e oferece Axon como solução. Volume médio, conversão altíssima.

Temos um blog post em `blog/cache-hit-rates-17-apis.md` — vamos expandir pra pillar.

**Outcome do leitor:**
Reduzir custo em pelo menos 30% no próprio projeto dele aplicando as técnicas explicadas.

**Outline:**
1. Mapa completo do que gasta em agentes (tokens, calls, embeddings)
2. **Cache semântico:** como implementar + quando quebra
3. **Batching:** Anthropic/OpenAI batch APIs (50% desconto)
4. **Tier selection:** quando usar Haiku vs Sonnet vs Opus
5. **Smart routing:** cascata (barato → caro se barato falhar)
6. **Prompt compression:** Microsoft LLMLingua na prática
7. **Fallbacks:** se API X cair, usa Y
8. **Dados reais Axon:** cache hit rate médio por API
9. Checklist de auditoria de custo

**CTA:**
> "Axon faz cache automático em todas as APIs. Em média, 32% das calls são cache hits — isso é 50% off imediato. [Ver dados ao vivo]"

**Clusters:**
1. "Implementando Cache Semântico em Python" (tutorial)
2. "OpenAI Batch API: 50% Discount, Quando Usar"
3. "Haiku vs Sonnet vs Opus: Benchmark e Custo" (recipe)
4. "Prompt Compression com LLMLingua" (tutorial)
5. "Auditoria de Custo: Script Pra Descobrir Onde Você Gasta" (recipe)

---

## Pillar 5 — The 2026 State of AI Agent Infrastructure

**Subtítulo:** *Annual data-driven report: what's real, what's hype, what's coming. Based on 28 APIs and [X] requests from real agents.*

**Query-alvo:** `ai agent infrastructure`, `state of ai agents 2026`, `mcp servers 2026`, `ai agent stack`

**PORQUÊ:**
Report anual = link-bait. HN ama. Twitter ama. Vira referência citada por outros. Backlink goldmine.

Precisa de dados. Axon gera dados de produção. Combinação perfeita.

**Outcome do leitor:**
Panorama completo do espaço, sem hype. Decisões melhores sobre onde investir tempo/dinheiro em 2026.

**Outline:**
1. Executive summary (pra quem tem 2 min)
2. **Métricas do Axon em 2026:** cache hit rate, latência p95, volume por API, framework mais usado
3. **Frameworks em alta vs em queda** (LangChain ainda é rei? CrewAI cresceu?)
4. **Protocolos emergentes:** MCP, A2A, x402, AP2 (análise honesta)
5. **Casos de uso que realmente funcionaram em 2026**
6. **Casos de uso que fracassaram** (seção rara — diferencial)
7. **Previsões para 2027**
8. Metodologia (transparência)

**CTA:**
> "Quer ver esses números ao vivo? [Stats públicas do Axon →]"

**Clusters (que saem desse report):**
1. "Cache Hit Rate por API: o Ranking 2026"
2. "Por que LangChain Perdeu Market Share" (polêmico)
3. "MCP vs A2A vs x402: Entenda as Diferenças"
4. "AI Agent Postmortems: 5 Projetos que Fracassaram e Por Quê"
5. "AI Infrastructure Predictions 2027"

---

## Pillar 6 — Como Criar um Agente de IA em Português: Guia Completo 2026

**Subtítulo:** *Do zero a um agente funcionando, em português, com código comentado e deploy de verdade.*

**Query-alvo:** `como criar agente de ia`, `agente inteligente python portugues`, `chatbot ia tutorial portugues`, `langchain portugues`

**PORQUÊ:**
Nicho 2 (PT-BR) começa aqui. Volume alto (~4.400/mês). Competição baixa-média (blogs de conteúdo raso). Vencemos com profundidade + código que roda.

**AÇÃO SUA:** esse é O pillar onde sua voz importa mais. Precisa soar brasileiro, não tradução. Você reescreve a versão final.

**Outcome do leitor:**
Ter **um agente rodando em VPS com domínio** ao fim do tutorial. Não "rodar no Colab e esquecer".

**Outline:**
1. O que é um "agente de IA" (sem jargão, explicação que PME entende)
2. Anatomia: LLM + ferramentas + memória
3. Setup do ambiente (Python, venv, uv)
4. Primeira chamada OpenAI (em português, com exemplos BR)
5. Adicionando ferramenta: consultar CEP via BrasilAPI
6. Adicionando memória: conversa com histórico
7. Adicionando outra ferramenta: consultar CNPJ
8. Juntando tudo: agente que responde "me conte sobre a empresa X e onde ela fica"
9. Deploy no Render (passo a passo, grátis)
10. Monitoramento básico
11. Próximos passos (link pros outros pillars)

**CTA:**
> "Esse tutorial usa as chaves de API direto. Pra simplificar: use Axon e tenha uma chave só pra todas as APIs. [Ver como →]"

**Clusters:**
1. "Python para IA: Setup Profissional em 2026" (tutorial)
2. "BrasilAPI: Guia Completo do CEP ao CNPJ"
3. "Deploy de Agente no Render: Passo a Passo"
4. "Memória em Agentes: Redis vs Postgres vs In-Memory"
5. "Rate Limits em APIs Brasileiras: Como Tratar"

---

## Pillar 7 — Integrando APIs Brasileiras em Agentes de IA

**Subtítulo:** *CNPJ, CEP, FIPE, PIX, feriados, bancos: tudo o que seu agente brasileiro precisa saber, com exemplos rodáveis.*

**Query-alvo:** `api cnpj python`, `brasilapi tutorial`, `integrar cep ia`, `agente ia dados brasil`

**PORQUÊ:**
Nicho **exclusivo**. Zero concorrência séria em PT-BR. Axon já tem brasilapi integrado (28ª API). Converte absurdamente.

**AÇÃO SUA:** você conhece as dores de devs BR. Cita sistemas reais (Omie, Bling, RD Station, etc.) pra mostrar aplicação prática.

**Outcome do leitor:**
Construir um agente que faz lookup de empresa pelo CNPJ, valida CEP, consulta tabela FIPE, etc.

**Outline:**
1. Por que agentes precisam de dados brasileiros (casos reais)
2. **Tour pela BrasilAPI:** cada endpoint, o que retorna, quando usar
3. **CNPJ:** consultando empresa + usando LLM pra resumir situação
4. **CEP:** preenchimento de endereço automático
5. **FIPE:** agente que ajuda a precificar carro
6. **PIX:** (nota sobre limitações — precisa instituição financeira)
7. **Bancos e boletos:** referências externas (Celcoin, Gerencianet)
8. Juntando: agente ferramenta "Anakin" que responde perguntas sobre empresa brasileira
9. Rate limits e boas práticas

**CTA:**
> "No Axon, todas as APIs brasileiras estão prontas com markup de 30% — sem gerenciar chaves, sem limite de requisições da API gratuita. [Listar APIs →]"

**Clusters:**
1. "Consultando CNPJ em Python: 3 Jeitos" (recipe)
2. "Validando CEP com BrasilAPI: Tutorial Completo"
3. "Agente IA pra PME: Case de Precificação FIPE"
4. "Feriados Nacionais em Agentes: Automatizando com BrasilAPI"
5. "LGPD e Agentes de IA: O Que Você Precisa Saber" (polêmico/SEO)

---

## Pillar 8 — Agente de IA para Negócios Brasileiros: Casos de Uso Reais

**Subtítulo:** *5 aplicações funcionais, com ROI calculado, para PMEs brasileiras adotarem IA hoje.*

**Query-alvo:** `ia atendimento cliente`, `automacao ia pme`, `chatbot negocio brasileiro`, `casos de uso ia empresa`

**PORQUÊ:**
Atrai **PMs, donos de empresa, decisores** — não só devs. Público mais caro, mas 100 PMs lendo é tão valioso quanto 10.000 devs.

Não vende pra eles direto (Axon não é produto pra PM). Mas eles mandam pro time dev, que vira usuário.

**AÇÃO SUA:** esse é o pillar mais "consultivo". Cite empresas reais, cases que você conhece, clientes de possíveis. Sua voz BR + contatos.

**Outcome do leitor:**
Sair com 1-2 ideias concretas de onde aplicar IA na própria empresa dele, com ROI estimado.

**Outline:**
1. Mito: "IA é pra big tech" — desmontando
2. Framework: onde IA entrega ROI rápido em PME
3. **Caso 1:** Atendimento ao cliente 24/7 com RAG
4. **Caso 2:** Análise de contratos PDF (financeiro/jurídico)
5. **Caso 3:** Cold outreach personalizado (vendas)
6. **Caso 4:** Moderação de comunidades (Discord/Telegram)
7. **Caso 5:** Agente de precificação dinâmica (e-commerce)
8. Como começar: stack mínima
9. Armadilhas a evitar (alucinação, custo, LGPD)
10. Métricas de sucesso

**CTA (soft, consultivo):**
> "Se quer conversar sobre aplicar IA no seu negócio: [kaolinn20@gmail.com] ou leia nossos tutoriais técnicos [→]"

**Clusters:**
1. "RAG em Português: Tutorial do Zero ao Deploy"
2. "IA pra Análise de Contratos: Precisão e Custo"
3. "LGPD e IA: Checklist Compliance"
4. "Custo Mensal de IA pra PME: Quanto Esperar" (recipe com planilha)
5. "OpenAI vs Anthropic pra Português: Qual Entende Melhor?"

---

## Pillar 9 — MCP (Model Context Protocol): Complete Developer Guide

**Subtítulo:** *Everything you need to build, deploy, and use MCP servers with Claude Desktop, Cursor, Zed, and beyond.*

**Query-alvo:** `mcp tutorial`, `model context protocol`, `mcp server claude`, `cursor mcp server`

**PORQUÊ:**
MCP explodiu em 2025-2026. Volume crescendo rápido. Axon já tem servidor MCP oficial (`@axon/mcp-server`). Conversão direta.

**Outcome do leitor:**
Entender MCP, construir próprio servidor MCP, instalar em Claude Desktop/Cursor.

**Outline:**
1. Contexto: por que MCP existe (problema que resolve)
2. Protocolo MCP em 10 minutos (explicação visual)
3. Anatomia de um servidor MCP
4. **Hands-on 1:** servidor MCP que lê arquivos locais
5. **Hands-on 2:** servidor MCP que chama APIs externas
6. Instalando em Claude Desktop (config JSON)
7. Instalando em Cursor, Zed, VS Code
8. Debugging MCP (trace tools)
9. Publicando seu MCP server (npm / GitHub)
10. MCP vs Plugins vs Function Calling

**CTA:**
> "Quer MCP com 28 APIs prontas? Instala `@axon/mcp-server` e acabou. [Instruções Claude Desktop →]"

**Clusters:**
1. "MCP Server em Python: Passo a Passo"
2. "Publicando seu MCP Server no Registry"
3. "Cursor + MCP: Setup Profissional"
4. "MCP Debugging: Tools e Técnicas"
5. "Comparação: MCP vs OpenAI Functions vs Anthropic Tools"

---

## Pillar 10 — Self-Hosted vs Managed AI Gateway: Honest Comparison

**Subtítulo:** *OpenRouter, Helicone, Portkey, Axon, LiteLLM — compared fairly, with real numbers.*

**Query-alvo:** `api gateway ai`, `openrouter alternative`, `helicone vs portkey`, `ai proxy comparison`

**PORQUÊ:**
Alto intent comercial. Pessoa que busca "OpenRouter alternative" está a um passo de assinar. Polêmico (nomeia concorrentes) = atrai engajamento.

**ARMADILHA:** tem que ser **honesto** — se OpenRouter é melhor em X, dizemos que é melhor em X. Não fazemos puff piece. Senão perde credibilidade.

**Outcome do leitor:**
Saber **qual gateway escolher pro caso específico dele**. Se não for Axon, tudo bem — ele sai confiando em nós (e volta depois).

**Outline:**
1. Quando usar gateway (quando não usar)
2. Matriz de decisão: 10 critérios (latência, custo, cache, billing, privacy, etc.)
3. **Comparativo:**
   - OpenRouter: pros/cons (é forte em LLMs, fraco em cache)
   - Helicone: pros/cons (observabilidade forte)
   - Portkey: pros/cons (enterprise-focused)
   - LiteLLM: pros/cons (self-hosted campeão)
   - Axon: pros/cons (x402 + BR + prepaid)
4. **Dados reais** (latência p95, preço, features)
5. Decisão por caso de uso (startup? agência? empresa?)

**CTA:**
> "Axon é o único com pagamento prepago em USDC e APIs brasileiras. Se seu caso é esse, testa: [signup]"

**Clusters:**
1. "OpenRouter Review 2026"
2. "LiteLLM Self-Hosted: Setup e Custo Real"
3. "Helicone vs LangSmith: Observability Showdown"
4. "Por Que Usar Gateway de API (Mesmo Com 1 LLM Só)"
5. "Migration Guide: Do OpenAI Direto pro Gateway"

---

# PARTE 5 — Design & UX

## 5.1 Princípios visuais

Academy precisa **parecer parte do Axon**, não site separado. Consistência importa.

**4 princípios:**
1. **Dark-first.** Desenvolvedor passa 8h/dia no editor escuro. Site escuro é confortável.
2. **Tipografia legível.** Font grande, line-height folgado. Long-form content = ler por 10-30min sem cansar.
3. **Código em destaque.** Blocos de código são a estrela. Syntax highlight perfeito, copy button, label de linguagem.
4. **Minimalismo utilitário.** Sem carrossel, sem pop-up de newsletter, sem dark pattern. Um CTA por página.

## 5.2 Tipografia

- **Headings:** Inter, peso 700, tracking levemente apertado.
- **Body:** Inter, peso 400, tamanho 18px (grande — otimizado pra leitura).
- **Code:** JetBrains Mono, 15px.
- **Line-height:** 1.7 no body (folgado, importante pra leitura longa).
- **Max-width:** 680px no body (leitura confortável — mais largo cansa).

**PORQUÊ Inter:** é a fonte de dev content mais usada em 2026. Familiar, legível, grátis (Google Fonts). Axon landing já usa. Consistência.

**PORQUÊ JetBrains Mono:** ligaturas (→, ≠, etc.), cobertura completa de caracteres, otimizada pra código. Padrão em editores pros.

## 5.3 Sistema de cores

Paleta exata (matches landing Axon):

```
Background primary:  #0a0a0f  (quase preto, leve azulado)
Background secondary: #13131a (cards, code blocks)
Text primary:        #f0f0f5
Text secondary:      #9c9cb3
Accent (brand):      gradient #7c5cff → #5c8aff (roxo→azul)
Success:             #22c55e
Warning:             #f59e0b
Error:               #ef4444
Border:              #2a2a35
```

**DICA:** usar CSS variables pra tudo. Troca de tema futura = mudar variável.

## 5.4 Componentes necessários (MVP)

Lista mínima para o MVP funcionar:

| Componente | Pra que serve | Prioridade |
|---|---|---|
| `<Layout>` | Nav + footer + container | P0 |
| `<ArticleHeader>` | Título, subtítulo, autor, data, tempo de leitura, dificuldade | P0 |
| `<TableOfContents>` | Navegação lateral auto-gerada de H2/H3 | P0 |
| `<CodeBlock>` | Syntax highlight + copy button + label linguagem | P0 |
| `<Callout>` | Box destacado (PORQUÊ, DICA, AÇÃO, etc.) | P0 |
| `<TryOnAxon>` | CTA visual com botão, destaca $0.50 grátis | P0 |
| `<NextTutorial>` | Card no fim sugerindo próximo tutorial/trilha | P0 |
| `<Comments>` | Giscus integrado | P1 |
| `<Search>` | Pagefind modal | P1 |
| `<ProgressBar>` | Barra fina no topo mostrando % lido | P1 |
| `<RelatedArticles>` | 3 cards de conteúdo relacionado | P1 |
| `<CopyLinkButton>` | Copiar link pro heading atual | P2 |
| `<Newsletter>` | Formulário inline (sem pop-up!) | P2 |

P0 = Must-have MVP. P1 = adicionar em 2 semanas. P2 = quando sobrar tempo.

## 5.5 Layout de uma página de tutorial (wireframe textual)

```
┌─────────────────────────────────────────────────┐
│ [NAV: Axon] [API] [Docs] [Learn] [Signup]       │  Sticky
├─────────────────────────────────────────────────┤
│                                                 │
│  Breadcrumb: Learn / Tutoriais / Este Tutorial  │
│                                                 │
│  H1: Título do Tutorial                         │
│  Subtítulo descritivo                           │
│                                                 │
│  ⏱ 25 min · 🎯 Intermediário · 📅 Apr 2026     │
│                                                 │
│  ┌─── TL;DR ──────────────────────────────┐    │
│  │ Resumo em 3 bullets do que o tutorial   │    │
│  │ entrega.                                │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│  Pré-requisitos                                 │
│  - Python 3.11+                                 │
│  - Conta Axon (signup em 10s)                   │
│                                                 │
│ ┌─ TOC ──┐  Conteúdo do tutorial...            │
│ │        │                                      │
│ │ 1. Set │  [Código]                           │
│ │ 2. Ins │                                      │
│ │ 3. Exe │  Explicação...                       │
│ │ ...    │                                      │
│ │ Sticky │  [Callout PORQUÊ]                   │
│ └────────┘                                      │
│                                                 │
│  Próximos passos                                │
│  ┌─────────────────┐ ┌─────────────────┐       │
│  │ Tutorial N+1    │ │ Tutorial relat. │       │
│  └─────────────────┘ └─────────────────┘       │
│                                                 │
│  [Try it on Axon — $0.50 free]                  │
│                                                 │
│  ═══ Comments (Giscus) ═══                      │
│                                                 │
├─────────────────────────────────────────────────┤
│ Footer: links, copyright, contato               │
└─────────────────────────────────────────────────┘
```

## 5.6 Mobile-first

- Leitura em celular é >50% do tráfego em PT-BR.
- Tipografia grande, line-height folgado, padding generoso.
- TOC vira botão flutuante no mobile.
- Code blocks com scroll horizontal (nunca wrap).
- CTA sempre grudado no bottom no mobile (sticky).

---

# PARTE 6 — Stack técnica

## 6.1 Por que Astro (e não outra coisa)

Comparativo honesto dos candidatos:

| Stack | Pros | Cons | Verdict |
|---|---|---|---|
| **Astro** | Ship 0 JS, SEO perfeito, Content Collections, MDX, deploy CF Pages | Ecossistema menor que Next | ✅ **Escolhido** |
| **Next.js** | Ecossistema gigante, SSR | Overkill pra conteúdo, performance inferior sem cuidado | ❌ |
| **Hugo** | Build rápido, Go | Templates em Go (menos devs), MDX é ginástica | ❌ |
| **Docusaurus** | Ótimo pra docs | Overkill, opiniático demais | ❌ |
| **Plain HTML + MD** | Zero deps | Não escala, sem type safety, sem componentes | ❌ |

**PORQUÊ Astro vence:**
1. **Ship 0 JavaScript por padrão.** Pillar com 5000 palavras carrega em <1s. Google Lighthouse 100. SEO agradece.
2. **Content Collections:** frontmatter type-safe. Se eu esquecer o campo `difficulty`, compilação falha. Previne erros bobos.
3. **Islands:** quando precisar de interatividade (copy button, search modal), só esse componente ship JS — resto continua HTML puro.
4. **MDX:** markdown com componentes React/Vue/etc. Permite embutir `<TryOnAxon />` direto no artigo.
5. **Cloudflare Pages integration:** mesmo deploy do landing. Zero infra nova.

**TRADEOFF:** se um dia quisermos transformar Academy em app interativo (dashboard, quizzes, cursos), Astro fica no caminho. Migração pra Next seria necessária. Mas isso está longe — 1-2 anos adiante.

## 6.2 Content Collections explicadas

O recurso mais importante do Astro pra nós. Resumo:

```typescript
// src/content/config.ts
import { defineCollection, z } from 'astro:content';

const tutorials = defineCollection({
  schema: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    description: z.string().max(160),
    category: z.enum(['agents', 'apis', 'production', 'brazil', 'concepts']),
    difficulty: z.enum(['iniciante', 'intermediario', 'avancado']),
    timeMinutes: z.number(),
    author: z.string().default('Axon Team'),
    lastUpdated: z.date(),
    tags: z.array(z.string()),
    relatedTutorials: z.array(z.string()).optional(),
  }),
});

export const collections = { tutorials };
```

Traduzindo: cada tutorial `.md` TEM QUE ter esse frontmatter, com esses tipos. Se faltar `difficulty`, build falha. Isso evita inconsistência em 100 artigos.

## 6.3 MDX — markdown com superpoderes

Markdown normal não permite componente. MDX permite.

Exemplo em um tutorial:

```mdx
---
title: Primeiro Agente com APIs Brasileiras
---

# Primeiro Agente com APIs Brasileiras

Vamos construir um agente que consulta CNPJ e resume informações.

<Callout type="porque">
Usamos BrasilAPI porque é gratuita, não requer chave, e tem uptime decente.
</Callout>

## Setup

```python
pip install openai
```

<TryOnAxon apiKey="exemplo" command="curl axon.io/v1/call/brasilapi/cnpj/..." />

Continue...
```

`<Callout>` e `<TryOnAxon>` são componentes Astro renderizando dentro do markdown. O autor escreve markdown normal + tags quando precisa.

## 6.4 Pagefind — busca sem backend

Quando o site cresce pra 50+ artigos, usuário precisa buscar. Opções:

- **Algolia:** melhor mas pago ($$$ em escala)
- **Meilisearch / Typesense:** precisa servidor
- **Pagefind:** indexa na hora do build, gera arquivos estáticos, busca roda 100% no browser. **Grátis. Infra zero.**

Pagefind vence pro nosso caso. Inicializa em 100ms, busca retorna em <50ms, index ocupa ~200kb pra 50 artigos.

Setup: adicionar ao build script, pronto. Zero código.

## 6.5 Giscus — comentários via GitHub

Usuários podem comentar em cada tutorial. Comentários viram threads em **GitHub Discussions** automaticamente.

Vantagens:
- **Grátis.** Para sempre.
- **Anti-spam by design.** Precisa conta GitHub → 99% menos spam que Disqus.
- **Comunidade cresce no GitHub.** Quem comenta, dá star no repo. Star = sinal pro Google.
- **Moderação simples.** Issues/discussions são familiares.

Limitação: usuário não-dev não tem conta GitHub. Tudo bem — nosso público é dev majoritariamente.

## 6.6 Cloudflare Pages

Já usado pelo landing. Vantagens conhecidas:
- Free tier generoso (100k builds/mês, ilimitado request)
- Deploy auto via GitHub push
- CDN global (300+ POPs)
- HTTPS automático
- Headers customizáveis (`_headers` file — já temos segurança configurada)

**Zero custo adicional** para Academy. Só adicionar ao mesmo projeto ou subpath.

## 6.7 Integração com Axon — o widget `<TryOnAxon>`

Componente que aparece no fim de cada tutorial. Fluxo UX:

1. Usuário termina tutorial "Primeiro Agente BR"
2. Vê card com título "Rode isso agora no Axon"
3. Botão "Get $0.50 free" → POST `/v1/signup`
4. Modal: email, cria user, retorna API key
5. Usuário volta pra tutorial, já autenticado
6. Botão "Run" no code block manda request real pra Axon
7. Output aparece inline no browser

**Isso transforma Academy em onboarding.** Pessoa não precisa sair pra outro site. Lê → testa → vira user, tudo num fluxo.

**Tecnicamente:** usa API já existente (`POST /v1/signup`). Adiciona `localStorage` pra armazenar key. Widget verifica se tem key e muda CTA.

---

# PARTE 7 — Plano de execução

## 7.1 Semana 1 — MVP (o que eu construo assim que aprovar)

**Dia 1 (4h):** scaffold + design system
- Instalar Astro no `axon/landing/learn/` ou repo separado
- Configurar Content Collections com schemas definidos
- Copiar paleta de cores + tipografia do landing
- Componentes P0: Layout, ArticleHeader, CodeBlock, Callout, TryOnAxon

**Dia 2 (4h):** migração de conteúdo existente
- Migrar `blog/why-we-built-axon.md` → guide
- Migrar `blog/self-paying-research-agent-20-lines.md` → tutorial
- Migrar `blog/cache-hit-rates-17-apis.md` → guide
- Adicionar frontmatter conforme schema
- Gerar hub `/learn` com cards

**Dia 3 (8h):** primeiro tutorial novo — PT-BR (prioridade porque é diferencial)
- "Criando seu Primeiro Agente de IA com APIs Brasileiras"
- Código real, testado, rodando
- Screenshots do terminal
- Callouts (PORQUÊ, DICA, AÇÃO)
- CTA final

**Dia 4 (8h):** segundo tutorial novo — EN
- "Your First Self-Paying Agent in 15 Minutes"
- Código real
- Linking interno forte (pro pillar 1, quando existir)

**Dia 5 (4h):** polish + deploy
- Pagefind search integrado
- Giscus ativado
- `_headers` ajustado
- Sitemap + robots
- Deploy em `axon-5zf.pages.dev/learn`
- Teste end-to-end

**Total semana 1:** ~28h de trabalho nosso combinado.

## 7.2 Semana 2 — primeiros pillars

Meta: 2 pillars publicados. Prioridade por impacto:

1. **Pillar 6** (Como Criar Agente de IA em PT-BR) — volume alto + diferencial
2. **Pillar 1** (Self-Paying Agents with x402) — ownership absoluto

Você escreve rascunho em PT-BR (vozzy). Eu reviso/estruturo/adiciono outline técnico. Depois tradução EN do pillar 1.

Tempo estimado: 20h (10h por pillar, metade seu, metade meu).

## 7.3 Mês 1 — atingir 10 peças publicadas

Ritmo sugerido: 2-3 artigos por semana.

- 3 pillars restantes (2, 3, 7)
- 5 clusters/recipes (fáceis, 1-2h cada)
- 2 guides conceituais

Total: ~20h/semana nas semanas 3-4.

**AÇÃO SUA:** ao fim do mês 1, você deve ter escrito (ou co-escrito) pelo menos 3 artigos em PT-BR. Sem isso, Academy não é "sua" — fica parecendo conteúdo importado.

## 7.4 Mês 2-3 — escala + newsletter

- Publicar pillars restantes (4, 5, 8, 9, 10)
- Lançar newsletter "Axon Weekly" (setup Buttondown ou similar, $0-9/mês)
- 4-8 recipes/semana (são rápidos)
- Começar a medir: quais pillars rankearam? Double-down nos vencedores.

## 7.5 Mês 4-6 — SEO tracking + ajustes

- Instalar Google Search Console (grátis)
- Ver quais queries trazem tráfego
- Atualizar artigos que estão na 2ª página pra empurrar pra 1ª
- Começar a receber primeiros backlinks espontâneos
- (Opcional) Postar conteúdo reescalado no Dev.to e Hashnode

---

# PARTE 8 — Community & Marketing

## 8.1 Como comentários viram comunidade

Giscus cria discussão em cada tutorial. Moderação leve + engajamento genuíno = comunidade orgânica.

Regra de ouro: **responda TODOS os comentários** no primeiro ano. Em 6 meses, primeiros usuários vão responder uns aos outros — aí é comunidade.

**AÇÃO SUA:** vai ser o rosto. Responda em PT-BR com sua voz. Eu posso sugerir respostas técnicas mas a personalidade tem que ser sua.

## 8.2 Newsletter "Axon Weekly"

Formato tight (pra respeitar o tempo do leitor):

- **1 tutorial novo da semana** (link + 1 parágrafo)
- **3 links externos interessantes** (papers, tools, threads Twitter)
- **1 métrica pública Axon** (cache hit rate da semana, latência, etc.)
- **1 chamada pra comunidade** (pergunta pro leitor responder)

Duração total: 3 minutos de leitura. Frequência: semanal, quarta ou quinta.

Ferramenta: **Buttondown** ($9/mês quando ultrapassar free tier). Alternativa grátis: **Substack** (mas pega 10% de pagamentos se você monetizar).

## 8.3 "Submit a Tutorial" — crescimento colaborativo

Página dedicada convidando leitores a contribuir. Aceitos:
- Tutoriais novos (com PR no GitHub)
- Traduções de tutoriais existentes
- Recipes

Recompensas:
- Nome na byline + link pro site do autor
- $20 em créditos Axon por tutorial aceito (incentivo pequeno mas simbólico)
- Compartilhamento no Twitter @axondevia

Aceitar 1 por mês = 12 contribuidores/ano = 12 pessoas que são **tanto autores quanto evangelistas** da marca.

## 8.4 Cross-pollination — levando conteúdo pra plataformas

Cada pillar e tutorial deve virar:

- **Thread Twitter** (extrair 10 insights → thread)
- **Post Dev.to + Hashnode** (republica, canonical tag apontando pro seu site)
- **LinkedIn long-form** (para pillar 8 especialmente — PMEs estão no LinkedIn)
- **Reddit post em subreddits relevantes** (r/LocalLLaMA, r/AIAgents, r/brdev) — **sem linkar direto**, só adicionar valor. Linka no perfil.

**ARMADILHA:** fazer tudo isso pra cada artigo é impossível. Seleção:
- Pillar: tudo (thread + dev.to + linkedin)
- Tutorial: thread + dev.to
- Recipe: thread curta
- Guide: dev.to
- Glossary: nada

## 8.5 Showcase — "Agent of the Week"

Toda semana, destacar 1 projeto real construído com Axon. Formato:

- Nome + link + autor
- 1 parágrafo explicando o que faz
- 1 snippet de código

Postado em: newsletter + Twitter + página dedicada `/learn/showcase`.

**PORQUÊ funciona:**
- Autor vira embaixador (compartilha aonde foi destacado).
- Outros veem "gente real está construindo" → animam a tentar.
- Social proof gratuito.

Começa quando tivermos pelo menos 3 usuários reais com projetos. Antes disso, destaca projetos-exemplo nossos (starter templates do repo).

---

# PARTE 9 — Métricas & KPIs

## 9.1 Como medir sucesso (por fase)

### Fase 1 (Mês 1-2) — Publicação
- **Artigos publicados:** meta 10
- **Artigos de você (user):** meta 3
- **Comentários:** meta 10 (não nos nossos — qualquer coisa conta)
- **Email list:** meta 50 subscritos

### Fase 2 (Mês 3-4) — Tracking inicial
- **Tráfego orgânico Google:** meta 500/mês
- **Tutorial completion rate** (usando scroll depth): meta 60%
- **Signup via Academy:** meta 10/mês
- **Backlinks:** meta 3 (orgânicos)

### Fase 3 (Mês 5-6) — Conversão
- **Tráfego orgânico:** meta 3.000/mês
- **Signup → uso real (>1 API call):** meta 30%
- **Newsletter open rate:** meta 45% (indústria: 20-25%)
- **Agent of the Week showcases:** 20+ usuários destacáveis

### Fase 4 (Mês 7-12) — Compostagem
- **Tráfego orgânico:** 10.000/mês+
- **Paying users originados da Academy:** meta 10+
- **Newsletter:** 1.000+ subscritos
- **Referrals orgânicos** (GitHub stars, menções, etc.)

## 9.2 Vanity metrics vs metrics reais

Vanity (NÃO obsesse):
- Número de stars GitHub
- Número de tweets com like
- Número de visualizações de página

Real (obsesse):
- **Signup vindo da Academy** (attribution via UTM ou entrada direta)
- **Retention 7d dos signups** (voltaram?)
- **Depósito real USDC** pós-signup (único KPI que paga as contas)

## 9.3 Funil Academy → Signup → Paid User

```
100.000 leitores orgânicos de um artigo em 12 meses
  ↓ 5% clicam CTA
5.000 cliques no "Try on Axon"
  ↓ 20% completam signup
1.000 signups
  ↓ 30% fazem 1ª call real
300 usuários ativos
  ↓ 15% depositam USDC
45 paying users
```

**Esse funil depende de cada etapa ser boa.** Se conversion do CTA for 1% em vez de 5%, o número final cai 5x. Por isso A/B test de CTA importa depois que temos tráfego.

Neste plano, cada pillar é um funil independente. Multiplicar por 10 pillars + 40 tutoriais + 50 recipes.

## 9.4 Ferramentas grátis de tracking

1. **Google Search Console** — quais queries levam ao site, CTR, posição média. Essencial, grátis.
2. **Cloudflare Web Analytics** — já instalado. Sem cookies, GDPR-friendly.
3. **Plausible (pago $9/mês) ou Umami (self-hosted grátis)** — se quiser analytics mais detalhado.
4. **UTM tags em CTAs** — saber de qual artigo veio o signup.
5. **Attribute signup to source** — já implementado no backend Axon (coluna `signup_source`).

---

# PARTE 10 — Como você contribui

Essa é a parte que você pediu ênfase: **o que VOCÊ faz, o que EU faço, e o que fazemos juntos**.

## 10.1 O que só VOCÊ pode fazer (crítico)

1. **Voz brasileira autêntica.** Eu escrevo PT-BR técnico correto, mas soa "traduzido". Você reescreve a versão final pra soar natural BR (gírias, referências, expressões "de dev brasileiro").

2. **Cases reais e contatos.** Pro pillar 8 (PMEs brasileiras), você vai citar exemplos e idealmente conversar com 2-3 donos de PME pra validar casos de uso. Eu não tenho essas conexões.

3. **Decisões estratégicas de prioridade.** Quando chegarmos em bifurcações ("fazer pillar 3 ou pillar 5 primeiro?"), você decide baseado em sinais de mercado que eu não vejo.

4. **Interação em comunidade.** Twitter, Telegram, Discord — a marca é você. Eu posso redigir, mas você posta.

5. **Compra de domínio, decisões de investimento** (caso seja preciso ferramenta paga).

## 10.2 O que EU faço sozinho (delegar com confiança)

1. Scaffold técnico (Astro, Content Collections, componentes)
2. Pesquisa de keywords (ferramentas grátis: Ubersuggest, AnswerThePublic)
3. Outline de artigos (estrutura H2/H3)
4. Primeira versão (draft 1) de tutoriais técnicos
5. Code review dos snippets (garantir que rodam)
6. Setup de tooling (Pagefind, Giscus, newsletter)
7. Migração dos 3 blogs existentes
8. Deploy + DevOps

## 10.3 Conteúdo que VOCÊ deveria escrever (priorizado)

Não é pra você escrever TUDO. Mas deveria escrever (ou reescrever com sua voz):

| Artigo | Por quê é você | Tempo |
|---|---|---|
| Pillar 6 (Como Criar Agente em PT-BR) | Voz BR crítica | 6h |
| Pillar 7 (APIs Brasileiras) | Você entende dor do dev BR | 4h |
| Pillar 8 (IA pra Negócios BR) | Você tem contatos + visão | 6h |
| "Por que fundei o Axon" (guide pessoal) | Só você pode escrever | 2h |
| Agent of the Week posts (quando tivermos users) | Relação humana | 30min/semana |

Total da sua escrita: ~20h no mês 1. Pouco pra alto impacto.

## 10.4 Rotina semanal sugerida

Segunda: 2h escrevendo ou revisando 1 artigo
Terça-Quarta: foco em código/produto Axon (não Academy)
Quinta: 1h revisando pull request meu de novo artigo
Sexta: 30min publicando newsletter + responde comentários

**Total:** ~4h/semana de você na Academy. Sustentável sem atrapalhar produto.

## 10.5 Ferramentas pra você usar

- **VS Code + extensão MDX** (preview ao vivo)
- **Obsidian** (opcional) — rascunhos, ideias, vault de conhecimento
- **Grammarly Free** — revisão leve em inglês
- **LanguageTool** — revisão em PT-BR
- **Canva** — imagens de capa de artigo (templates grátis)
- **Tally Forms** — formulário de "Submit a Tutorial" (grátis)
- **Buttondown** ($0-9/mês) — newsletter

**NÃO precisa de:** Figma, Notion pago, Ahrefs, SEMrush. Tudo aqui é $0-$30/mês total.

---

# PARTE 11 — Decisões pendentes

As 5 decisões que preciso sua resposta antes de começar a construir o MVP (Parte 7.1):

### Decisão 1: URL

- **Opção A:** `axon-5zf.pages.dev/learn` (mesmo domínio — simples, imediato)
- **Opção B:** `learn.axon.dev` (subdomínio — aguarda compra de domínio)

**Minha recomendação:** **Opção A agora.** Migra pra B quando comprar `axon.dev` (ou similar).

---

### Decisão 2: Idiomas no MVP

- **Opção A:** PT-BR + EN dos 2 tutoriais iniciais (mais trabalho, aproveita os 2 nichos)
- **Opção B:** Só PT-BR no começo (diferencial BR puro, mais foco)
- **Opção C:** Só EN (mercado global, volume maior)

**Minha recomendação:** **Opção A.** Um tutorial em cada idioma (o BR em PT-BR, o x402 em EN, por exemplo). Testa os dois nichos e vê qual responde mais rápido.

---

### Decisão 3: Estrutura de repo

- **Opção A:** Monorepo dentro de `axon/landing/learn/` (simples, deploy junto)
- **Opção B:** Repo separado `axondevi/academy` (independente, mas duplica infra)

**Minha recomendação:** **Opção A.** Só separa se Academy crescer muito ou se quisermos open-sourcing de tutoriais via PR.

---

### Decisão 4: Giscus desde o MVP?

- **Opção A:** Sim, desde o dia 1 (cria cultura de comunidade)
- **Opção B:** Não, só depois de 10 artigos (evita parecer vazio no início)

**Minha recomendação:** **Opção A.** Comentário vazio não é problema. Artigo sem caixa de comentário parece amadador.

---

### Decisão 5: Quais dos 10 pillars manter/cortar/adicionar?

Lista atual:
1. Self-Paying Agents (x402)
2. Complete Guide to Agent APIs
3. Production Agents (LangChain, CrewAI, Vercel AI SDK)
4. Cost Optimization
5. State of AI Agent Infra 2026
6. Como Criar Agente em PT-BR
7. APIs Brasileiras em IA
8. IA pra Negócios BR
9. MCP Developer Guide
10. Gateway Comparison

**Pergunta:** algum você quer trocar ou adicionar algo que sentiu falta?

---

# PARTE 12 — Apêndices

## Apêndice A — Glossário mínimo

| Termo | Definição |
|---|---|
| **SEO** | Search Engine Optimization. Técnicas pra aparecer no Google organicamente. |
| **Pillar content** | Artigo grande que cobre tema amplo e liga a vários outros menores. |
| **Cluster content** | Artigos menores que aprofundam sub-temas do pillar. |
| **Long-tail keyword** | Busca específica com volume baixo mas alta intenção. |
| **Head term** | Busca ampla, alto volume, difícil ranquear. |
| **Intent** | O que a pessoa quer quando busca algo. |
| **CTR** | Click-Through Rate — % de quem viu e clicou. |
| **Backlink** | Link de outro site pro seu. Sinal de autoridade. |
| **Canonical** | Tag HTML que indica "a versão oficial deste conteúdo é aquela URL". Usado em republicação. |
| **x402** | Protocolo HTTP 402 ressuscitado pela Coinbase para pagamentos automáticos. |
| **MCP** | Model Context Protocol — padrão Anthropic para integrar ferramentas com LLMs. |
| **Static Site Generator** | Ferramenta que compila HTML/CSS/JS na hora de build (não no servidor). Ex: Astro, Hugo. |
| **MDX** | Markdown + JSX. Markdown com componentes. |
| **Content Collection** | Feature Astro que tipa frontmatter de markdown. |
| **Lighthouse Score** | Métrica Google de performance + SEO + acessibilidade. |

## Apêndice B — Links e ferramentas

**Pesquisa de keywords:**
- [Ubersuggest](https://neilpatel.com/ubersuggest/) — grátis limitado
- [AnswerThePublic](https://answerthepublic.com/) — perguntas reais
- Google "people also ask" — direto na SERP

**Escrita:**
- [Grammarly](https://grammarly.com) — EN
- [LanguageTool](https://languagetool.org/) — PT-BR + EN

**Design de capa:**
- [Canva](https://canva.com) — templates grátis
- [Unsplash](https://unsplash.com) — imagens grátis

**Analytics:**
- [Google Search Console](https://search.google.com/search-console) — essencial, grátis
- [Plausible](https://plausible.io) — $9/mês, privacy-friendly

**Newsletter:**
- [Buttondown](https://buttondown.com) — $0-9/mês
- [Substack](https://substack.com) — grátis mas toma 10% de pagamentos

**Comunidade:**
- [Discord](https://discord.com) — comunidade dev
- [Telegram](https://telegram.org) — BR prefere

## Apêndice C — Template inicial de tutorial

```mdx
---
title: Título Claro e Específico
subtitle: Linha que explica valor em 10 palavras
description: Meta description (até 160 chars — aparece no Google)
category: agents
difficulty: intermediario
timeMinutes: 25
author: Seu Nome
lastUpdated: 2026-04-24
tags: [langchain, brasilapi, python]
relatedTutorials:
  - tutorial-slug-1
  - tutorial-slug-2
---

import { Callout } from '@/components/Callout';
import { TryOnAxon } from '@/components/TryOnAxon';

## TL;DR

Em 3 bullets, o que este tutorial entrega:

- Bullet 1
- Bullet 2
- Bullet 3

## Pré-requisitos

- Python 3.11+
- Conta Axon (10s)
- Básico de async/await

## Setup

[Código e explicação]

<Callout type="porque">
Explicação do "porquê" dessa decisão específica.
</Callout>

## Passo 1 — Nome

...

## Passo 2 — Nome

...

## Próximos passos

- [Link pro tutorial N+1]
- [Link pro pillar relacionado]

<TryOnAxon />
```

## Apêndice D — Checklist de publicação

Antes de publicar qualquer artigo, conferir:

- [ ] Título começa com verbo ou "Como/How"
- [ ] Meta description <160 chars, inclui keyword
- [ ] TL;DR no topo
- [ ] Pré-requisitos listados
- [ ] Código testado (rodou na sua máquina?)
- [ ] Links internos (pelo menos 2 pra outros artigos)
- [ ] CTA `<TryOnAxon />` no fim
- [ ] Imagem de capa (mínimo 1200x630 pra OG)
- [ ] Alt text em imagens
- [ ] Tags definidas
- [ ] `relatedTutorials` preenchido
- [ ] Preview mobile
- [ ] Lighthouse >90
- [ ] Grammarly/LanguageTool sem erros

## Apêndice E — Próximos passos imediatos

1. **Você lê este documento** (~2h se leitura cuidadosa)
2. **Responde as 5 decisões da Parte 11** (mesmo que só "aprovado, siga minhas recomendações")
3. **Eu começo a construir MVP** (28h de trabalho, ~3-5 dias corridos)
4. **Você escreve seu primeiro artigo** (pillar 6 ou guide pessoal "Por que fundei Axon")
5. **Publicamos juntos** e compartilhamos no Twitter

Esse é o caminho. Zero ambiguidade.

---

## Fechamento

Academy não é "blog bonitinho pra ter". É **estratégia de crescimento** com alinhamento exato a três nichos defensáveis (x402, BR, produção real de agentes).

Executada com disciplina, em 12 meses:
- 10.000+ visitantes orgânicos/mês
- 100+ paying users originados da Academy
- Posição de autoridade em "agentes IA PT-BR" que ninguém replica fácil
- Backlog de conteúdo que continua gerando valor por anos

Se parar no mês 2, foi perda de tempo. Se seguir com disciplina de 4h/semana suas + ~10h/semana minhas, é moat real.

**Pronto pra começar?**

---

*Documento v1.0 — Axon Academy — 24 de abril de 2026*
*Alinhado com plano de 14 dias de lançamento + estratégia longo prazo do Axon*
