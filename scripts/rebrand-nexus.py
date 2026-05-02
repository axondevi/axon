"""
One-shot rebrand sweep — Axon → Nexus Inovation in landing/*.html.

Surgical: only touches USER-VISIBLE brand strings. Internal identifiers
(localStorage keys, JS globals, env vars, URLs) stay axon-named because
changing them would break things and they're not visible to end users.

Patterns replaced:
  - `\bAxon\b`  → `Nexus Inovation`   (capital, word-boundary, brand)
  - `> axon<`   → `> nexusinovation<` (lowercase brand inside <a>/<div>/<span>)

Patterns SKIPPED (case-sensitive matters here):
  - `axon-kedb`, `axon-5zf`, `axon-academy`     (URLs)
  - `axon.apiKey`, `axon.baseUrl`, `axon.gallery.*`, `axon.convo.*`,
    `axon.agentCapAck`                          (localStorage keys)
  - `AxonUI`, `AxonI18n`                        (JS globals — \b boundary skips them)
  - `AXON_KEY`, `AXON_EVOLUTION_*`              (env vars — case mismatch skips them)
"""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Targets:
# - landing/*.html (top-level pages on Cloudflare Pages root)
# - academy/src/**/*.{astro,md,ts,mjs} (Astro source, builds into landing/learn/)
TARGETS = [
    *sorted((REPO / 'landing').glob('*.html')),
    *sorted((REPO / 'academy' / 'src').rglob('*.astro')),
    *sorted((REPO / 'academy' / 'src').rglob('*.md')),
    *sorted((REPO / 'academy' / 'src').rglob('*.mdx')),
    *sorted((REPO / 'academy' / 'src').rglob('*.ts')),
    *sorted((REPO / 'academy' / 'src').rglob('*.mjs')),
    *sorted((REPO / 'academy' / 'src').rglob('*.css')),
]

PATTERNS = [
    # Capital "Axon" as a standalone brand word.
    # \b avoids `AxonUI` / `AxonI18n` / `AxonClient` (followed by letter).
    (re.compile(r'\bAxon\b'), 'Nexus Inovation'),
    # Lowercase brand text inside header elements:
    # `> axon<` / `>axon<` (with optional whitespace, inside <a>/<div>/<span>).
    (re.compile(r'(>\s*)axon(\s*</(?:a|div|span)>)'), r'\1nexusinovation\2'),
]

count_files = 0
count_subs = 0
for path in TARGETS:
    text = path.read_text(encoding='utf-8')
    new = text
    file_subs = 0
    for pat, rep in PATTERNS:
        new, n = pat.subn(rep, new)
        file_subs += n
    if new != text:
        path.write_text(new, encoding='utf-8')
        count_files += 1
        count_subs += file_subs
        rel = path.relative_to(REPO)
        print(f'  {rel}: {file_subs} subs')

print(f'\nTotal: {count_files} files, {count_subs} substitutions')
