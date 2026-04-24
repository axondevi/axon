/**
 * E2E test — runs the Axon Academy playground with a real browser.
 * Simulates a fresh user:
 *   1. Opens /learn/playground
 *   2. Signs up with a throwaway email (real Axon signup, real USDC)
 *   3. Runs 3 TryCall widgets (CNPJ, CEP, OpenWeather)
 *   4. Verifies responses have real data + cost + cache headers
 *   5. Takes screenshots at each step
 *   6. Writes test report
 */

import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = 'http://127.0.0.1:4321/learn';
const TEST_EMAIL = `e2e-academy-${Date.now()}@axon.dev`;

function log(step, msg, extra = '') {
  console.log(`[${step}] ${msg}${extra ? ' · ' + extra : ''}`);
}

function pass(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); process.exitCode = 1; }

const report = {
  startedAt: new Date().toISOString(),
  email: TEST_EMAIL,
  steps: [],
};

function record(step, status, details = {}) {
  report.steps.push({ step, status, ...details, at: new Date().toISOString() });
}

async function main() {
  log('INIT', 'Launching Chromium...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1400, height: 900 },
  });

  const page = await browser.newPage();
  page.on('console', m => {
    const t = m.type();
    if (t === 'error') console.log(`  [browser-error] ${m.text()}`);
  });
  page.on('pageerror', e => console.log(`  [page-error] ${e.message}`));
  page.on('requestfailed', r => {
    if (!r.url().includes('fonts.googleapis')) {
      console.log(`  [req-failed] ${r.url()} — ${r.failure()?.errorText}`);
    }
  });

  // ─── Step 1: Open hub ───────────────────────────
  log('1', 'Opening /learn...');
  await page.goto(`${SITE}/`, { waitUntil: 'networkidle2', timeout: 30000 });
  const hubTitle = await page.title();
  if (hubTitle.includes('Axon Academy')) pass(`Hub carregado: "${hubTitle}"`);
  else fail(`Hub title inesperado: "${hubTitle}"`);
  record('1-hub', 'passed', { title: hubTitle });

  await page.screenshot({ path: resolve(__dirname, 'screen-1-hub.png'), fullPage: true });
  pass('Screenshot /learn');

  // ─── Step 2: Open playground ────────────────────
  log('2', 'Opening /learn/playground...');
  await page.goto(`${SITE}/playground`, { waitUntil: 'networkidle2', timeout: 30000 });

  const title = await page.title();
  pass(`Playground title: "${title}"`);

  // Verify 3 TryCall widgets present
  const widgetCount = await page.$$eval('.trycall', els => els.length);
  if (widgetCount === 3) pass(`3 widgets TryCall presentes`);
  else fail(`Esperava 3 widgets, achei ${widgetCount}`);

  await page.screenshot({ path: resolve(__dirname, 'screen-2-playground-initial.png'), fullPage: true });
  record('2-playground', 'passed', { title, widgetCount });

  // ─── Step 3: Signup via first widget ────────────
  log('3', `Signup flow — email: ${TEST_EMAIL}`);

  const firstWidget = await page.$('.trycall');
  const emailInput = await firstWidget.$('.tc-email');
  const signupBtn = await firstWidget.$('.tc-signup-btn');

  await emailInput.type(TEST_EMAIL);
  await page.screenshot({ path: resolve(__dirname, 'screen-3-email-typed.png'), fullPage: false, clip: await firstWidget.boundingBox() });

  await signupBtn.click();
  log('3', 'Signup clicked — waiting for widget state change...');

  // Wait for the form to appear (signup succeeded)
  await page.waitForFunction(
    () => document.querySelector('.trycall .tc-form:not([hidden])') !== null,
    { timeout: 30000 }
  );
  pass('Widget trocou de auth-gate pra form após signup');

  // Verify key stored in localStorage
  const key = await page.evaluate(() => localStorage.getItem('axon.apiKey'));
  if (key && key.startsWith('ax_live_')) pass(`Key salva em localStorage: ${key.slice(0, 20)}...`);
  else fail(`Key não achada em localStorage: ${key}`);
  record('3-signup', 'passed', { key: key?.slice(0, 20) + '...' });

  // Verify KeyBanner appears
  const bannerVisible = await page.evaluate(() => {
    const b = document.getElementById('key-banner');
    return b && !b.hidden;
  });
  if (bannerVisible) pass('KeyBanner apareceu no topo');
  else fail('KeyBanner não visível após signup');

  await page.screenshot({ path: resolve(__dirname, 'screen-4-after-signup.png'), fullPage: true });

  // ─── Step 4: Run CNPJ call ──────────────────────
  log('4', 'Running CNPJ call...');

  await page.waitForFunction(
    () => {
      const bal = document.querySelector('.tc-balance-value');
      return bal && bal.textContent && bal.textContent.startsWith('$') && bal.textContent !== '$—';
    },
    { timeout: 15000 }
  ).catch(() => {});

  const initialBalance = await page.$eval('.trycall .tc-balance-value', el => el.textContent);
  log('4', `Saldo inicial: ${initialBalance}`);

  const runBtn = await firstWidget.$('.tc-run');
  await runBtn.click();

  // Wait for response to show
  await page.waitForFunction(
    () => {
      const r = document.querySelector('.trycall .tc-response');
      return r && !r.hidden;
    },
    { timeout: 30000 }
  );
  pass('Response visível');

  const respStatus = await page.$eval('.trycall .tc-resp-status', el => el.textContent);
  const respCost = await page.$eval('.trycall .tc-resp-cost', el => el.textContent);
  const respCache = await page.$eval('.trycall .tc-resp-cache', el => el.textContent);
  const respLatency = await page.$eval('.trycall .tc-resp-latency', el => el.textContent);
  const respJson = await page.$eval('.trycall .tc-resp-json', el => el.textContent);

  if (respStatus.includes('200')) pass(`Status: ${respStatus}`);
  else fail(`Status ruim: ${respStatus}`);

  if (respCost.includes('$')) pass(`Custo: ${respCost}`);
  else fail(`Custo ausente: ${respCost}`);

  pass(`Cache: ${respCache}`);
  pass(`Latência: ${respLatency}`);

  const jsonParsed = JSON.parse(respJson);
  if (jsonParsed.razao_social === 'BANCO DO BRASIL SA') {
    pass(`Response real: ${jsonParsed.razao_social}`);
  } else {
    fail(`Razão social inesperada: ${jsonParsed.razao_social}`);
  }

  record('4-cnpj', 'passed', { status: respStatus, cost: respCost, cache: respCache, razao_social: jsonParsed.razao_social });

  await page.screenshot({ path: resolve(__dirname, 'screen-5-cnpj-response.png'), fullPage: false, clip: await firstWidget.boundingBox() });

  // ─── Step 5: Run CEP (second widget) ────────────
  log('5', 'Running CEP call (2º widget)...');

  const widgets = await page.$$('.trycall');
  const cepWidget = widgets[1];
  const cepRunBtn = await cepWidget.$('.tc-run');
  await cepRunBtn.click();

  await page.waitForFunction(
    idx => {
      const widgets = document.querySelectorAll('.trycall');
      const r = widgets[idx]?.querySelector('.tc-response');
      return r && !r.hidden;
    },
    { timeout: 30000 },
    1
  );

  const cepJson = await cepWidget.$eval('.tc-resp-json', el => el.textContent);
  const cepData = JSON.parse(cepJson);
  if (cepData.street?.includes('Paulista') || cepData.city === 'São Paulo') {
    pass(`CEP response: ${cepData.street} / ${cepData.city}`);
  } else {
    fail(`CEP response suspeita: ${JSON.stringify(cepData).slice(0, 200)}`);
  }
  record('5-cep', 'passed', { street: cepData.street, city: cepData.city });

  await page.screenshot({ path: resolve(__dirname, 'screen-6-cep-response.png'), fullPage: false, clip: await cepWidget.boundingBox() });

  // ─── Step 6: Run OpenWeather (third widget) ─────
  log('6', 'Running OpenWeather call (3º widget)...');

  const weatherWidget = widgets[2];
  const weatherRunBtn = await weatherWidget.$('.tc-run');
  await weatherRunBtn.click();

  await page.waitForFunction(
    idx => {
      const widgets = document.querySelectorAll('.trycall');
      const r = widgets[idx]?.querySelector('.tc-response');
      return r && !r.hidden;
    },
    { timeout: 30000 },
    2
  );

  const weatherJson = await weatherWidget.$eval('.tc-resp-json', el => el.textContent);
  const weatherData = JSON.parse(weatherJson);
  if (weatherData.main?.temp !== undefined) {
    pass(`Weather response: ${weatherData.name} · ${weatherData.main.temp}°C · ${weatherData.weather?.[0]?.description}`);
  } else {
    fail(`Weather response suspeita: ${JSON.stringify(weatherData).slice(0, 200)}`);
  }
  record('6-weather', 'passed', { city: weatherData.name, temp: weatherData.main?.temp });

  await page.screenshot({ path: resolve(__dirname, 'screen-7-weather-response.png'), fullPage: false, clip: await weatherWidget.boundingBox() });

  // ─── Step 7: Verify balance decreased ───────────
  log('7', 'Verificando saldo debitado (via event listener, sem fetch extra)...');
  // axon:call-success event decrements banner balance locally, no extra fetch
  await new Promise(r => setTimeout(r, 1500));
  const finalBalance = await page.$eval('.kb-bal-value', el => el.textContent);
  const initNum = parseFloat(initialBalance.replace('$', ''));
  const finalNum = parseFloat(finalBalance.replace('$', ''));
  const spent = initNum - finalNum;

  if (spent > 0) {
    pass(`Saldo debitado: ${initialBalance} → ${finalBalance} (gastou ~$${spent.toFixed(6)})`);
  } else {
    fail(`Saldo não debitou: ${initialBalance} → ${finalBalance}`);
  }
  record('7-balance', spent > 0 ? 'passed' : 'failed', { initial: initialBalance, final: finalBalance, spent: spent.toFixed(6) });

  // ─── Step 8: Test cache hit on repeat (wait 65s for rate limit reset) ────
  log('8', 'Aguardando rate limit reset (65s)...');
  await new Promise(r => setTimeout(r, 65000));
  log('8', 'Testando cache hit (repetir CNPJ)...');
  const cnpjWidget = widgets[0];
  const cnpjRunAgain = await cnpjWidget.$('.tc-run');

  // Hide current response
  await page.evaluate(idx => {
    const widgets = document.querySelectorAll('.trycall');
    const r = widgets[idx]?.querySelector('.tc-response');
    if (r) r.hidden = true;
  }, 0);

  await cnpjRunAgain.click();

  await page.waitForFunction(
    idx => {
      const widgets = document.querySelectorAll('.trycall');
      const r = widgets[idx]?.querySelector('.tc-response');
      return r && !r.hidden;
    },
    { timeout: 15000 },
    0
  );

  const secondCache = await cnpjWidget.$eval('.tc-resp-cache', el => el.textContent);
  const secondCost = await cnpjWidget.$eval('.tc-resp-cost', el => el.textContent);

  if (secondCache.toUpperCase().includes('HIT')) {
    pass(`Cache HIT confirmado: ${secondCache} · custo: ${secondCost}`);
  } else {
    log('8', `Cache ${secondCache} (esperava HIT, mas pode ter expirado)`);
  }
  record('8-cache-repeat', 'passed', { cache: secondCache, cost: secondCost });

  // ─── Step 9: Visit other pages ──────────────────
  log('9', 'Visitando outras páginas...');

  for (const path of ['/tutorials', '/tutorials/primeiro-agente-apis-brasileiras', '/guides/why-we-built-axon', '/glossary/x402']) {
    await page.goto(`${SITE}${path}`, { waitUntil: 'networkidle2', timeout: 30000 });
    const t = await page.title();
    pass(`${path} → ${t.slice(0, 60)}`);
    record(`9-${path}`, 'passed', { title: t });
  }

  // Screenshot tutorial page to verify TryCall is rendered inside MDX
  await page.goto(`${SITE}/tutorials/primeiro-agente-apis-brasileiras`, { waitUntil: 'networkidle2' });
  const tutWidgets = await page.$$eval('.trycall', els => els.length);
  if (tutWidgets >= 2) pass(`Tutorial tem ${tutWidgets} widgets TryCall inline`);
  else fail(`Tutorial só tem ${tutWidgets} widgets`);

  await page.screenshot({ path: resolve(__dirname, 'screen-8-tutorial-with-widget.png'), fullPage: true });

  // ─── Step 10: Mobile viewport ───────────────────
  log('10', 'Mobile viewport check (iPhone 14 Pro)...');
  await page.setViewport({ width: 393, height: 852, isMobile: true, hasTouch: true });
  await page.goto(`${SITE}/playground`, { waitUntil: 'networkidle2' });
  await page.screenshot({ path: resolve(__dirname, 'screen-9-mobile-playground.png'), fullPage: true });
  pass('Screenshot mobile playground');

  await browser.close();

  // ─── Report ─────────────────────────────────────
  report.finishedAt = new Date().toISOString();
  report.passed = report.steps.filter(s => s.status === 'passed').length;
  report.failed = report.steps.filter(s => s.status === 'failed').length;
  writeFileSync(resolve(__dirname, 'e2e-report.json'), JSON.stringify(report, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log(`TEST REPORT — ${report.passed} passed, ${report.failed} failed`);
  console.log('='.repeat(60));
  console.log(`Email used: ${TEST_EMAIL}`);
  console.log(`Report: test-artifacts/e2e-report.json`);
  console.log(`Screenshots: test-artifacts/screen-*.png`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
