#!/usr/bin/env python3
"""
Generate standalone niche landing pages (clinica.html, restaurante.html, loja.html).

Why not keep niche.html + JS-rendered content?
  - Crawlers / social link previews / bookmark titles all see the static
    HTML, which was just "Carregando..." + an empty <main>. SEO and link
    previews on WhatsApp/X/LinkedIn looked broken.
  - First paint on slow connections also showed the loading state until JS
    booted, which the operator audit flagged as a P0 funnel-killer.

Now: 3 standalone files with full content baked in. Source of truth for the
niche config is still defined here (mirroring niche.html), so adding/editing
a niche = re-run this script + commit the regenerated files.

Output dir: landing/{clinica,restaurante,loja}.html
"""
from html import escape


def img(photo_id: str, w: int = 400, h: int = 240) -> str:
    return f"https://images.unsplash.com/photo-{photo_id}?auto=format&fit=crop&w={w}&h={h}&q=80"


# Mirrors landing/niche.html NICHES const. Keep in sync if either file changes.
NICHES = {
    "clinica": {
        "color": "#06b6d4",
        "shadow": "rgba(6, 182, 212, 0.35)",
        "image": img("1576091160550-2173dba999ef", 800, 480),
        "title": "Recepcionista virtual 24h pra sua clínica",
        "metaDesc": "Agende consultas, responda dúvidas e atenda pacientes no WhatsApp 24h por dia. R$249/mês.",
        "h1Pre": "Sua clínica atendendo",
        "h1Accent": "no WhatsApp 24h por dia",
        "subhead": "Agenda consultas, responde valores, identifica urgências. Sem contratar mais ninguém. Pronto em 5 minutos, configurado pelo dono — sem precisar de TI.",
        "template": "recepcionista-clinica-br",
        "demoSlug": "demo-recepcionista-clinica-br",
        "trust": ["✓ Português brasileiro nativo", "✓ Reconhece urgências", "✓ Funciona no WhatsApp"],
        "featuresTitle": "O que sua recepcionista virtual sabe fazer",
        "features": [
            (img("1506784983877-45594efa4cbe"), "Agenda consultas", "Anota nome, telefone, especialidade desejada, melhor horário. Confirma feriados antes de agendar — não te dá dor de cabeça com furo de agenda."),
            (img("1554224155-6726b3ff858f"),    "Responde valores", "Você cadastra os preços de cada especialidade uma vez, ela responde 24h. Pessoa não precisa esperar até segunda pra saber se cabe no bolso."),
            (img("1532938911079-1b06ac7ceec7"), "Identifica urgências", "Reconhece sintomas graves (febre alta, sangramento, dor forte) e orienta buscar pronto-socorro imediatamente. Treinada pra nunca dar diagnóstico."),
            (img("1524661135-423995f22d0b"),    "Endereço e horários", "Manda o endereço da clínica, horário de funcionamento, formas de pagamento, convênios aceitos. Tudo configurável pelo dono."),
            (img("1501139083538-0139583c060f"), "Funciona 24h", "Madrugada, fim de semana, feriado. Pessoa que precisa marcar consulta às 23h não desiste — é atendida na hora e fica como lead pra você confirmar de manhã."),
            (img("1556761175-5973dc0f32e7"),    "Português brasileiro real", "Tom acolhedor, calmo, profissional. Não soa robótica. Pessoa não percebe que é IA até você contar — e mesmo assim, prefere o atendimento ágil."),
        ],
        "steps": [
            ("Crie conta grátis", "Cadastra com email. R$5 de crédito grátis pra testar — não precisa cartão."),
            ('Escolha o template "Clínica"', "Já vem com prompt pronto, ferramentas configuradas, comportamento ajustado. Você só edita os dados específicos da sua clínica."),
            ("Personalize em 5 minutos", "Nome da clínica, especialidades, valores, horários, endereço, convênios. Tudo em campos simples — sem código."),
            ("Conecte ao WhatsApp", "Use o número da clínica. Ela passa a atender automaticamente toda mensagem que chega."),
            ("Acompanhe no dashboard", "Cada conversa é registrada. Você vê quem agendou, quem perguntou valor, quem foi orientado a procurar emergência."),
        ],
        "price": "R$ 249",
        "priceItems": [
            "Atendimento ilimitado 24h no WhatsApp",
            "Web link próprio (compartilhe em qualquer rede)",
            "Embed pro site da clínica",
            "Histórico completo de conversas",
            "Suporte e atualizações",
            "Cancele quando quiser, sem multa",
        ],
        "faq": [
            ("Ela substitui minha recepcionista humana?", 'Não. Ela atende o "primeiro contato" — perguntas frequentes, agendamentos básicos, triagem de urgências. Sua recepcionista humana foca no que é importante: confirmar agendamentos, organizar agenda, atender presencialmente.'),
            ("E se ela errar uma informação médica?", "Ela é treinada pra NUNCA diagnosticar ou prescrever. Se a pessoa descreve sintomas, ela orienta buscar atendimento. Você define o limite no prompt — pode ser ainda mais conservador se quiser."),
            ("Quanto tempo demora pra configurar?", "5 a 10 minutos pra primeira versão. Depois você ajusta conforme percebe o que pacientes mais perguntam. A maioria dos donos termina o setup completo em 1 hora total."),
            ("Funciona em outras línguas?", "Sim. O template padrão é PT-BR. Pra atender em inglês ou espanhol, basta ajustar o prompt — leva 30 segundos."),
            ("E o WhatsApp Business? Preciso de algum?", "Recomendamos. A integração é via Evolution API (incluída no Nexus Inovation). Vamos te guiar no dashboard — leva 2 minutos."),
            ("Meus dados ficam seguros?", "Sim. Conformidade LGPD. Conversas armazenadas só pra você acessar — ninguém mais tem acesso. Pode exportar/deletar quando quiser."),
            ("E se eu quiser cancelar?", "Cancela direto no dashboard, sem ligação, sem multa. Você mantém os dados das conversas exportáveis até o fim do ciclo pago."),
        ],
        "footer": "Recepcionista virtual pra clínicas brasileiras.",
    },

    "restaurante": {
        "color": "#f97316",
        "shadow": "rgba(249, 115, 22, 0.35)",
        "image": img("1517248135467-4c7edcad34c4", 800, 480),
        "title": "Atendente virtual pra seu restaurante 24h",
        "metaDesc": "Mostre cardápio, receba pedidos, calcule taxa de entrega no WhatsApp. R$199/mês.",
        "h1Pre": "Seu restaurante atendendo",
        "h1Accent": "no WhatsApp na hora",
        "subhead": "Mostra cardápio, recebe pedidos, calcula taxa de entrega por CEP, avisa horário. Sem cliente esperando 30 minutos pra perguntar se vocês estão abertos.",
        "template": "restaurante-br",
        "demoSlug": "demo-restaurante-br",
        "trust": ["✓ Cardápio editável a qualquer momento", "✓ Calcula entrega por CEP", "✓ Funciona no WhatsApp"],
        "featuresTitle": "O que seu atendente sabe fazer",
        "features": [
            (img("1543353071-873f17a7a088"),    "Mostra cardápio organizado", "Por categoria: pratos, bebidas, sobremesas. Cliente vê preços e descrições. Você cadastra uma vez, ele responde sempre que perguntarem."),
            (img("1526367790999-0150786686a2"), "Calcula entrega por CEP", "Cliente manda CEP, ele responde a taxa de entrega. Você define a base + por km. Não tem mais \"qual o valor pro meu bairro?\"."),
            (img("1495364141860-b0d03eccd065"), "Confere horários e feriados", "\"Vocês tão abertos hoje?\" — ele sabe se é feriado, se já fechou, qual o horário de hoje. Sem cliente perdido."),
            (img("1488521787991-ed7bbaae773c"), "Anota pedidos completos", "Item + quantidade + observação + endereço + forma de pagamento. Confirma o pedido antes de fechar. Manda direto pra você no formato que quiser."),
            (img("1516223725307-6f76b9ec8742"), "Tom de gente real", "Expressões coloquiais BR, leve humor. Cliente não sente que está falando com robô."),
            (img("1551288049-bebda4e38f71"),    "Histórico completo", "Veja todas conversas no dashboard. Identifica padrões: prato mais pedido, horário de pico, perguntas mais frequentes."),
        ],
        "steps": [
            ("Crie conta grátis", "Cadastra com email. R$5 de crédito grátis pra testar."),
            ('Escolha o template "Restaurante"', "Template já vem pronto: tom amigável, cálculo de entrega, anotação de pedidos."),
            ("Cadastre seu negócio", "Cardápio + preços + horário + taxa base de entrega + área de cobertura. Tudo em texto simples."),
            ("Conecte ao WhatsApp", "Use o número do restaurante. Toda mensagem que chegar no WhatsApp é atendida na hora."),
            ("Receba os pedidos prontos", "Pedido fechado vira mensagem clara pra cozinha + entrega. Você só executa."),
        ],
        "price": "R$ 199",
        "priceItems": [
            "Atendimento ilimitado 24h no WhatsApp",
            "Cardápio editável a qualquer momento",
            "Cálculo automático de entrega",
            "Histórico de pedidos",
            "Embed pro site/cardápio digital",
            "Cancele quando quiser, sem multa",
        ],
        "faq": [
            ("Ele realmente entende o cardápio direito?", "Sim. Você cola o cardápio em texto simples, ele organiza e aprende. Pode atualizar a qualquer momento. Se cliente perguntar item que não tem, ele sugere similar do cardápio."),
            ("E se cliente quiser pagar online?", "Por enquanto, ele anota a forma de pagamento (PIX, cartão na entrega, dinheiro). Integração com PIX automático tá no roadmap."),
            ("Como ele calcula a entrega?", "Você define o valor base (ex: R$5) + valor por km. Ele consulta o CEP do cliente, calcula a distância, devolve a taxa. Pode também ter taxa fixa por bairro se preferir."),
            ("E pedidos urgentes? Ele avisa?", 'Sim. Você configura tags pra "URGENTE" — quando aparecer, vem alerta no dashboard.'),
            ("Funciona pra delivery próprio ou só iFood?", "Pra delivery próprio. Funciona com seu WhatsApp direto, sem dependência de iFood/99."),
            ("Posso ter mais de um restaurante na mesma conta?", "Sim. Cria um agente por restaurante. R$199 por unidade."),
        ],
        "footer": "Atendente virtual pra restaurantes brasileiros.",
    },

    "loja": {
        "color": "#22c55e",
        "shadow": "rgba(34, 197, 94, 0.35)",
        "image": img("1607082348824-0a96f2a4b9da", 800, 480),
        "title": "Atendente virtual pra sua loja online",
        "metaDesc": "Calcula frete por CEP, valida CNPJ, compara preço. Reduz abandono de carrinho. R$199/mês.",
        "h1Pre": "Sua loja online atendendo",
        "h1Accent": "no WhatsApp e no site 24h",
        "subhead": "Calcula frete por CEP, valida CNPJ pra mostrar credibilidade, compara preço com concorrente, responde política de troca. Sem cliente abandonando carrinho por falta de resposta.",
        "template": "ecommerce-br",
        "demoSlug": "demo-ecommerce-br",
        "trust": ["✓ Funciona em Shopify, Nuvemshop, Loja Integrada", "✓ Cálculo de frete por CEP", "✓ Valida CNPJ na hora"],
        "featuresTitle": "O que seu atendente sabe fazer",
        "features": [
            (img("1607082348824-0a96f2a4b9da"), "Calcula frete por CEP", "Cliente manda CEP, ele responde valor + prazo de entrega na hora. Reduz abandono de carrinho — pessoa não precisa esperar até preencher checkout pra saber o frete."),
            (img("1486406146926-c627a92ad1ab"), "Valida CNPJ na hora", '"Vocês são empresa séria?" — ele consulta CNPJ, mostra dados públicos da empresa, situação cadastral. Trust automático sem você pedir.'),
            (img("1488229297570-58520851e868"), "Compara com concorrente", "Cliente acha barato em outro site? Ele consulta o link do concorrente e mostra o que vocês têm de diferente (frete grátis, garantia, troca, prazo)."),
            (img("1555529669-e69e7aa0ba9a"),    "Política de troca/devolução", "Você cadastra a política uma vez, ele responde sempre que perguntarem. Sem você ter que repetir o mesmo texto 50 vezes."),
            (img("1554224155-6726b3ff858f"),    "Converte moeda", "Cliente vê produto em dólar/euro? Ele converte pra real automaticamente. Útil pra dropshipping ou cross-border."),
            (img("1551288049-bebda4e38f71"),    "Captura leads", "Quando alguém pergunta produto que vocês não têm, ele anota e te avisa. Você sabe exatamente o que falta no catálogo."),
        ],
        "steps": [
            ("Crie conta grátis", "Cadastra com email. R$5 de crédito grátis pra testar."),
            ('Escolha o template "E-commerce"', "Template já vem com tom amigável BR + ferramentas de frete, CNPJ, comparação."),
            ("Cadastre os dados da loja", "Nome, CNPJ, política de troca, prazos, garantias. Cole link da loja se quiser que ele consulte produtos."),
            ("Plugue no site OU WhatsApp", "Cole o código embed no seu Shopify/Nuvemshop/WooCommerce — vira widget de chat. OU conecta no WhatsApp da loja."),
            ("Acompanhe vendas e leads", "Dashboard mostra cada conversa, frete consultado, pedidos abandonados, perguntas sobre produtos que não tem."),
        ],
        "price": "R$ 199",
        "priceItems": [
            "Atendimento ilimitado WhatsApp + site",
            "Cálculo de frete em tempo real (CEP)",
            "Validação de CNPJ automática",
            "Embed pra qualquer plataforma",
            "Histórico completo + leads",
            "Cancele quando quiser, sem multa",
        ],
        "faq": [
            ("Funciona com Shopify, Nuvemshop, Loja Integrada, WooCommerce?", "Sim. O embed é universal — funciona em qualquer plataforma que aceita HTML/script. Em poucos minutos você cola e tá rodando."),
            ("Ele realmente reduz abandono de carrinho?", 'Estudos mostram que 67% dos abandonos vêm de "frete inesperado" e "dúvidas não respondidas". Resolver isso ANTES do checkout aumenta conversão 15-30%. Esse é exatamente o problema que esse atendente resolve.'),
            ("E o cálculo de frete? É integrado com Correios/transportadora?", "Por padrão, ele calcula baseado no CEP + sua taxa configurada. Pra integração nativa com Correios/Jadlog/Loggi, é roadmap pra v2."),
            ("Dá pra integrar com meu catálogo de produtos?", "Sim, via link da loja (ele faz scrape de produtos quando cliente pergunta). Pra integração mais profunda (estoque em tempo real), precisa configurar via API — leva 1 hora se você for dev, ou pedimos pra te ajudar."),
            ("Funciona em mais de um idioma?", "Sim. Padrão é PT-BR, mas pode adicionar inglês ou espanhol — ajusta o prompt pra responder no idioma do cliente automaticamente."),
            ("E os dados dos clientes? LGPD?", "Conformidade total. Conversas armazenadas pra você acessar, exportável a qualquer momento, deletável quando o cliente pedir."),
        ],
        "footer": "Atendente virtual pra lojas online brasileiras.",
    },
}


def render(slug: str, cfg: dict) -> str:
    e = escape  # shorthand
    other_links = "".join(
        f'<a href="/{k}">{v["title"].split(" ")[0]}…</a>'
        for k, v in NICHES.items()
        if k != slug
    )
    features_html = "".join(
        f'''<div class="niche-feature">
            <div class="ico" style="background-image:url('{img_url}')"></div>
            <h3>{e(title)}</h3>
            <p>{e(desc)}</p>
        </div>''' for img_url, title, desc in cfg["features"]
    )
    steps_html = "".join(
        f'''<div class="niche-step">
            <div class="num">{i+1}</div>
            <div><h4>{e(t)}</h4><p>{e(d)}</p></div>
        </div>''' for i, (t, d) in enumerate(cfg["steps"])
    )
    price_items_html = "".join(f"<li>{e(it)}</li>" for it in cfg["priceItems"])
    faq_html = "".join(
        f'<details><summary>{e(q)}</summary><p>{e(a)}</p></details>'
        for q, a in cfg["faq"]
    )
    trust_html = "".join(f"<span>{e(t)}</span>" for t in cfg["trust"])

    page_url = f"https://axon-5zf.pages.dev/{slug}"
    return f'''<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{e(cfg["title"])} · Nexus Inovation</title>
<meta name="description" content="{e(cfg["metaDesc"])}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="{e(cfg["title"])} · Nexus Inovation" />
<meta property="og:description" content="{e(cfg["metaDesc"])}" />
<meta property="og:image" content="{e(cfg["image"])}" />
<meta property="og:url" content="{page_url}" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="canonical" href="{page_url}" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="styles.css" />
<style>
  :root {{ --niche: {cfg["color"]}; --niche-shadow: {cfg["shadow"]}; }}
  .niche-hero {{ padding: 80px 0 60px; background: linear-gradient(180deg, color-mix(in srgb, var(--niche) 8%, transparent), transparent); text-align: center; }}
  .niche-hero h1 {{ font-size: clamp(32px, 6vw, 56px); margin: 16px 0; line-height: 1.1; }}
  .niche-hero h1 .accent {{ color: var(--niche); }}
  .niche-hero .subhead {{ font-size: clamp(16px, 2.4vw, 20px); color: var(--text-dim); max-width: 680px; margin: 0 auto 32px; }}
  .niche-hero-photo {{ display: block; margin: 0 auto 24px; width: 100%; max-width: 380px; aspect-ratio: 16/10; object-fit: cover; border-radius: 16px; box-shadow: 0 24px 48px rgba(0,0,0,0.45); }}
  .niche-cta {{ display: inline-flex; align-items: center; gap: 10px; background: var(--niche); color: #fff; padding: 16px 32px; border-radius: 10px; font-weight: 700; font-size: 16px; text-decoration: none; min-height: 44px; box-shadow: 0 8px 24px var(--niche-shadow); transition: transform 0.15s; }}
  .niche-cta:hover {{ transform: translateY(-2px); }}
  .niche-cta-sub {{ color: var(--text-dim); font-size: 13px; margin-top: 12px; }}
  .niche-trust {{ display: flex; gap: 24px; justify-content: center; margin-top: 40px; flex-wrap: wrap; color: var(--text-dim); font-size: 13px; }}
  .niche-trust span {{ display: inline-flex; align-items: center; gap: 6px; }}
  .niche-features {{ padding: 60px 0; }}
  .niche-features h2 {{ text-align: center; font-size: clamp(24px, 4vw, 36px); margin-bottom: 48px; }}
  .niche-features-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; }}
  .niche-feature {{ padding: 28px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-card); transition: transform 0.15s, border-color 0.15s; }}
  .niche-feature:hover {{ transform: translateY(-2px); border-color: var(--niche); }}
  .niche-feature .ico {{ width: 100%; height: 140px; background-size: cover; background-position: center; border-radius: 8px; margin-bottom: 16px; background-color: var(--bg-elev); }}
  .niche-feature h3 {{ font-size: 18px; margin-bottom: 8px; color: var(--niche); }}
  .niche-feature p {{ color: var(--text-dim); font-size: 14px; line-height: 1.6; }}
  .niche-how {{ background: var(--bg-elev); padding: 60px 0; }}
  .niche-how h2 {{ text-align: center; font-size: clamp(24px, 4vw, 36px); margin-bottom: 48px; }}
  .niche-steps {{ max-width: 760px; margin: 0 auto; display: grid; gap: 20px; }}
  .niche-step {{ display: grid; grid-template-columns: 50px 1fr; gap: 20px; align-items: start; padding: 20px; border-left: 3px solid var(--niche); background: var(--bg-card); border-radius: 0 10px 10px 0; }}
  .niche-step .num {{ background: var(--niche); color: #fff; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 18px; }}
  .niche-step h4 {{ font-size: 16px; margin-bottom: 6px; }}
  .niche-step p {{ color: var(--text-dim); font-size: 14px; line-height: 1.55; }}
  .niche-pricing {{ padding: 60px 0; text-align: center; }}
  .niche-pricing h2 {{ font-size: clamp(24px, 4vw, 36px); margin-bottom: 16px; }}
  .niche-pricing .price {{ font-size: 56px; font-weight: 800; color: var(--niche); }}
  .niche-pricing .price small {{ font-size: 16px; color: var(--text-dim); font-weight: 400; }}
  .niche-pricing ul {{ list-style: none; padding: 0; max-width: 480px; margin: 32px auto; text-align: left; display: grid; gap: 10px; }}
  .niche-pricing li {{ padding: 8px 0; color: var(--text); display: flex; align-items: center; gap: 10px; }}
  .niche-pricing li::before {{ content: "✓"; color: var(--niche); font-weight: 700; flex-shrink: 0; }}
  .niche-faq {{ padding: 60px 0 100px; max-width: 720px; margin: 0 auto; }}
  .niche-faq h2 {{ font-size: clamp(24px, 4vw, 36px); margin-bottom: 32px; text-align: center; }}
  .niche-faq details {{ border-bottom: 1px solid var(--border); padding: 18px 0; cursor: pointer; }}
  .niche-faq summary {{ font-weight: 600; font-size: 16px; list-style: none; }}
  .niche-faq summary::-webkit-details-marker {{ display: none; }}
  .niche-faq summary::after {{ content: "+"; float: right; color: var(--niche); font-size: 22px; line-height: 1; }}
  .niche-faq details[open] summary::after {{ content: "−"; }}
  .niche-faq details > p {{ margin-top: 12px; color: var(--text-dim); font-size: 14px; line-height: 1.7; }}
  .niche-other {{ padding: 40px 0 60px; text-align: center; }}
  .niche-other-row {{ display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }}
  .niche-other a {{ padding: 10px 18px; border: 1px solid var(--border); border-radius: 8px; color: var(--text-dim); text-decoration: none; font-size: 14px; transition: border-color 0.15s, color 0.15s; }}
  .niche-other a:hover {{ border-color: var(--niche); color: var(--text); }}
  @media (max-width: 600px) {{
    .niche-hero {{ padding: 50px 0 40px; }}
    .niche-features, .niche-how, .niche-pricing, .niche-faq {{ padding: 40px 0; }}
    .niche-step {{ grid-template-columns: 40px 1fr; gap: 14px; padding: 16px; }}
    .niche-cta {{ width: 100%; justify-content: center; padding: 16px 24px; }}
  }}
</style>
</head>
<body>

<header class="nav">
  <div class="container nav-inner">
    <a href="/" class="brand"><span class="logo-dot"></span> Nexus Inovation</a>
    <nav class="nav-links">
      <a href="/clinica">Clínica</a>
      <a href="/restaurante">Restaurante</a>
      <a href="/loja">Loja</a>
      <a href="/build">Criar agente</a>
      <a href="/upgrade">Planos</a>
    </nav>
  </div>
</header>

<main>
  <section class="niche-hero">
    <div class="container">
      <img class="niche-hero-photo" src="{e(cfg["image"])}" alt="" loading="eager" />
      <h1>{e(cfg["h1Pre"])}<br /><span class="accent">{e(cfg["h1Accent"])}</span></h1>
      <p class="subhead">{e(cfg["subhead"])}</p>
      <div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap;">
        <a class="niche-cta" href="/agent/{e(cfg["demoSlug"])}" style="background:#22c55e;box-shadow:0 8px 24px rgba(34,197,94,0.35);">
          Testar grátis (sem cadastro)
        </a>
        <a class="niche-cta" href="/build?template={e(cfg["template"])}">
          Criar a minha agora
        </a>
      </div>
      <div class="niche-cta-sub">5 minutos · sem cartão de crédito · cancela quando quiser</div>
      <div class="niche-trust">{trust_html}</div>
    </div>
  </section>

  <section class="niche-features">
    <div class="container">
      <h2>{e(cfg["featuresTitle"])}</h2>
      <div class="niche-features-grid">{features_html}</div>
    </div>
  </section>

  <section class="niche-how">
    <div class="container">
      <h2>Como funciona</h2>
      <div class="niche-steps">{steps_html}</div>
    </div>
  </section>

  <section class="niche-pricing">
    <div class="container">
      <h2>Quanto custa</h2>
      <div class="price">{e(cfg["price"])}<small>/mês</small></div>
      <ul>{price_items_html}</ul>
      <a class="niche-cta" href="/build?template={e(cfg["template"])}">Criar a minha agora</a>
    </div>
  </section>

  <section class="niche-faq">
    <h2>Perguntas frequentes</h2>
    {faq_html}
  </section>

  <section class="niche-other">
    <div class="container">
      <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 14px;">Outras verticais</p>
      <div class="niche-other-row">{other_links}</div>
    </div>
  </section>
</main>

<footer class="footer-mini">
  <div class="container" style="padding: 24px 0; text-align: center; color: var(--text-muted); font-size: 13px;">
    {e(cfg["footer"])} · <a href="/" style="color: var(--text-dim);">Início</a> · <a href="/build" style="color: var(--text-dim);">Criar agente</a>
  </div>
</footer>

</body>
</html>
'''


if __name__ == "__main__":
    import os
    out_dir = os.path.join(os.path.dirname(__file__), "..", "landing")
    for slug, cfg in NICHES.items():
        path = os.path.join(out_dir, f"{slug}.html")
        with open(path, "w", encoding="utf-8") as f:
            f.write(render(slug, cfg))
        print(f"wrote {path} ({os.path.getsize(path)} bytes)")
