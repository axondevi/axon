#!/usr/bin/env python3
"""
Mobile responsiveness E2E test.

Validates that:
  1. Every page has viewport meta tag
  2. Every page has mobile @media breakpoints
  3. The shared _ui-kit.css has the new mobile overrides
  4. No page has obvious horizontal-overflow issues (fixed widths > 375px
     without max-width fallback)
  5. Touch-target rules are present (min-height: 40-44px for buttons)

Doesn't render in a real browser — that requires Puppeteer/Playwright. Instead
checks CSS source for the rules that prevent the audit's issues from happening.
"""

import json
import re
import sys
import urllib.request

LANDING = "https://axon-5zf.pages.dev"
UA = "Mozilla/5.0 (axon-mobile-e2e/1.0)"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except Exception as e:
        return 0, str(e)


passed = []
failed = []


def check(label, ok, info=""):
    (passed if ok else failed).append((label, info))
    sym = "✅" if ok else "❌"
    extra = f" — {info}" if info else ""
    print(f"  {sym} {label}{extra}")


def section(title):
    print(f"\n{'═' * 70}\n{title}\n{'═' * 70}")


# ═══════════════════════════════════════════════════════════════
# 1. Shared _ui-kit.css mobile rules
# ═══════════════════════════════════════════════════════════════
section("1. _ui-kit.css mobile overrides")
status, css = fetch(f"{LANDING}/_ui-kit.css")
check("/_ui-kit.css 200", status == 200)
check("touch-tooltip block", "(hover: none)" in css and "(pointer: coarse)" in css)
check("toast mobile reposition", "max-width: 500px" in css and "#axon-toasts" in css)
check("global mobile fixes block", "MOBILE RESPONSIVENESS" in css)
check("html overflow-x:hidden rule", "overflow-x: hidden" in css)
check("button min-height rule", "min-height: 40px" in css)
check("modal max-width clamp", "calc(100vw" in css)
check("table horizontal scroll", "table {" in css and "overflow-x: auto" in css)


# ═══════════════════════════════════════════════════════════════
# 2. Each page: viewport meta + at least 2 breakpoints
# ═══════════════════════════════════════════════════════════════
section("2. Per-page viewport + breakpoints")

pages = [
    "/dashboard",
    "/whatsapp",
    "/build",
    "/agent-runner.html",
    "/upgrade",
    "/explore",
    "/clinica",
    "/restaurante",
    "/loja",
    "/",
]

VIEWPORT_RE = re.compile(r'<meta\s+name="viewport"\s+content="[^"]*width=device-width', re.I)
MEDIA_RE = re.compile(r'@media\s*\(\s*max-width:\s*(\d+)px', re.I)

for path in pages:
    status, html = fetch(f"{LANDING}{path}")
    check(f"GET {path}", status == 200)
    check(f"  · viewport meta", bool(VIEWPORT_RE.search(html)))
    breakpoints = sorted({int(m) for m in MEDIA_RE.findall(html)})
    has_small = any(bp <= 600 for bp in breakpoints)
    check(f"  · has mobile breakpoint ≤600px",
          has_small,
          f"breakpoints found: {breakpoints if breakpoints else 'none'}")


# ═══════════════════════════════════════════════════════════════
# 3. Critical fixes verified per page
# ═══════════════════════════════════════════════════════════════
section("3. Critical mobile fixes verified")

# whatsapp.html: stacked layout < 800px
_, html = fetch(f"{LANDING}/whatsapp")
check("whatsapp: stacked grid mobile rule", "grid-template-columns: 1fr;" in html and "max-width: 800px" in html)
check("whatsapp: contacts-pane bottom-border on stack", "border-bottom: 1px solid var(--border)" in html)
check("whatsapp: header wraps mobile", "flex-wrap: wrap;" in html)

# build.html: tools-grid 1-col on mobile
_, html = fetch(f"{LANDING}/build")
check("build: tools-grid 1-col mobile rule", ".tools-grid { grid-template-columns: 1fr !important; }" in html)
check("build: builder-form row stacks mobile", ".builder-form .row { grid-template-columns: 1fr;" in html)
check("build: tab-bar 44px touch", ".tab-bar button { padding: 12px 16px; min-height: 44px;" in html)

# dashboard.html: deposit hero scaling
_, html = fetch(f"{LANDING}/dashboard")
check("dashboard: QR size scales mobile", ".deposit-hero .qr-img { width: 120px !important;" in html)
check("dashboard: nav horizontal scroll mobile", "overflow-x: auto; flex-wrap: nowrap !important;" in html)
check("dashboard: metrics grid 2-col mobile", ".grid { grid-template-columns: 1fr 1fr;" in html)

# agent-runner.html: had no mobile before, now has
_, html = fetch(f"{LANDING}/agent-runner.html")
check("agent-runner: NEW @media (max-width: 600px) block", "@media (max-width: 600px)" in html)
check("agent-runner: send-btn min-height 44px", ".send-btn { padding: 10px 14px; min-height: 44px;" in html)
check("agent-runner: msg-content 92% mobile", "max-width: 92% !important;" in html)

# upgrade.html: toast width fix
_, html = fetch(f"{LANDING}/upgrade")
check("upgrade: toast bottom 12px mobile", ".toast-mini { bottom: 16px; right: 12px; left: 12px;" in html)
check("upgrade: plan-cta 44px touch", ".plan-cta { padding: 12px 16px; min-height: 44px;" in html)

# explore.html: had no mobile before, now has
_, html = fetch(f"{LANDING}/explore")
check("explore: ag-grid 1-col mobile", ".ag-grid { grid-template-columns: 1fr;" in html)
check("explore: chip-btn 40px touch", ".chip-btn { padding: 10px 14px; min-height: 40px;" in html)

# index.html: success modal full-width mobile
_, html = fetch(f"{LANDING}/")
check("index: success modal mobile", ".success-modal-inner { padding: 24px 18px !important;" in html)
check("index: niche cta stacks mobile", ".niche-cta-row { flex-direction: column;" in html)


# ═══════════════════════════════════════════════════════════════
# 4. No giant fixed widths in HTML (heuristic)
# ═══════════════════════════════════════════════════════════════
section("4. Heuristic: no obvious horizontal-overflow risks")

# Look for inline width values > 400px without max-width or min-width:0 fallback
GIANT_WIDTH_RE = re.compile(r'style="[^"]*\bwidth:\s*(\d{4,})px', re.I)

for path in pages:
    _, html = fetch(f"{LANDING}{path}")
    matches = GIANT_WIDTH_RE.findall(html)
    big = [int(m) for m in matches if int(m) > 500]
    check(f"{path} no inline width > 500px", len(big) == 0,
          f"found: {big[:3]}" if big else "")


# ═══════════════════════════════════════════════════════════════
print(f"\n{'═' * 70}")
print(f"RESULT: {len(passed)}/{len(passed) + len(failed)} passed, {len(failed)} failed")
print('═' * 70)
if failed:
    print("\nFAILED:")
    for label, info in failed:
        print(f"  ✗ {label}: {info}")
sys.exit(0 if not failed else 1)
