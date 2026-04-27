# Video Hero 90s — Roteiro + Storyboard + Producao

> Video de demonstracao da landing principal (axon-5zf.pages.dev).
> Objetivo: leigo (lojista, dentista, advogado) entende em 90s O QUE e Axon e
> sente que pode usar AGORA, sem skill tecnico.

## Especificacoes tecnicas

| Item | Valor |
|---|---|
| Duracao alvo | **75-90 segundos** |
| Resolucao | 1920x1080 (16:9) |
| FPS | 30 |
| Formato final | MP4 (H.264) + WebM (VP9) pra fallback |
| Audio | Narracao PT-BR + musica leve (royalty-free) |
| Captions | Embedded + arquivo .vtt separado |
| Tamanho alvo | <10 MB pra carregamento rapido |
| Hosting | Cloudflare Stream OU YouTube embed sem ads |
| Formato extra | Versao quadrada 1080x1080 pra Instagram/Reels |

## Estrutura de cenas (storyboard verbal)

### CENA 1 — Hook (0-8s) — Problema do leigo

**Visual**: Tela dividida ao meio.
- Esquerda: lojista frustrada olhando celular as 23h, varias mensagens nao respondidas no WhatsApp da loja
- Direita: clientes desistindo da compra, fechando carrinho

**Texto na tela**: "Cliente perguntou. Voce nao respondeu. Cliente foi embora."

**Narracao**: "Toda noite voce perde clientes que perguntaram e ninguem respondeu."

**Som**: Notification sound suave + suspiro

---

### CENA 2 — Solucao em 1 frase (8-15s) — A promessa

**Visual**: Tela limpa, fundo escuro elegante (cor da marca: roxo/azul).
Aparece grande no centro:

```
Crie um agente que atende
seus clientes 24h.
Em 5 minutos. Sem codigo.
```

**Narracao**: "Com Axon, voce cria um atendente virtual em 5 minutos. Sem codigo. Funciona no WhatsApp."

**Som**: Whoosh suave + musica entra crescendo

---

### CENA 3 — Demo da landing (15-30s) — Prova visual

**Visual**: Screen recording da landing axon-5zf.pages.dev:
- Mouse move organico
- Scroll suave ate a secao "Pra negocios brasileiros"
- 3 cards aparecem: Clinica / Restaurante / Loja
- Mouse hover em "Loja" → card destacado
- Click em "Pra lojas online"

**Texto sobreposto**: "Escolha seu segmento"

**Narracao**: "Escolha o template do seu segmento — clinica, restaurante, loja, ou outros 7."

---

### CENA 4 — Builder em acao (30-50s) — Magia em real-time

**Visual**: Screen recording de /build:
- Card "Atendente E-commerce BR" pre-selecionado
- Click "Use this template"
- Builder abre, campos pre-preenchidos
- Cursor edita campo "Nome": "Loja Maria Silva"
- Cursor edita campo "Endereco": "Rua das Flores 123, Sao Paulo"
- Preview ao vivo na DIREITA atualiza em tempo real
- Aparece chat de exemplo: cliente pergunta "Calcula frete pra CEP 01310-100" e agente responde

**Texto sobreposto**: "Personalize. Veja ao vivo."

**Narracao**: "Personalize com os dados do seu negocio. O preview ao lado mostra como vai ficar — em tempo real."

---

### CENA 5 — Publicacao + 4 canais (50-65s) — Distribuicao

**Visual**:
- Click "Save agent"
- Modal "Teste Agora" aparece com 4 canais:
  - 🌐 Web URL (mouse copia)
  - 📋 Embed code (mouse copia)
  - 🔌 cURL (mouse copia)
  - 📱 WhatsApp (mouse hover)
- Cuts rapidos:
  - WhatsApp aberto, agente respondendo cliente real
  - Embed widget no canto de um site Shopify, alguem clica e conversa
  - Web URL aberta em outra aba, alguem testa

**Texto sobreposto**: "1 agente. 4 canais. 1 clique pra cada."

**Narracao**: "Em um clique, seu agente esta no WhatsApp, embedado no seu site, ou via API. Voce escolhe."

---

### CENA 6 — Pricing + CTA (65-80s) — Conversao

**Visual**: Tela escura, aparece em destaque:

```
A partir de R$ 199/mes
Cancele quando quiser.

[ Comecar gratis - R$5 de credito ]
```

Botao pulsa suave.

**Narracao**: "A partir de R$199 por mes. Cancele quando quiser. R$5 de credito gratis pra testar — sem cartao."

---

### CENA 7 — URL + outro (80-90s) — Memorability

**Visual**: Logo Axon grande no centro. Embaixo:

```
axon.dev
ou
axon-5zf.pages.dev
```

(Use o dominio definitivo se ja tiver)

**Narracao**: "Acesse axon.dev. Crie seu agente agora."

**Fim**: Fade out com musica.

---

## Roteiro narracao completo (para gravacao)

> Toda noite voce perde clientes que perguntaram e ninguem respondeu.
>
> Com Axon, voce cria um atendente virtual em 5 minutos. Sem codigo. Funciona no WhatsApp.
>
> Escolha o template do seu segmento — clinica, restaurante, loja, ou outros 7.
>
> Personalize com os dados do seu negocio. O preview ao lado mostra como vai ficar — em tempo real.
>
> Em um clique, seu agente esta no WhatsApp, embedado no seu site, ou via API. Voce escolhe.
>
> A partir de R$199 por mes. Cancele quando quiser. R$5 de credito gratis pra testar — sem cartao.
>
> Acesse axon.dev. Crie seu agente agora.

**Total**: ~140 palavras = ~75-85 segundos em ritmo natural BR.

---

## Captions (.vtt) — sincronizado

```vtt
WEBVTT

00:00:00.000 --> 00:00:08.000
Toda noite voce perde clientes
que perguntaram e ninguem respondeu.

00:00:08.000 --> 00:00:15.000
Com Axon, voce cria um atendente virtual
em 5 minutos. Sem codigo. Funciona no WhatsApp.

00:00:15.000 --> 00:00:30.000
Escolha o template do seu segmento — clinica,
restaurante, loja, ou outros 7.

00:00:30.000 --> 00:00:50.000
Personalize com os dados do seu negocio.
O preview ao lado mostra como vai ficar — em tempo real.

00:00:50.000 --> 00:01:05.000
Em um clique, seu agente esta no WhatsApp,
embedado no seu site, ou via API. Voce escolhe.

00:01:05.000 --> 00:01:20.000
A partir de R$199 por mes. Cancele quando quiser.
R$5 de credito gratis pra testar — sem cartao.

00:01:20.000 --> 00:01:30.000
Acesse axon.dev. Crie seu agente agora.
```

---

## Lista de assets a preparar ANTES da gravacao

- [ ] Logo Axon em SVG (alta qualidade)
- [ ] Cor primaria oficial: #7c5cff (roxo da marca)
- [ ] Cor secundaria: #00c8ff (azul)
- [ ] Mockup de WhatsApp recebendo mensagem de cliente
- [ ] Mockup de loja Shopify com embed widget
- [ ] Cursor animado (After Effects ou Screen Studio)
- [ ] Conta de teste no Axon JA configurada com agente "Loja Maria Silva"
- [ ] Musica royalty-free (sugestao: Epidemic Sound, Artlist, ou YouTube Audio Library — buscar "tech minimal", "modern uplifting", duracao 90s)

---

## Ferramentas sugeridas (gratis ou baratas)

| Tarefa | Ferramenta | Custo |
|---|---|---|
| Screen recording | **Screen Studio (Mac)** ou **OBS** | $89 / Free |
| Edicao | **DaVinci Resolve** (free) ou **CapCut** | Free |
| Mocions/animacoes | **CapCut** ou **Canva** | Free |
| Voiceover | **Voce mesmo** (mais autentico) ou **ElevenLabs** | $0 / $5/mes |
| Musica | **Epidemic Sound** (trial 30 dias) ou **YouTube Audio Lib** | $0 |
| Captions | **Whisper** (open source) ou **Descript** | Free / $15/mes |
| Compressao final | **HandBrake** | Free |

**Setup mais barato**: OBS + DaVinci + Whisper + YouTube Audio = total $0.

---

## Onde colocar o video depois de pronto

1. **Landing principal** (axon-5zf.pages.dev): substituir o code-card no hero por player de video. Manter o code-card como fallback embaixo do video pra devs.

2. **Landings verticalizadas** (/clinica, /restaurante, /loja): video adaptado mostrando aquele segmento especifico (10s extras editando o template alvo).

3. **YouTube + Vimeo**: hospede em ambos. Use Vimeo pra qualidade premium (pago) ou YouTube pra discovery.

4. **Twitter/X + LinkedIn**: corte versoes de 30s pra anuncios. Otimo pra retargeting.

5. **Instagram/TikTok**: versao quadrada (1080x1080) sem audio essencial, com captions grandes.

---

## Snippet HTML pra embedar (na landing principal)

```html
<!-- substitui o code-card atual -->
<div class="hero-video" style="margin-top: 32px;">
  <video
    autoplay muted loop playsinline
    poster="/og-image.svg"
    style="width: 100%; max-width: 720px; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.4);">
    <source src="/hero.mp4" type="video/mp4">
    <source src="/hero.webm" type="video/webm">
  </video>
  <button onclick="this.previousElementSibling.muted=!this.previousElementSibling.muted; this.textContent=this.previousElementSibling.muted?'🔇 Tocar com som':'🔊 Mutar';"
          style="margin-top: 12px; background: rgba(255,255,255,0.06); border: 1px solid var(--border); color: var(--text); padding: 8px 16px; border-radius: 6px; font-size: 13px; cursor: pointer;">
    🔇 Tocar com som
  </button>
</div>
```

---

## Checklist de producao

### Pre-producao (1 dia)
- [ ] Definir paleta de cores e estilo visual
- [ ] Criar conta Axon de demo + agente "Loja Maria Silva" pre-configurado
- [ ] Escolher musica royalty-free
- [ ] Imprimir/abrir roteiro pra ler durante gravacao
- [ ] Testar microfone (USB ou celular com fone)

### Gravacao (2-3 horas)
- [ ] Gravar narracao em ambiente silencioso (3-4 takes pra ter opcoes)
- [ ] Screen recording cena por cena (refazer ate ficar limpo)
- [ ] B-roll: WhatsApp real, mockup site
- [ ] Salvar tudo em pasta `/raw/` com nome claro

### Pos-producao (3-5 horas)
- [ ] Edicao no DaVinci/CapCut
- [ ] Sync narracao + visual
- [ ] Adicionar captions
- [ ] Color grading basico
- [ ] Mix de audio (musica baixa, narracao alta)
- [ ] Export 1080p MP4
- [ ] Compressao via HandBrake (alvo <10MB)
- [ ] Versao quadrada 1080x1080 pra Insta

### Deploy
- [ ] Upload `/landing/hero.mp4` e `/landing/hero.webm`
- [ ] Editar landing/index.html: substituir code-card por video
- [ ] Editar 3 landings verticais (versao adaptada por segmento)
- [ ] Commit + push (auto-deploy)
- [ ] Testar em mobile + desktop
- [ ] Compartilhar nas redes

---

## Variantes do video (depois do v1)

- **30s ad version**: cenas 1, 2, 4, 7 — cortado seco pra Instagram/Twitter
- **15s teaser**: cenas 2 e 7 apenas — pra trailer de email
- **Por segmento**: 3 versoes (clinica, restaurante, loja) com mockups especificos
- **Versao tecnica**: 60s com cuts de codigo, API calls, integracao — pra dev marketing

---

## Metricas a acompanhar pos-launch

- **Watch time medio**: alvo >50% (>=45s)
- **Conversao landing**: cadastros antes vs depois do video — alvo +30%
- **Click no CTA**: % de viewers que clicam em "Comecar gratis"
- **Compartilhamentos**: viralidade organica
- **Bounce rate**: deve cair quando video aparecer
