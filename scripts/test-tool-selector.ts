// Standalone test of the keyword heuristic — copies the regex map from
// tool-selector.ts so we don't pull in the full env config.
const TOOL_KEYWORDS: Record<string, RegExp> = {
  lookup_cep:        /\bcep\b\s*\d{5}|c[oó]digo postal|qual o cep|busca cep|consulta cep/i,
  lookup_cnpj:       /\bcnpj\b|raz[aã]o social|s[oó]cios?\s+da\s+empresa|empresa\s+\d{2}\.\d{3}/i,
  lookup_bank:       /(c[oó]digo|n[uú]mero|cod\.)\s+(do\s+)?banco|banco\s+\d{3}|qual banco|banco\s+(itau|nubank|caixa|bradesco|santander|inter)|febraban/i,
  lookup_fipe:       /fipe|tabela fipe|valor (do|de) (carro|ve[ií]culo|moto|caminhao)|pre[çc]o (do|de) (carro|ve[ií]culo|moto)/i,
  ibge_city:         /\bibge\b|c[oó]digo de m[uú]nic[ií]pio|c[oó]digo ibge|m[uú]nic[ií]pio\s+\d{6,7}/i,
  brasilapi_holidays:/feriad/i,
  brasilapi_rates:   /selic|cdi|ipca|igp.?m|taxa b[aá]sica/i,
  brasilapi_ddd:     /\bddd\s+\d{2}|\bddd\b\s+(de|do)/i,
  bcb_indicator:     /(s[eé]rie|hist[oó]rico)\s+(da\s+)?(selic|ipca|cdi|d[oó]lar|ptax)|bacen|banco central|sgs/i,
  current_weather:   /(?:clima|tempo|temperatura|chuva|chovendo|cal[oô]r|frio)\s+(?:em|de|na|no|hoje|agora)|qual\s+(?:o\s+)?clima/i,
  weather_forecast:  /previs[aã]o\s+(?:do\s+)?tempo|previs[aã]o\s+(?:para|amanh[aã]|semana)/i,
  geocode_address:   /coordenada|latitude|longitude|geocod|localiza[çc][aã]o\s+(?:de|do|da)\s+\w/i,
  route_distance:    /\bdist[aâ]ncia\b|trajeto|rota\s+(?:de|entre)|tempo\s+de\s+(?:carro|via|trajet)|\bkm\b\s+(?:de|at[ée])/i,
  lookup_country:    /capital de|popula[çc][aã]o de\s+\w|qual a moeda de|fronteiras de/i,
  lookup_ip:         /\bip\b\s+\d|geolocaliza|de onde [eé] (esse|este) ip/i,
  convert_currency:  /\b(?:converter|cota[çc][aã]o|c[aâ]mbio)\b|(?:d[oó]lar|euro|libra|real|peso)\s+(?:em|para|hoje)|quanto\s+(?:[eé]|vale)\s+\d+\s+(?:dolares?|euros?|reais)/i,
  crypto_price:      /\b(bitcoin|btc|ethereum|eth|solana|sol\b|usdc|usdt|cripto|cryptocurrency)\b/i,
  search_web:        /\b(?:procur|pesquis|busca|googl|encontre|qual\s+o\s+melhor|me\s+ach)/i,
  scrape_url:        /\b(?:leia|ler|conte[uú]do|baix|scrape)\s+(?:o\s+)?(?:link|url|site|p[aá]gina)|https?:\/\//i,
  summarize_url:     /\bresum(?:e|a|ir)\s+(?:essa|esse|este|esta)?\s*(?:url|link|p[aá]gina|artigo|texto)/i,
  wikipedia_summary: /wikip[eé]dia|biografia de|quem (?:foi|[eé])/i,
  wikipedia_search:  /pesquisar?\s+(?:na\s+)?wiki/i,
  search_arxiv:      /\barxiv\b|paper\s+sobre|artigo cient[ií]fico/i,
  search_hn:         /hacker news|\bhn\b/i,
  github_user:       /\bgithub\b|github\.com|@\w+\s+do\s+github/i,
  mercadolivre_search:/mercado livre|\bmlb\b|qual.+pre[çc]o.+ml\b|comprar\s+(?:no\s+)?ml/i,
  lookup_book:       /\bisbn\b|livro\s+\d{10,13}/i,
  npm_package:       /\bnpm\b|pacote\s+(?:do\s+)?node|\@[\w\-]+\/[\w\-]+/i,
  generate_image:    /\b(?:gera|cri[ae]|fa[çc]a|desenh)\s+(?:uma?\s+)?(?:imagem|foto|figura|desenho|ilustra)|\bimagem\s+de\b/i,
  translate_text:    /\btraduz(?:ir|a)?\b|\btranslate\b|para\s+(?:o\s+)?ingl[eê]s|para\s+(?:o\s+)?espanhol/i,
  detect_language:   /qual\s+idioma|qual\s+(?:[eé]\s+)?(?:a\s+)?l[ií]ngua\s+(?:de|desse|deste|dessa|desta)/i,
  generate_pix:      /\b(?:gera|cri[ae])\s+(?:um\s+)?pix|cobr(?:ar|an[çc]a)|como\s+(?:eu\s+)?pago|forma\s+de\s+pagamento|quero\s+pagar/i,
};
const ALWAYS_ON = ['search_web', 'generate_pix'];

function pickKeywordsOnly(text: string, available: string[]): string[] {
  const lower = text.toLowerCase();
  const picked = new Set<string>();
  for (const [tool, pattern] of Object.entries(TOOL_KEYWORDS)) {
    if (pattern.test(lower)) picked.add(tool);
  }
  for (const tool of ALWAYS_ON) picked.add(tool);
  return available.filter((tool) => picked.has(tool));
}

const ALL = [
  'lookup_cep','lookup_cnpj','lookup_bank','lookup_fipe','ibge_city',
  'brasilapi_holidays','brasilapi_rates','brasilapi_ddd','bcb_indicator',
  'current_weather','weather_forecast','geocode_address','route_distance','lookup_country','lookup_ip',
  'convert_currency','crypto_price',
  'search_web','exa_search','scrape_url','wikipedia_summary','wikipedia_search','search_hn','search_arxiv','github_user',
  'mercadolivre_search','lookup_book','npm_package',
  'generate_image','embed_text','translate_text','detect_language','summarize_url','generate_pix',
];

const cases: [string, string][] = [
  ['qual banco brasileiro tem código 260?', 'lookup_bank'],
  ['quanto está o dólar?', 'convert_currency'],
  ['CEP 01310-100', 'lookup_cep'],
  ['gera uma imagem de gato com chapéu', 'generate_image'],
  ['quero pagar via Pix R$ 50', 'generate_pix'],
  ['feriados de 2026', 'brasilapi_holidays'],
  ['traduza essa mensagem para inglês', 'translate_text'],
  ['distância entre Av Paulista e Av Brigadeiro', 'route_distance'],
  ['CNPJ 11222333000181', 'lookup_cnpj'],
  ['valor do iPhone 13 na FIPE', 'lookup_fipe'],
  ['preço do bitcoin agora', 'crypto_price'],
  ['quem foi Albert Einstein?', 'wikipedia_summary'],
];

for (const [msg, expect] of cases) {
  const picked = pickKeywordsOnly(msg, ALL);
  const tokens = picked.length * 250;
  const fullTokens = ALL.length * 250;
  const savePct = Math.round(100 * (1 - picked.length / ALL.length));
  console.log(`Q: "${msg}"`);
  console.log(`   esperado: ${expect}`);
  console.log(`   picked (${picked.length}): ${picked.join(', ')}`);
  console.log(`   ~${tokens} tokens vs ${fullTokens} total (economia ${savePct}%)`);
  console.log('');
}
