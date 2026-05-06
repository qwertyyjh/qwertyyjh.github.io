import { createSign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_FILE = path.join('i18n', 'ko.json');
const OVERRIDES_FILE = path.join('i18n', 'overrides.json');
const TARGETS = ['en', 'zh-CN', 'ja', 'vi', 'de', 'fr'];
const TRANSLATE_SCOPE = 'https://www.googleapis.com/auth/cloud-translation';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2';
const PUBLIC_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';
const I18N_VARIABLE_TOKENS = new Map([
  ['language', '__I18NVAR0__'],
  ['time', '__I18NVAR1__'],
]);

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
  let out = String(value).replace(/\{(\w+)\}/g, (_, key) => I18N_VARIABLE_TOKENS.get(key) || `__I18NVAR_${key}__`);
  const terms = [...PROTECTED_TERMS].sort((a, b) => b.length - a.length);
  terms.forEach((term, index) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), `__PROTECTED_TERM_${index}__`);
  });
  return out;
}

function restoreTerms(value) {
  let out = value
    .replace(/<span translate="no" data-protected-term="\d+">([\s\S]*?)<\/span>/g, '$1')
    .replace(/&amp;/g, '&');
  const terms = [...PROTECTED_TERMS].sort((a, b) => b.length - a.length);
  terms.forEach((term, index) => {
    out = out.replace(new RegExp(`__PROTECTED_TERM_${index}__`, 'g'), term);
  });
  for (const [key, token] of I18N_VARIABLE_TOKENS.entries()) {
    out = out.replace(new RegExp(token, 'g'), `{${key}}`);
  }
  return out.replace(/__I18NVAR_(\w+)__/g, '{$1}');
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

function parsePublicTranslation(json) {
  if (!Array.isArray(json?.[0])) {
    throw new Error(`Unexpected Google Translate response: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json[0].map((segment) => segment?.[0] || '').join('');
}

async function translatePublicValue(target, value) {
  const url = new URL(PUBLIC_TRANSLATE_URL);
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'ko');
  url.searchParams.set('tl', target);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', protectTerms(value));

  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        throw new Error(`Non-JSON response ${response.status}: ${body.slice(0, 160)}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
      }
      return restoreTerms(parsePublicTranslation(json));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw new Error(`Google Translate fallback failed for ${target}: ${lastError?.message || lastError}`);
}

async function translatePublicBatch(target, entries) {
  const translated = [];
  for (let index = 0; index < entries.length; index += 3) {
    const chunk = entries.slice(index, index + 3);
    const values = await Promise.all(chunk.map(([, value]) => translatePublicValue(target, value)));
    translated.push(...values);
  }
  return translated;
}

async function translateLanguage(target, source, overrides, translateEntries, sourceLabel) {
  const entries = Object.entries(source).filter(([key, value]) => !key.startsWith('_') && typeof value === 'string');
  const translated = {
    _meta: {
      source: sourceLabel,
      sourceLanguage: 'ko',
      language: target,
      generatedAt: new Date().toISOString(),
    },
  };

  for (let index = 0; index < entries.length; index += 100) {
    const batch = entries.slice(index, index + 100);
    const values = await translateEntries(target, batch);
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
  console.warn('Google Cloud Translation credentials are not configured. Using Google Translate fallback without account setup.');
  for (const target of TARGETS) {
    const filePath = path.join('i18n', `${target}.json`);
    const translated = await translateLanguage(
      target,
      source,
      overrides,
      translatePublicBatch,
      'Google Translate fallback'
    );
    await writeFile(filePath, `${JSON.stringify(translated, null, 2)}\n`);
    console.log(`Wrote i18n/${target}.json`);
  }
  process.exit(0);
}

const accessToken = await getAccessToken(serviceAccount);
for (const target of TARGETS) {
  const translated = await translateLanguage(
    target,
    source,
    overrides,
    (language, batch) => translateBatch(accessToken, language, batch),
    'Google Cloud Translation API'
  );
  await writeFile(path.join('i18n', `${target}.json`), `${JSON.stringify(translated, null, 2)}\n`);
  console.log(`Wrote i18n/${target}.json`);
}
