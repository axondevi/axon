#!/usr/bin/env python3
"""Deep validation: cache stats, frontend, mobile, edge cases."""
import json
import time
import urllib.request

BASE = "https://axon-kedb.onrender.com"
WEB = "https://axon-5zf.pages.dev"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
def get(url, timeout=20, headers=None):
    h = {"User-Agent": UA, "Accept": "text/html,application/json,*/*"}
    if headers: h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers, r.status

def post_json(url, body, timeout=90):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode())
    return data, time.time() - t0

print("=" * 70)
print("  TESTE 4: Frontend pages carregando")
print("=" * 70)

pages = [
    ("/", "Landing principal"),
    ("/clinica", "Vertical clinica"),
    ("/restaurante", "Vertical restaurante"),
    ("/loja", "Vertical loja"),
    ("/explore", "Explore / agentes publicos"),
    ("/build", "Build (factory)"),
    ("/stats", "Stats publicos"),
    ("/status", "Status do sistema"),
    ("/agent/demo-restaurante-br", "Agent runner (restaurante)"),
    ("/agent/demo-recepcionista-clinica-br", "Agent runner (clinica)"),
    ("/agent/demo-ecommerce-br", "Agent runner (loja)"),
    ("/agent/demo-faq-bot-simples", "Agent runner (FAQ)"),
    ("/catalog.json", "Static catalog (40 APIs)"),
]
for path, desc in pages:
    try:
        body, hdrs, code = get(WEB + path, timeout=15)
        size_kb = len(body) / 1024
        print(f"  HTTP {code} | {size_kb:6.1f} KB | {path:42s} | {desc}")
    except Exception as e:
        print(f"  ERRO {path:42s} | {str(e)[:60]}")

print()
print("=" * 70)
print("  TESTE 5: APIs do backend")
print("=" * 70)

apis = [
    ("/health/ready", "Backend ready"),
    ("/v1/agents/explore", "Explore agentes"),
    ("/v1/agents/templates", "Templates (10)"),
    ("/v1/agents/by-slug/demo-restaurante-br", "Detalhes 1 agente"),
    ("/v1/auth/privy/config", "Privy config (deve disabled)"),
    ("/v1/stats/public?days=30", "Stats publicas"),
    ("/v1/apis", "Catalog APIs"),
]
for path, desc in apis:
    try:
        body, hdrs, code = get(BASE + path, timeout=15)
        size_kb = len(body) / 1024
        print(f"  HTTP {code} | {size_kb:6.1f} KB | {path:48s} | {desc}")
    except Exception as e:
        print(f"  ERRO {path:48s} | {str(e)[:60]}")

print()
print("=" * 70)
print("  TESTE 6: Tool lookup_cep com CEP REAL valido")
print("=" * 70)

real_ceps = ["01310100", "20040030", "30130010"]  # SP, RJ, BH
for cep in real_ceps:
    try:
        data, elapsed = post_json(
            f"{BASE}/v1/run/demo-ecommerce-br/chat",
            {"message": f"Calcular frete pra CEP {cep}"},
            timeout=60
        )
        cached = data.get('cached', False)
        tag = "[CACHE]" if cached else "[LLM]"
        tools = data.get('tool_calls_executed', [])
        tool_status = "OK" if tools and tools[0].get('ok') else "FAIL"
        print(f"  {tag} {tool_status} | CEP {cep} | {elapsed:.1f}s | tool result: {len(str(tools))} chars")
        print(f"    {data.get('content','')[:200]}")
    except Exception as e:
        print(f"  ERRO CEP {cep}: {str(e)[:120]}")
    time.sleep(2)

print()
print("=" * 70)
print("  TESTE 7: Multi-mensagem (conversa contextual)")
print("=" * 70)

try:
    data, elapsed = post_json(
        f"{BASE}/v1/run/demo-restaurante-br/chat",
        {"messages": [
            {"role": "user", "content": "Voces tem opcao vegetariana?"},
            {"role": "assistant", "content": "Sim, temos varias opcoes vegetarianas no cardapio."},
            {"role": "user", "content": "Quais sao as 3 mais pedidas?"},
        ]},
        timeout=60
    )
    cached = data.get('cached', False)
    tag = "[CACHE]" if cached else "[LLM]"
    print(f"  {tag} | {elapsed:.2f}s | iter: {data.get('iterations')}")
    print(f"  expectativa: NAO cachear (conversa contextual com 3 turnos)")
    print(f"  resultado: {'CORRETO (sem cache)' if not cached else 'ERRO (cacheou)'}")
    print(f"  resposta: {data.get('content', '')[:250]}")
except Exception as e:
    print(f"  ERRO: {str(e)[:200]}")

print()
print("=" * 70)
print("  TESTES FINALIZADOS")
print("=" * 70)
