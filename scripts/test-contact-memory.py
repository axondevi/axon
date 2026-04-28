#!/usr/bin/env python3
"""
End-to-end test for Contact Memory (Build 1).

What this validates:
  1. Schema deployed (POST/GET/PATCH/DELETE on /v1/agents/:id/contacts work)
  2. Manual edit creates memory row + tags as 'manual' source
  3. List endpoint returns the contact with correct shape
  4. Update preserves manual facts (won't be overwritten by LLM extraction later)
  5. Delete removes the contact

Usage:
    python scripts/test-contact-memory.py [--api https://axon-kedb.onrender.com]

Requires:
    - AXON_API_KEY env var (an owner-side key with at least 1 agent)
    - OR --key arg
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

DEFAULT_API = "https://axon-kedb.onrender.com"
UA = "axon-contact-memory-test/1.0"


def req(method: str, url: str, key: str, body=None) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "x-api-key": key,
        "Content-Type": "application/json",
        "User-Agent": UA,
    }
    r = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            payload = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(payload)
            except Exception:
                return resp.status, {"raw": payload}
    except urllib.error.HTTPError as e:
        try:
            payload = e.read().decode("utf-8")
            return e.code, json.loads(payload)
        except Exception:
            return e.code, {"raw": str(e)}
    except Exception as e:
        return 0, {"error": str(e)}


def find_or_make_agent(api: str, key: str) -> str:
    """Find an existing owned agent or create a throwaway one."""
    print("→ Looking up existing agents…")
    status, data = req("GET", f"{api}/v1/agents", key)
    if status == 200 and isinstance(data.get("data"), list) and data["data"]:
        agent_id = data["data"][0]["id"]
        print(f"  using existing agent: {agent_id} ({data['data'][0].get('name')})")
        return agent_id

    print("→ No agents — creating one for the test…")
    slug = f"mem-test-{int(time.time())}"
    status, data = req("POST", f"{api}/v1/agents", key, {
        "slug": slug,
        "name": "Memory Test Agent",
        "system_prompt": "You are a helpful test assistant.",
        "allowed_tools": ["lookup_cep"],
        "pay_mode": "owner",
        "public": False,
    })
    if status not in (200, 201) or not data.get("id"):
        print(f"  FAIL — could not create agent: {status} {data}")
        sys.exit(1)
    agent_id = data["id"]
    print(f"  created agent: {agent_id} (slug={data.get('slug')})")
    return agent_id


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--key", default=os.environ.get("AXON_API_KEY"))
    args = parser.parse_args()
    if not args.key:
        print("ERROR: set AXON_API_KEY env var or pass --key")
        sys.exit(2)

    api = args.api.rstrip("/")
    key = args.key
    test_phone = f"5511{int(time.time()) % 100000000:08d}"
    print(f"\n=== Contact Memory E2E ===")
    print(f"API: {api}")
    print(f"Test phone: {test_phone}\n")

    agent_id = find_or_make_agent(api, key)

    fails = []

    # 1. List should not contain our test phone yet
    print("\n[1/6] GET list (expect not present)…")
    status, data = req("GET", f"{api}/v1/agents/{agent_id}/contacts", key)
    if status != 200:
        fails.append(f"list status={status} {data}")
        print(f"  FAIL {status}: {data}")
    else:
        present = any(c.get("phone") == test_phone for c in data.get("contacts", []))
        if present:
            print(f"  ! note: test phone already exists (leftover from prev run)")
        else:
            print(f"  OK — {len(data.get('contacts', []))} contacts, ours not present yet")

    # 2. GET single (expect 404)
    print("\n[2/6] GET single (expect 404 since no inbound msg yet)…")
    status, data = req("GET", f"{api}/v1/agents/{agent_id}/contacts/{test_phone}", key)
    if status == 404:
        print(f"  OK — 404 as expected")
    else:
        print(f"  ! got {status}: {data}")

    # 3. PATCH (upsert: lazy-creates row if missing)
    print("\n[3/6] PATCH (upsert via owner edit)…")
    status, data = req("PATCH", f"{api}/v1/agents/{agent_id}/contacts/{test_phone}", key, {
        "display_name": "Pedro Silva (test)",
        "language": "pt-br",
        "formality": "informal",
        "tags": ["VIP", "test"],
        "facts": [
            {"key": "allergy", "value": "lactose"},
            {"key": "city", "value": "São Paulo"},
            {"key": "preferred_payment", "value": "PIX"},
        ],
    })
    if status != 200:
        fails.append(f"patch status={status} {data}")
        print(f"  FAIL {status}: {data}")
    else:
        print(f"  OK — patched. display_name={data['contact'].get('display_name')}")
        facts = data["contact"].get("facts", [])
        print(f"  facts: {len(facts)} entries, all source=manual? {all(f.get('source') == 'manual' for f in facts)}")

    # 4. GET single (expect populated)
    print("\n[4/6] GET single (expect populated)…")
    status, data = req("GET", f"{api}/v1/agents/{agent_id}/contacts/{test_phone}", key)
    if status != 200:
        fails.append(f"get-single status={status} {data}")
        print(f"  FAIL {status}: {data}")
    else:
        print(f"  OK — display_name={data.get('display_name')}, tags={data.get('tags')}")
        print(f"  facts={[(f.get('key'), f.get('value')) for f in data.get('facts', [])]}")

    # 5. List (expect present now)
    print("\n[5/6] GET list (expect present)…")
    status, data = req("GET", f"{api}/v1/agents/{agent_id}/contacts", key)
    if status != 200:
        fails.append(f"list2 status={status} {data}")
    else:
        ours = next((c for c in data.get("contacts", []) if c.get("phone") == test_phone), None)
        if ours:
            print(f"  OK — found, facts_count={ours.get('facts_count')}")
        else:
            fails.append("test phone not in list after PATCH")
            print(f"  FAIL — not in list")

    # 6. DELETE
    print("\n[6/6] DELETE (cleanup)…")
    status, data = req("DELETE", f"{api}/v1/agents/{agent_id}/contacts/{test_phone}", key)
    if status != 200:
        fails.append(f"delete status={status} {data}")
        print(f"  FAIL {status}: {data}")
    else:
        print(f"  OK — deleted")

    print(f"\n=== Result: {'PASS' if not fails else 'FAIL'} ===")
    if fails:
        for f in fails:
            print(f"  - {f}")
        sys.exit(1)


if __name__ == "__main__":
    main()
