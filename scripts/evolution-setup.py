#!/usr/bin/env python3
"""
End-to-end Evolution setup helper.

Steps:
  1. Verify Evolution API is reachable
  2. Create an instance (named "axon-test")
  3. Fetch QR code
  4. Save QR as PNG so user can open + scan with WhatsApp
  5. Poll until connection state = "open"
  6. Connect the instance to an Axon agent

Usage:
    python scripts/evolution-setup.py
        --evo https://axon-evolution.onrender.com
        --evo-key 6b8a45a3...
        --axon https://axon-kedb.onrender.com
        --axon-key ax_live_...
        --agent-id <uuid>
        --instance axon-test
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.request
import urllib.error


def req(method, url, headers=None, body=None, timeout=30):
    headers = headers or {}
    data = json.dumps(body).encode() if body is not None else None
    if data:
        headers.setdefault("Content-Type", "application/json")
    r = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            payload = resp.read().decode()
            try:
                return resp.status, json.loads(payload)
            except Exception:
                return resp.status, {"raw": payload}
    except urllib.error.HTTPError as e:
        try:
            payload = e.read().decode()
            return e.code, json.loads(payload)
        except Exception:
            return e.code, {"raw": str(e)}
    except Exception as e:
        return 0, {"error": str(e)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--evo", required=True, help="Evolution base URL")
    p.add_argument("--evo-key", required=True, help="Evolution AUTHENTICATION_API_KEY")
    p.add_argument("--axon", required=True, help="Axon API base URL")
    p.add_argument("--axon-key", required=True, help="Axon owner API key")
    p.add_argument("--agent-id", required=True, help="Axon agent UUID to connect")
    p.add_argument("--instance", default="axon-test", help="Evolution instance name")
    p.add_argument("--qr-out", default="qr.png", help="Path to save QR PNG")
    args = p.parse_args()

    evo = args.evo.rstrip("/")
    headers = {"apikey": args.evo_key}

    # 1. Verify Evolution
    print(f"\n→ [1/6] Checking Evolution at {evo}…")
    s, d = req("GET", f"{evo}/", headers=headers)
    if s != 200:
        print(f"  FAIL — {s}: {d}")
        sys.exit(1)
    print(f"  OK — {d.get('message') or d.get('status') or 'reachable'}")

    # 2. Check if instance exists; create if not
    print(f"\n→ [2/6] Looking up instance '{args.instance}'…")
    s, d = req("GET", f"{evo}/instance/fetchInstances?instanceName={args.instance}", headers=headers)
    exists = bool(d) and isinstance(d, list) and len(d) > 0
    if exists:
        print(f"  Instance exists.")
    else:
        print(f"  Creating instance…")
        s, d = req("POST", f"{evo}/instance/create", headers=headers, body={
            "instanceName": args.instance,
            "qrcode": True,
            "integration": "WHATSAPP-BAILEYS",
        })
        if s not in (200, 201):
            print(f"  FAIL create — {s}: {d}")
            sys.exit(1)
        print(f"  Created.")

    # 3. Get QR code
    print(f"\n→ [3/6] Fetching QR code…")
    qr_b64 = None
    for attempt in range(10):
        # Endpoint varies by Evolution version. Try newest first.
        s, d = req("GET", f"{evo}/instance/connect/{args.instance}", headers=headers)
        if s == 200:
            base64_str = d.get("base64") or (d.get("qrcode") or {}).get("base64")
            if base64_str:
                qr_b64 = base64_str
                break
        time.sleep(2)

    if not qr_b64:
        # Maybe already connected
        s, d = req("GET", f"{evo}/instance/connectionState/{args.instance}", headers=headers)
        state = (d.get("instance") or {}).get("state") or d.get("state")
        if state == "open":
            print(f"  Already connected (state=open). Skipping QR.")
        else:
            print(f"  FAIL — could not retrieve QR. state={state}")
            sys.exit(1)
    else:
        # 4. Save PNG
        if qr_b64.startswith("data:"):
            qr_b64 = qr_b64.split(",", 1)[1]
        png_bytes = base64.b64decode(qr_b64)
        with open(args.qr_out, "wb") as f:
            f.write(png_bytes)
        print(f"  Saved QR to {args.qr_out} ({len(png_bytes)} bytes)")
        print(f"\n  📱 ABRA O ARQUIVO {args.qr_out} E ESCANEIE COM SEU WHATSAPP:")
        print(f"     WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho")

    # 5. Poll for connection
    print(f"\n→ [5/6] Aguardando conexão (timeout 120s)…")
    state = None
    for i in range(60):
        s, d = req("GET", f"{evo}/instance/connectionState/{args.instance}", headers=headers)
        state = (d.get("instance") or {}).get("state") or d.get("state")
        sys.stdout.write(f"\r  state={state} ({i*2}s)")
        sys.stdout.flush()
        if state == "open":
            print(f"\n  ✓ CONNECTED!")
            break
        time.sleep(2)
    if state != "open":
        print(f"\n  ✗ Did not connect within timeout. Re-scan and try again.")
        sys.exit(1)

    # 6. Register on Axon
    print(f"\n→ [6/6] Conectando agente Axon…")
    axon = args.axon.rstrip("/")
    s, d = req("POST", f"{axon}/v1/agents/{args.agent_id}/whatsapp",
               headers={"x-api-key": args.axon_key},
               body={
                   "instance_url": evo,
                   "instance_name": args.instance,
                   "api_key": args.evo_key,
               })
    if s != 200:
        print(f"  FAIL — {s}: {d}")
        sys.exit(1)
    print(f"  ✓ Conectado!")
    print(f"  webhook URL: {d.get('connection', {}).get('webhook_url')}")

    print(f"\n=== ALL DONE ===")
    print(f"\nManda mensagem do seu WhatsApp pra qualquer número que NÃO seja você mesmo,")
    print(f"depois manda pra esse número Evolution conectado. O agente vai responder!")
    print(f"\nMonitore as mensagens em:")
    print(f"  GET {axon}/v1/agents/{args.agent_id}/contacts")
    print(f"  (depois da primeira msg, vai aparecer o contato com facts extraídos)")


if __name__ == "__main__":
    main()
