---
title: Chamar OpenAI via Nexus Inovation (em 5 linhas)
description: Trocar OpenAI direto pelo Nexus Inovation é 1 linha. Mesma interface, cache automático, billing em USDC.
lang: pt-BR
stack: [typescript, openai, axon]
publishedAt: 2026-04-24
tags: [openai, setup, quick-start]
---

# Chamar OpenAI via Nexus Inovation (em 5 linhas)

Você já usa OpenAI SDK. Pra rodar via Nexus Inovation (com cache automático + billing USDC), é **uma linha**:

```ts
import { OpenAI } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.AXON_KEY,
  baseURL: 'https://axon-kedb.onrender.com/v1/proxy/openai',
});

const { choices } = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Oi' }],
});
```

Pronto. Zero código novo. A cada chamada, Nexus Inovation:

- **Debita USDC** da sua wallet (você fica com 28+ APIs disponíveis)
- **Cacheia** se `temperature: 0` e mesma mensagem (50% desconto)
- **Refunda** se upstream der erro
- **Retorna header** `x-axon-cost-usdc` com o custo real

## Python equivalente

```python
from openai import OpenAI

client = OpenAI(
    api_key=os.getenv("AXON_KEY"),
    base_url="https://axon-kedb.onrender.com/v1/proxy/openai",
)
```

## Por que não chamar OpenAI direto?

- Nexus Inovation adiciona **cache** (você economiza 15-40% em média)
- Nexus Inovation adiciona **retry com fallback** (se OpenAI cair, pula pra Anthropic automaticamente — opt-in)
- Nexus Inovation adiciona **policies** (limite diário, limite por request)
- Nexus Inovation expõe **métricas** (custo real, latência p95, cache hit rate)

Em produção, essas coisas economizam tempo e dinheiro real.
