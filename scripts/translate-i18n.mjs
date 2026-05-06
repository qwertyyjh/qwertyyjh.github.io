import { createSign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_FILE = path.join('i18n', 'ko.json');
const OVERRIDES_FILE = path.join('i18n', 'overrides.json');
const TARGETS = ['en', 'zh-CN', 'ja', 'vi', 'de', 'fr'];
const TRANSLATE_SCOPE = 'https://www.googleapis.com/auth/cloud-translation';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2';

const PROTECTED_TERMS = [
  'TIGER 코리아 AI 전력기기 TOP3 플러스',
  'TIGER Korea AI Elec Pwr Equip TOP3 Plus',
  'TIGER AI전력기기',
  'TIGER AI 전력기기',
  'KODEX 200TR',
  'KODEX 200',
  'TIGER',
  'KODEX',
  'KOSPI',
  'KOSDAQ',
  'ETF',
  'HBM3E',
  'HBM4',
  'HBM',
  'NAV',
  'DCA',
  'AI',
  'IRA',
  'NATO',
  'KASA',
  'LEO',
  'TSMC',
  'GDP',
  'TWh',
  'PBR',
  'LS일렉트릭',
  'HD현대일렉트릭',
  '효성중공업',
  '가온전선',
  '일진전기',
  '삼성전자',
  'SK하이닉스',
  '현대차',
  'KB금융',
  '기아',
  '한미반도체',
  '한화에어로',
  '한국항공우주',
  'LIG넥스원',
  '현대로템',
  '한화오션',
  '한화시스템',
  'HD현대중공업',
  'HD한국조선',
  'HD현대미포',
  '인텔리안테크',
  '쎄트렉아이',
  'AP위성',
];

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function serviceAccountFromEnv() {
  const raw = process.env.GOOGLE_TRANSLATE_SERVICE_ACCOUNT_JSON;
  if (raw) return JSON.parse(raw);

  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentialsPath) {
    return JSON.parse(awaitableRead(credentialsPath));
  }

  return null;
}

function awaitableRead(filePath) {
  throw new Error(`GOOGLE_APPLICATION_CREDENTIALS is not supported synchronously here: ${filePath}`);
}

async function loadServiceAccount() {
  if (process.env.GOOGLE_TRANSLATE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_TRANSLATE_SERVICE_ACCOUNT_JSON);
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return JSON.parse(await readFile(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
  }
  return null;
}

function createJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: serviceAccount.client_email,
    scope: TRANSLATE_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${base64url(signer.sign(serviceAccount.private_key))}`;
}

async function getAccessToken(serviceAccount) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: createJwt(serviceAccount),
    }),
  });
  const json = await response.json();
  if (!response.ok || !json.access_token) {
    throw new Error(`Google OAuth failed: ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

function protectTerms(value) {
  let out = value;
  const terms = [...PROTECTED_TERMS].sort((a, b) => b.length - a.length);
  terms.forEach((term, index) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), `<span translate="no" data-protected-term="${index}">${term}</span>`);
  });
  return out;
}

function restoreTerms(value) {
  return value
    .replace(/<span translate="no" data-protected-term="\d+">([\s\S]*?)<\/span>/g, '$1')
    .replace(/&amp;/g, '&');
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = { ...base };
  Object.entries(patch).forEach(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  });
  return out;
}

async function translateBatch(accessToken, target, entries) {
  const response = await fetch(TRANSLATE_URL, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      q: entries.map(([, value]) => protectTerms(value)),
      source: 'ko',
      target,
      format: 'html',
    }),
  });
  const json = await response.json();
  if (!response.ok || !json.data?.translations) {
    throw new Error(`Google Translation failed for ${target}: ${JSON.stringify(json)}`);
  }
  return json.data.translations.map((item) => restoreTerms(item.translatedText));
}

async function translateLanguage(accessToken, target, source, overrides) {
  const entries = Object.entries(source).filter(([key, value]) => !key.startsWith('_') && typeof value === 'string');
  const translated = {
    _meta: {
      source: 'Google Cloud Translation API',
      sourceLanguage: 'ko',
      language: target,
      generatedAt: new Date().toISOString(),
    },
  };

  for (let index = 0; index < entries.length; index += 100) {
    const batch = entries.slice(index, index + 100);
    const values = await translateBatch(accessToken, target, batch);
    batch.forEach(([key], valueIndex) => {
      translated[key] = values[valueIndex];
    });
  }

  return deepMerge(translated, overrides[target] || {});
}

async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

const source = await readJson(SOURCE_FILE);
const overrides = await readJson(OVERRIDES_FILE);
const serviceAccount = await loadServiceAccount();

await mkdir('i18n', { recursive: true });

if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
  const generatedAt = new Date().toISOString();
  for (const target of TARGETS) {
    const filePath = path.join('i18n', `${target}.json`);
    await writeFile(filePath, `${JSON.stringify({
      _meta: {
        source: 'pending',
        language: target,
        generatedAt,
        message: 'Google Cloud Translation credentials are not configured yet.',
      },
    }, null, 2)}\n`);
  }
  console.warn('Google Cloud Translation credentials are not configured. Wrote pending i18n files.');
  process.exit(0);
}

const accessToken = await getAccessToken(serviceAccount);
for (const target of TARGETS) {
  const translated = await translateLanguage(accessToken, target, source, overrides);
  await writeFile(path.join('i18n', `${target}.json`), `${JSON.stringify(translated, null, 2)}\n`);
  console.log(`Wrote i18n/${target}.json`);
}
