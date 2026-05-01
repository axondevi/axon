#!/usr/bin/env python3
"""
E2E test for the agent management overhaul:
  - Dashboard rich agent cards (channels, stats, actions)
  - WhatsApp connect/disconnect modal markup
  - Edit flow (?edit=AGENT_ID on /build pre-fills form)
  - Delete flow (× button)
  - Plans page comparison table + use cases + PT-BR FAQ
"""

import sys
import urllib.request
import json

LANDING = "https://axon-5zf.pages.dev"
API = "https://axon-kedb.onrender.com"
KEY = "ax_live_5681c148953426b274931393683c8a69a9c66da5546dd19a"
AGENT_ID = "72a0984d-86f2-4672-98e7-cf6fac5a7263"
UA = "Mozilla/5.0 (axon-e2e-mgmt/1.0)"


def fetch(url, headers=None):
    req = urllib.request.Request(url, headers={**(headers or {}), "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except Exception as e:
        return 0, str(e)


passed = 0
failed = []


def check(label, ok, info=""):
    global passed
    if ok:
        passed += 1
        print(f"  ✅ {label}")
    else:
        failed.append((label, info))
        print(f"  ❌ {label} — {info}")


def section(t):
    print(f"\n{'═' * 70}\n{t}\n{'═' * 70}")


# ═══════════════════════════════════════════════════════════════
section("1. Dashboard rich agent cards")
_, html = fetch(f"{LANDING}/dashboard")
check("agent-row CSS class defined", ".agent-row" in html and ".agent-row-name" in html)
check("hydrateAgentCard function present", "hydrateAgentCard" in html)
check("WhatsApp pill — connected state", ".ch-wa-on" in html)
check("WhatsApp pill — disconnected state", ".ch-wa-off" in html)
check("WhatsApp pill — warning state", ".ch-wa-warn" in html)
check("openWhatsappModal function present", "openWhatsappModal" in html)
check("renderWaConnectedView present", "renderWaConnectedView" in html)
check("renderWaConnectForm present", "renderWaConnectForm" in html)
check("Action button: 🧠 Cérebro", "🧠 Cérebro" in html)
check("Action button: 💬 WhatsApp", "💬 WhatsApp" in html)
check("Action button: ⚙ Editar", "⚙ Editar" in html)
check("Action button: 🔗 Abrir", "🔗 Abrir" in html)
check("Edit link uses ?edit= param", "/build?edit=" in html)
check("Delete uses confirm + DELETE method", "deleteAgent" in html and "method: 'DELETE'" in html)


# ═══════════════════════════════════════════════════════════════
section("2. Build page edit-mode auto-load")
_, html = fetch(f"{LANDING}/build")
check("maybeAutoLoadEdit function present", "maybeAutoLoadEdit" in html)
check("editAgent passes pay_mode", "pay_mode: a.pay_mode" in html)
check("editAgent passes daily_budget_usdc", "daily_budget_usdc: a.daily_budget_usdc" in html)
check("editAgent passes tier_required", "tier_required: a.tier_required" in html)
check("editAgent passes vanity_domain", "vanity_domain: a.vanity_domain" in html)


# ═══════════════════════════════════════════════════════════════
section("3. Plans page rebuilt")
_, html = fetch(f"{LANDING}/upgrade")
check("Comparison table present", 'class="comp-table"' in html)
check("Capability row: clientes simultâneos", "Clientes simultâneos" in html)
check("Capability row: conversas/dia", "Conversas/dia" in html)
check("Capability row: taxa por chamada", "Taxa por chamada" in html)
check("Capability row: templates premium", "Templates premium" in html)
check("Capability row: alertas email", "Alertas por email" in html)
check("Capability row: painel admin", "Painel operador" in html)
check("Use cases section: Free testando", "Testando a ideia" in html)
check("Use cases section: Pro pequeno negócio", "Pequeno negócio rodando" in html)
check("Use cases section: Team múltiplos", "Múltiplos clientes" in html)
check("PT-BR plan blurbs", "Pra testar e validar" in html)
check("PT-BR FAQ headers", "Como funciona a assinatura em USDC?" in html)
check("FAQ: how many agents", "Quantos agentes posso criar" in html)
check("Header nav PT-BR (Explorar)", ">Explorar<" in html)
check("Header nav PT-BR (Painel)", ">Painel<" in html)


# ═══════════════════════════════════════════════════════════════
section("4. Backend endpoints still work (regression)")

def api(path, method="GET", body=None):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body else None,
        method=method,
        headers={"x-api-key": KEY, "Content-Type": "application/json", "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode())
    except Exception as e:
        return 0, str(e)


s, _ = api("/v1/wallet/balance")
check("/v1/wallet/balance still 200", s == 200)

s, d = api("/v1/agents")
check("/v1/agents still 200", s == 200)
if isinstance(d, dict) and d.get("data"):
    check(f"  · {len(d['data'])} agents owned", len(d["data"]) >= 1)

s, d = api(f"/v1/agents/{AGENT_ID}")
check("Agent detail GET works", s == 200)
if isinstance(d, dict):
    check("  · returns pay_mode field", "pay_mode" in d)
    check("  · returns daily_budget_usdc", "daily_budget_usdc" in d)
    check("  · returns tier_required", "tier_required" in d)

s, d = api(f"/v1/agents/{AGENT_ID}/whatsapp")
check("Agent /whatsapp GET works", s == 200)
if isinstance(d, dict):
    check("  · connected: true", d.get("connected") is True)


# ═══════════════════════════════════════════════════════════════
total = passed + len(failed)
print(f"\n{'═' * 70}\nRESULT: {passed}/{total} passed, {len(failed)} failed\n{'═' * 70}")
if failed:
    for label, info in failed:
        print(f"  ✗ {label}: {info}")
sys.exit(0 if not failed else 1)
