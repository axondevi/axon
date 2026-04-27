#!/usr/bin/env python3
"""
build-catalog.py

Le todos os arquivos JSON em registry/ e gera landing/catalog.json,
um snapshot estatico do catalogo de APIs que o frontend pode usar
como fallback quando o backend (Render) esta cold-started ou indisponivel.

Inclui:
  - data: lista resumida (slug, provider, category, description, endpoints[])
  - details: dict por slug com endpoints completos (price, markup, cache)

Roda automaticamente no CI antes de cada deploy do landing.
"""

import json
import os
import glob
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY_DIR = os.path.join(ROOT, 'registry')
OUTPUT_FILE = os.path.join(ROOT, 'landing', 'catalog.json')

def main():
    items = []
    details = {}
    skipped = []

    for f in sorted(glob.glob(os.path.join(REGISTRY_DIR, '*.json'))):
        try:
            with open(f, encoding='utf-8') as fh:
                d = json.load(fh)
        except Exception as e:
            skipped.append((f, str(e)))
            continue

        slug = d.get('slug')
        if not slug:
            skipped.append((f, 'no slug'))
            continue

        items.append({
            'slug': slug,
            'provider': d.get('provider'),
            'category': d.get('category'),
            'description': d.get('description'),
            'homepage': d.get('homepage'),
            'endpoints': list(d.get('endpoints', {}).keys()),
        })

        endpoints_arr = []
        for key, ep in d.get('endpoints', {}).items():
            price = ep.get('price_usd', 0) or 0
            markup = ep.get('markup_pct', 0) or 0
            endpoints_arr.append({
                'key': key,
                'method': ep.get('method', 'POST'),
                'path': ep.get('path', ''),
                'price_usd': price,
                'markup_pct': markup,
                'cache_ttl': ep.get('cache_ttl', 0),
                'effective_price_usd': price * (1 + markup / 100),
                'cached_price_usd': price * 0.5,
            })

        details[slug] = {
            'slug': slug,
            'provider': d.get('provider'),
            'category': d.get('category'),
            'description': d.get('description'),
            'homepage': d.get('homepage'),
            'endpoints': endpoints_arr,
        }

    output = {
        'data': items,
        'count': len(items),
        '_generated': True,
        '_source': 'registry/*.json',
        'details': details,
    }

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    size = os.path.getsize(OUTPUT_FILE)
    print(f'OK  {OUTPUT_FILE}')
    print(f'    {len(items)} APIs, {size:,} bytes')
    if skipped:
        print(f'    skipped: {len(skipped)} files')
        for path, reason in skipped:
            print(f'      - {os.path.basename(path)}: {reason}')

if __name__ == '__main__':
    main()
