#!/usr/bin/env python3
"""End-to-end test of Axon agent runtime + Knowledge Cache."""
import json
import time
import urllib.request

BASE = "https://axon-kedb.onrender.com"

def post(path, body, timeout=90):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode())
    return data, time.time() - t0

def show_response(data, elapsed):
    cached = data.get('cached', False)
    cache_emoji = "[CACHE]" if cached else "[LLM]"
    print(f"  {cache_emoji} latency: {elapsed:.2f}s | cost: ${data.get('total_cost_usdc','?')} | iter: {data.get('iterations','?')} | tools: {len(data.get('tool_calls_executed', []))}")
    if cached and 'cache_similarity' in data:
        print(f"    similarity: {data['cache_similarity']:.3f}")
    tools = data.get('tool_calls_executed', [])
    for t in tools:
        ok = "OK" if t.get('ok') else "FAIL"
        print(f"    {ok} tool: {t.get('name')} (${t.get('cost_usdc')})")
    content = data.get('content', '')
    print(f"    >>> {content[:300]}")

def test_conversation(slug, questions, label):
    print()
    print("=" * 70)
    print(f"  {label}")
    print("=" * 70)
    for i, q in enumerate(questions, 1):
        print(f"\n#{i}: '{q}'")
        try:
            data, elapsed = post(f"/v1/run/{slug}/chat", {"message": q}, timeout=90)
            show_response(data, elapsed)
        except Exception as e:
            print(f"  ERRO: {str(e)[:300]}")
        time.sleep(3)

if __name__ == "__main__":
    test_conversation(
        "demo-restaurante-br",
        [
            "Ola! Voces estao abertos agora?",
            "E quanto a entrega? Voces entregam pra CEP 01310-100?",
            "Ola! Voces tao abertos agora?",  # similar to #1 - SHOULD CACHE HIT
        ],
        "TEST 1: restaurante (#3 = repeticao similar a #1, deve cachear)"
    )

    test_conversation(
        "demo-recepcionista-clinica-br",
        [
            "Quero agendar consulta com cardiologista",
            "Voces atendem convenio Unimed?",
        ],
        "TEST 2: clinica"
    )

    test_conversation(
        "demo-ecommerce-br",
        [
            "Calcular frete pra CEP 04567-890",
        ],
        "TEST 3: ecommerce (deve usar tool lookup_cep)"
    )

    print()
    print("=" * 70)
    print("  TESTES FINALIZADOS")
    print("=" * 70)
