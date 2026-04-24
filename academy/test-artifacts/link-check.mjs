/**
 * Crawls /learn/* and checks every internal link resolves.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');

function walkDir(dir, cb) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkDir(full, cb);
    else cb(full);
  }
}

const pages = new Set();
const internalLinks = new Map();

walkDir(DIST, f => {
  if (!f.endsWith('.html')) return;
  const rel = f.replace(DIST, '').replace(/\\/g, '/').replace(/\/index\.html$/, '').replace(/\.html$/, '') || '/';
  const page = '/learn' + (rel === '/' ? '' : rel);
  pages.add(page);

  const html = readFileSync(f, 'utf-8');
  const linkRe = /href=["']([^"'#]+)(#[^"']*)?["']/g;
  const links = [];
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1];
    if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('tel:') || href === '') continue;
    // Skip assets (they're build outputs, not content pages)
    if (/\.(css|js|svg|png|jpg|xml|txt|ico|woff2?)$/i.test(href)) continue;
    if (href.startsWith('/learn')) {
      // Strip query string for matching
      const clean = href.split('?')[0];
      links.push(clean);
    }
  }
  if (links.length) internalLinks.set(page, links);
});

console.log(`Pages found: ${pages.size}`);
console.log(`Internal links to check: ${[...internalLinks.values()].reduce((a, b) => a + b.length, 0)}`);

let ok = 0, broken = [];
for (const [page, links] of internalLinks) {
  for (const link of links) {
    const normalized = link.replace(/\/$/, '').replace(/\/$/, '');
    const target = normalized.endsWith('.svg') || normalized.endsWith('.xml')
      ? null // external asset, skip
      : normalized;
    if (!target) { ok++; continue; }
    if (pages.has(target) || pages.has(target + '/')) {
      ok++;
    } else {
      broken.push({ page, link, normalized: target });
    }
  }
}

console.log(`\n✓ OK: ${ok}`);
console.log(`✗ Broken: ${broken.length}`);
if (broken.length) {
  console.log('\n=== Broken links ===');
  for (const b of broken) {
    console.log(`  ${b.page} → ${b.link}`);
  }
  process.exit(1);
}
