import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUTPUT_PATH = path.join('data', 'korea-stockmarket-quotes.json');

const KOSDAQ_TICKERS = new Set([
  '403870', '058470', '052520', '357780', '240810', '095340', '214430',
  '033500', '333430', '189300', '099320', '211270', '274090', '361390',
  '451760', '042370',
]);

const TOP_QUOTES = [
  { id: 'kospi', name: 'KOSPI', symbol: '^KS11', isIndex: true },
  { id: 'kosdaq', name: 'KOSDAQ', symbol: '^KQ11', isIndex: true },
  { id: 'samsung', name: '삼성전자', symbol: '005930.KS' },
  { id: 'sk', name: 'SK하이닉스', symbol: '000660.KS' },
  { id: 'tiger', name: 'TIGER 코리아 AI 전력기기 TOP3 플러스', symbol: '0117V0.KS' },
  { id: 'kodex200', name: 'KODEX 200', symbol: '069500.KS' },
  { id: 'kodex200tr', name: 'KODEX 200TR', symbol: '278530.KS' },
];

const STOCK_GROUPS = {
  semi: [
    ['삼성전자', '005930'], ['SK하이닉스', '000660'], ['한미반도체', '042700'],
    ['HPSP', '403870'], ['이수페타시스', '007660'], ['리노공업', '058470'],
    ['동진쎄미켐', '052520'], ['솔브레인', '357780'], ['원익IPS', '240810'],
    ['ISC', '095340'],
  ],
  def: [
    ['한화에어로', '012450'], ['한국항공우주', '047810'], ['LIG넥스원', '079550'],
    ['현대로템', '064350'], ['한화오션', '042660'], ['한화시스템', '272210'],
    ['풍산', '103140'], ['SNT모티브', '064960'], ['아이쓰리시스', '214430'],
    ['휴니드', '005870'],
  ],
  ship: [
    ['HD현대중공업', '329180'], ['HD한국조선', '009540'], ['삼성중공업', '010140'],
    ['한화오션', '042660'], ['HD현대미포', '010620'], ['한화엔진', '082740'],
    ['한국카본', '017960'], ['동성화인텍', '033500'], ['세진중공업', '075580'],
    ['일승', '333430'],
  ],
  aero: [
    ['한화에어로', '012450'], ['한국항공우주', '047810'], ['인텔리안테크', '189300'],
    ['쎄트렉아이', '099320'], ['AP위성', '211270'], ['한화시스템', '272210'],
    ['켄코아에어로', '274090'], ['제노코', '361390'], ['컨텍', '451760'],
    ['비츠로테크', '042370'],
  ],
};

function yahooSymbolForTicker(ticker) {
  return `${ticker}.${KOSDAQ_TICKERS.has(ticker) ? 'KQ' : 'KS'}`;
}

function alternateYahooSymbolForTicker(ticker) {
  return `${ticker}.${KOSDAQ_TICKERS.has(ticker) ? 'KS' : 'KQ'}`;
}

function uniqueQuotes() {
  const quotes = [...TOP_QUOTES];
  const seen = new Set(quotes.map((quote) => quote.symbol));

  Object.values(STOCK_GROUPS).flat().forEach(([name, ticker]) => {
    const symbol = yahooSymbolForTicker(ticker);
    if (seen.has(symbol)) return;
    seen.add(symbol);
    quotes.push({ id: ticker, name, symbol, alternateSymbol: alternateYahooSymbolForTicker(ticker) });
  });

  return quotes;
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function firstNumber(values) {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    const num = toNumber(value);
    if (num !== null) return num;
  }
  return null;
}

async function fetchYahooSymbol(symbol) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set('interval', '1m');
  url.searchParams.set('range', '1d');
  url.searchParams.set('_', Date.now().toString());

  const response = await fetch(url, {
    headers: {
      'accept': 'application/json',
      'user-agent': 'Mozilla/5.0 qwertyyjh-github-pages-market-data/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Yahoo Finance HTTP ${response.status} for ${symbol}`);
  }

  const json = await response.json();
  const result = json?.chart?.result?.[0];
  if (!result?.meta) {
    const message = json?.chart?.error?.description || `Yahoo Finance returned no chart data for ${symbol}`;
    throw new Error(message);
  }
  return result;
}

async function fetchYahooQuote(quote) {
  const symbols = [quote.symbol, quote.alternateSymbol].filter(Boolean);
  const errors = [];
  let result = null;
  let resolvedSymbol = quote.symbol;

  for (const symbol of symbols) {
    try {
      result = await fetchYahooSymbol(symbol);
      resolvedSymbol = symbol;
      break;
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (!result) {
    throw new Error(errors.join('; '));
  }

  const meta = result.meta;
  const series = result.indicators?.quote?.[0];
  const price = toNumber(meta.regularMarketPrice);
  const closeyest = toNumber(meta.previousClose) ?? toNumber(meta.chartPreviousClose);
  const priceopen = toNumber(meta.regularMarketOpen) ?? firstNumber(series?.open);

  if (price === null) {
    throw new Error(`Yahoo Finance returned no price for ${resolvedSymbol}`);
  }

  const change = closeyest !== null ? price - closeyest : null;
  const changepct = change !== null && closeyest ? (change / closeyest) * 100 : null;

  return {
    id: quote.id,
    name: quote.name,
    ticker: resolvedSymbol,
    price,
    priceopen,
    closeyest,
    change,
    changepct,
    tradetime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : '',
    datadelay: '',
    status: 'OK',
    source: 'Yahoo Finance',
  };
}

async function loadPreviousPayload() {
  try {
    return JSON.parse(await readFile(OUTPUT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

const startedAt = new Date().toISOString();
const settled = await Promise.allSettled(uniqueQuotes().map(fetchYahooQuote));
const quotes = settled
  .filter((item) => item.status === 'fulfilled')
  .map((item) => item.value)
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));
const errors = settled
  .filter((item) => item.status === 'rejected')
  .map((item) => item.reason?.message || String(item.reason));

if (!quotes.length) {
  const previous = await loadPreviousPayload();
  if (previous?.quotes?.length) {
    previous.generatedAt = startedAt;
    previous.source = 'Yahoo Finance';
    previous.stale = true;
    previous.errors = errors.length ? errors : ['All quote requests failed; kept previous snapshot.'];
    await writeFile(OUTPUT_PATH, `${JSON.stringify(previous, null, 2)}\n`);
    console.warn('All quote requests failed; kept previous snapshot.');
    process.exit(0);
  }
  throw new Error(`No quote data was loaded. Errors: ${errors.join('; ')}`);
}

const payload = {
  generatedAt: startedAt,
  source: 'Yahoo Finance',
  stale: false,
  quoteCount: quotes.length,
  errors,
  quotes,
};

await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote ${quotes.length} quotes to ${OUTPUT_PATH}.`);
if (errors.length) {
  console.warn(`${errors.length} quote request(s) failed.`);
}
