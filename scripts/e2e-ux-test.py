#!/usr/bin/env python3
"""
End-to-end UX test after the PT-BR + tooltips + cost transparency sprint.

What this validates:
  1. Visual: every public page returns 200, has expected PT-BR markers, loads
     the _ui-kit.css/js, and key UX features are in the HTML
  2. Functional: backend endpoints respond correctly (auth, balance, agents,
     contacts, messages, subscription, whatsapp connection)
  3. Integration: full WhatsApp inbound → agent reply with multi-bubble works

Usage:
    python scripts/e2e-ux-test.py
"""

import json
import sys
import urllib.request
import urllib.error

API = "https://axon-kedb.onrender.com"
LANDING = "https://axon-5zf.pages.dev"
KEY = "ax_live_5681c148953426b274931393683c8a69a9c66da5546dd19a"
AGENT_ID = "72a0984d-86f2-4672-98e7-cf6fac5a7263"
AGENT_SLUG = "recep-zap-1777339176"
WEBHOOK = "https://axon-kedb.onrender.com/v1/webhooks/whatsapp/466a9934b0fbc19dfcdefab187e32274f16f379f9fad3ba6"
UA = "Mozilla/5.0 (axon-e2e-ux/1.0)"


def fetch(url, headers=None, body=None, method=None):
    headers = headers or {}
    headers.setdefault("User-Agent", UA)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    if data:
        headers.setdefault("Content-Type", "application/json")
    method = method or ("POST" if data else "GET")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode("utf-8", errors="replace")
            try:
                return r.status, text, json.loads(text)
            except Exception:
                return r.status, text, None
    except urllib.error.HTTPError as e:
        try:
            text = e.read().decode("utf-8", errors="replace")
            return e.code, text, None
        except Exception:
            return e.code, str(e), None
    except Exception as e:
        return 0, str(e), None


# ─── Test results aggregator ──────────────────────────────────────
class Suite:
    def __init__(self):
        self.results = []

    def check(self, label, ok, info=""):
        self.results.append((label, ok, info))
        sym = "✅" if ok else "❌"
        info_part = f" — {info}" if info else ""
        print(f"  {sym} {label}{info_part}")

    def section(self, title):
        print(f"\n{'═' * 70}\n{title}\n{'═' * 70}")

    def summary(self):
        passed = sum(1 for _, ok, _ in self.results if ok)
        failed = len(self.results) - passed
        print(f"\n{'═' * 70}")
        print(f"RESULT: {passed}/{len(self.results)} passed, {failed} failed")
        print('═' * 70)
        if failed:
            print("\nFAILED:")
            for label, ok, info in self.results:
                if not ok:
                    print(f"  ✗ {label}: {info}")
        return failed == 0


s = Suite()

# ═══════════════════════════════════════════════════════════════
# 1. UI Kit shared assets
# ═══════════════════════════════════════════════════════════════
s.section("1. UI Kit (shared tooltips, toasts)")
status, text, _ = fetch(f"{LANDING}/_ui-kit.css")
s.check("/_ui-kit.css 200", status == 200, f"got {status}")
s.check("/_ui-kit.css contains .info-tip", ".info-tip" in text)
s.check("/_ui-kit.css contains .axon-toast", ".axon-toast" in text)
s.check("/_ui-kit.css contains .cost-badge", ".cost-badge" in text)

status, text, _ = fetch(f"{LANDING}/_ui-kit.js")
s.check("/_ui-kit.js 200", status == 200, f"got {status}")
s.check("/_ui-kit.js exposes AxonUI.toast", "AxonUI" in text and "toast" in text)

# ═══════════════════════════════════════════════════════════════
# 2. Public pages — render + PT-BR markers + UI kit included
# ═══════════════════════════════════════════════════════════════
s.section("2. Public pages — render + PT-BR markers")

pages = [
    ("/", ["Toda API", "Comece em 30 segundos", "Pagamento em USDC"]),
    ("/dashboard", ["Painel Axon", "Cole sua API key", "_ui-kit"]),
    ("/whatsapp", ["WhatsApp Brain", "_ui-kit"]),
    ("/build", ["Construa seu agente", "Modelos prontos", "Criar agente", "_ui-kit"]),
    ("/upgrade", ["Escolha seu plano", "Assinar", "_ui-kit"]),
    ("/explore", ["TESTE GRÁTIS", "demo"]),
    ("/clinica", ["clínica", "Início"]),
    ("/restaurante", ["restaurante", "Início"]),
    ("/loja", ["loja", "Início"]),
    ("/buy-usdc", ["USDC"]),
    ("/stats", []),
    ("/status", []),
]

for path, expected in pages:
    status, text, _ = fetch(f"{LANDING}{path}")
    s.check(f"GET {path} returns 200", status == 200, f"got {status}")
    for marker in expected:
        s.check(f"  · contains '{marker}'", marker in text)

# ═══════════════════════════════════════════════════════════════
# 3. Specific UX features in HTML
# ═══════════════════════════════════════════════════════════════
s.section("3. UX features in page HTML")

# Dashboard tooltips
_, text, _ = fetch(f"{LANDING}/dashboard")
s.check("Dashboard: deposit hero tooltips", 'data-tip="Esta é sua carteira USDC' in text or 'data-tip="USDC' in text)
s.check("Dashboard: burn rate tooltip", "Autonomia" in text and "data-tip=" in text)
s.check("Dashboard: cache rate tooltip", "Taxa de cache" in text)
s.check("Dashboard: PT-BR nav (Criar agente)", "Criar agente" in text)
s.check("Dashboard: PT-BR nav (Planos)", "Planos" in text)
s.check("Dashboard: 'sair' instead of 'sign out'", '>sair<' in text or "'sair'" in text)

# Build form
_, text, _ = fetch(f"{LANDING}/build")
s.check("Build: tool cost catalog has 'cost' field", "'cost'" in text or '"cost"' in text)
s.check("Build: free tools shown as 'free' or '$0'", "'free'" in text and "'$0'" in text)
s.check("Build: 'Criar agente' button", "Criar agente" in text)
s.check("Build: PT-BR system prompt label", "Prompt do agente" in text)
s.check("Build: tool-cost CSS class defined", ".tool-cost" in text)

# WhatsApp UI
_, text, _ = fetch(f"{LANDING}/whatsapp")
s.check("WhatsApp: showConnectModal function defined", "showConnectModal" in text)
s.check("WhatsApp: onboarding modal mentions Evolution API", "Evolution API" in text)
s.check("WhatsApp: 3-step text", "3 passos" in text)
s.check("WhatsApp: empty state PT-BR", "Nenhum contato" in text or "não conectado" in text)

# Agent runner
_, text, _ = fetch(f"{LANDING}/agent-runner.html")
s.check("Runner: cost-badge in render", "cost-badge" in text)
s.check("Runner: PT-BR 'agente' label", "'agente'" in text or "agente</div>" in text)
s.check("Runner: AxonUI.toast for hard cap", "AxonUI.toast" in text)
s.check("Runner: cache hit detection", "x-axon-cache" in text)

# Upgrade page
_, text, _ = fetch(f"{LANDING}/upgrade")
s.check("Upgrade: tooltip on rate limits", 'data-tip="Quantas chamadas' in text)
s.check("Upgrade: tooltip on markup", 'data-tip="Você paga' in text)
s.check("Upgrade: 'Assinar' button (PT)", "Assinar —" in text)

# ═══════════════════════════════════════════════════════════════
# 4. Backend endpoints — Kaolin's account
# ═══════════════════════════════════════════════════════════════
s.section("4. Backend endpoints (kaolinn20@gmail.com)")

headers = {"x-api-key": KEY}

status, _, data = fetch(f"{API}/health/ready", headers=headers, method="GET")
s.check("/health/ready 200", status == 200)

status, _, data = fetch(f"{API}/v1/wallet/balance", headers=headers)
s.check("/v1/wallet/balance 200", status == 200)
if data:
    s.check("  · balance present", "balance_usdc" in data)
    s.check("  · balance > 0", float(data.get("balance_usdc", 0)) > 0, f"got ${data.get('balance_usdc')}")

status, _, data = fetch(f"{API}/v1/usage", headers=headers)
s.check("/v1/usage 200", status == 200)

status, _, data = fetch(f"{API}/v1/subscription", headers=headers)
s.check("/v1/subscription 200", status == 200)
if data:
    s.check("  · tier_active present", "tier_active" in data)
    s.check("  · pro tier active", data.get("tier_active") == "pro", f"got {data.get('tier_active')}")

status, _, data = fetch(f"{API}/v1/agents", headers=headers)
s.check("/v1/agents 200", status == 200)
if data:
    n = len(data.get("data", []))
    s.check(f"  · {n} agents owned", n >= 1)

status, _, data = fetch(f"{API}/v1/agents/{AGENT_ID}/whatsapp", headers=headers)
s.check("Agent /whatsapp endpoint works", status == 200)
if data:
    s.check("  · WhatsApp connected", data.get("connected") is True)

status, _, data = fetch(f"{API}/v1/agents/{AGENT_ID}/contacts", headers=headers)
s.check("Agent /contacts endpoint works", status == 200)

# session_id filter (new!)
status, _, data = fetch(f"{API}/v1/agents/{AGENT_ID}/messages?session_id=wa:9999&limit=5", headers=headers)
s.check("Messages session_id filter works", status == 200)

# ═══════════════════════════════════════════════════════════════
# 5. Integration — full WhatsApp inbound + multi-bubble verify
# ═══════════════════════════════════════════════════════════════
s.section("5. Integration: WhatsApp webhook → agent reply with multi-bubble")

import time
test_phone = f"5599{int(time.time()) % 100000000:08d}"
status, _, _ = fetch(WEBHOOK, body={
    "event": "messages.upsert",
    "instance": "axon-test",
    "data": {
        "key": {"remoteJid": f"{test_phone}@s.whatsapp.net", "fromMe": False, "id": f"E2E_{int(time.time())}"},
        "pushName": "E2E Test User",
        "message": {"conversation": "oi, queria marcar uma consulta hoje a tarde com clinico geral, sou nova"},
    },
})
s.check("Webhook accepts inbound", status == 200, f"got {status}")

# Wait for agent processing
print("    aguardando 6s pro agente processar...")
time.sleep(6)

# Check that contact was created
status, _, data = fetch(f"{API}/v1/agents/{AGENT_ID}/contacts/{test_phone}", headers=headers)
s.check("Contact memory created from inbound", status == 200)

# Check messages contain agent reply with || (multi-bubble) or natural sentences
status, _, data = fetch(f"{API}/v1/agents/{AGENT_ID}/messages?session_id=wa:{test_phone}&limit=2", headers=headers)
s.check("Agent generated reply", status == 200 and data and len(data.get("data", [])) >= 1)
if data and data.get("data"):
    assistant_msgs = [m for m in data["data"] if m.get("role") == "assistant"]
    if assistant_msgs:
        reply = assistant_msgs[0].get("content", "")
        print(f"    🤖 Camila respondeu: \"{reply}\"")
        # Check for greeting based on hour
        has_greeting = any(g in reply.lower() for g in ["bom dia", "boa tarde", "boa noite"])
        s.check("  · Reply contains time-of-day greeting", has_greeting)
        # Multi-bubble: either uses || or is short enough to be one bubble naturally
        is_short = len(reply) < 200
        has_separator = "||" in reply
        s.check("  · Reply is short OR uses ||", is_short or has_separator,
                f"len={len(reply)}, has||={has_separator}")
    else:
        s.check("  · Reply is from assistant", False, "no assistant messages")

# Cleanup test contact
status, _, _ = fetch(f"{API}/v1/agents/{AGENT_ID}/contacts/{test_phone}", headers=headers, method="DELETE")
s.check("  · Cleanup test contact", status == 200)

# ═══════════════════════════════════════════════════════════════
ok = s.summary()
sys.exit(0 if ok else 1)
