import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import https from 'https';
import pdfParse from 'pdf-parse';
import cookieParser from 'cookie-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== FIXED PUBLIC DRIVE FOLDER (hidden) ======
const FIXED_FOLDER_URL =
  'https://drive.google.com/drive/folders/1YQmBC9LXDdMe9qm4G0wnUZToMBmDM7wB?usp=sharing';
// =================================================

// ====== SIMPLE PASSWORD (hardcoded as requested) ======
const APP_PASSWORD = 'tamimi202';
// (Best practice is ENV, but using your requested fixed value here.)
// =======================================================

// ---------- helpers ----------
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ body: buf });
          else reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        });
      })
      .on('error', reject);
  });
}

async function expandPublicFolderToLinks(folderUrl) {
  try {
    const r = await httpsGet(folderUrl);
    const html = r.body.toString('utf8');
    const ids = new Set();
    const regexes = [
      /\u002Ffile\u002Fd\u002F([a-zA-Z0-9_-]{10,})/g,
      /\/file\/d\/([a-zA-Z0-9_-]{10,})/g,
      /\/document\/d\/([a-zA-Z0-9_-]{10,})/g,
      /\/spreadsheets\/d\/([a-zA-Z0-9_-]{10,})/g
    ];
    for (const rx of regexes) {
      let m; while ((m = rx.exec(html))) ids.add(m[1]);
    }
    return Array.from(ids).map(id => `https://drive.google.com/file/d/${id}/view`);
  } catch {
    return [];
  }
}

function extractDriveId(input) {
  const pats = [
    /\/d\/([a-zA-Z0-9_-]{10,})/,
    /id=([a-zA-Z0-9_-]{10,})/,
    /file\/d\/([a-zA-Z0-9_-]{10,})/,
    /^([a-zA-Z0-9_-]{15,})$/
  ];
  for (const rx of pats) {
    const m = (input || '').match(rx);
    if (m) return m[1];
  }
  return null;
}

async function exportPublicDocTxt(id) {
  const url = `https://docs.google.com/document/d/${id}/export?format=txt`;
  const r = await httpsGet(url);
  return r.body.toString('utf8');
}
async function exportPublicSheetCsv(id) {
  const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
  const r = await httpsGet(url);
  return r.body.toString('utf8');
}
async function downloadPublicBinary(id) {
  const url = `https://drive.google.com/uc?export=download&id=${id}`;
  const r = await httpsGet(url);
  return r.body;
}

async function buildContextFromPublicLinks(links = []) {
  const out = [];
  for (const raw of links) {
    const id = extractDriveId((raw || '').trim());
    if (!id) continue;

    let handled = false;
    try {
      const t = await exportPublicDocTxt(id);
      if (t?.trim()) { out.push(`\n===== DOC: ${id} =====\n${t}`); handled = true; }
    } catch {}
    if (handled) continue;

    try {
      const t = await exportPublicSheetCsv(id);
      if (t?.trim()) { out.push(`\n===== SHEET CSV: ${id} =====\n${t}`); handled = true; }
    } catch {}
    if (handled) continue;

    try {
      const buf = await downloadPublicBinary(id);
      try {
        const parsed = await pdfParse(buf);
        if (parsed.text?.trim()) { out.push(`\n===== PDF: ${id} =====\n${parsed.text}`); handled = true; }
      } catch {}
      if (!handled) {
        const asText = buf.toString('utf8');
        if (asText.trim()) out.push(`\n===== RAW: ${id} =====\n${asText}`);
      }
    } catch {}
  }
  return out.join('\n').slice(0, 180000);
}

// cache folder listing (refresh every 6h)
let cachedLinks = [];
let lastRefresh = 0;
async function getCachedLinks() {
  const now = Date.now();
  if (!cachedLinks.length || now - lastRefresh > 6 * 60 * 60 * 1000) {
    console.log('🔄 Refreshing Drive folder file list…');
    cachedLinks = await expandPublicFolderToLinks(FIXED_FOLDER_URL);
    lastRefresh = now;
    console.log(`✅ Loaded ${cachedLinks.length} file links`);
  }
  return cachedLinks;
}

// ---------- policy guards ----------
const financialRegex = new RegExp(
  [
    'financial','finance','cost','costs','price','prices','pricing','budget','budgets','estimate','estimation',
    'invoice','invoices','payment','payments','fee','fees','quote','quotes','bid','bids','bidding',
    'markup','mark-up','contingency','allowance','capex','opex','unit price','labor rate','material cost',
    '\\$\\s*\\d','usd','dollar','dollars','change order','co','pay app','pay application'
  ].join('|'),
  'i'
);

const platformProbeRegex = /(openai|api key|api provider|gpt|model name|who hosts you|are you connected|google drive|drive link|data source)/i;

// ---------- password endpoints & guard ----------
// login page served below (route '/login'), this is the API to set cookie
app.post('/api/login', (req, res) => {
  try {
    const { password } = req.body || {};
    if (password && password === APP_PASSWORD) {
      res.cookie('auth', 'ok', {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24h
      });
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Invalid password' });
  } catch {
    res.status(500).json({ error: 'Login failed' });
  }
});

// gate APIs (except login) behind cookie
app.use((req, res, next) => {
  if (
    req.method === 'POST' && req.path === '/api/login'
  ) return next();

  // allow static assets & login page without cookie
  if (
    req.path.startsWith('/public') ||
    req.path.startsWith('/favicon') ||
    req.path === '/login' ||
    req.path === '/favicon.ico'
  ) return next();

  // allow only if authenticated
  if (req.headers.cookie && req.headers.cookie.includes('auth=ok')) return next();

  // not authed → if requesting root or anything HTML, send login
  if (req.method === 'GET') {
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
  return res.status(403).json({ error: 'Access denied' });
});

// ---------- chat endpoint ----------
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body || {};
    const question = (message || '').trim();
    if (!question) return res.status(400).json({ error: 'No message given' });

    // 1) Block financial/cost questions
    if (financialRegex.test(question)) {
      return res.json({ reply: 'Financial questions needs admin permission.' });
    }

    // 2) Hide platform/connection details
    if (platformProbeRegex.test(question)) {
      return res.json({ reply: "I'm an internal project assistant and can't discuss system implementation details." });
    }

    // 3) Build context and answer
    const fileLinks = await getCachedLinks();
    const context = await buildContextFromPublicLinks(fileLinks);

    const system = `You are a helpful internal assistant. Answer ONLY using the provided context from project documents. If the answer is not present, say you don't know. Do not mention providers, APIs, or data source locations.`;
    const userPrompt = `Question: ${question}\n\nContext:\n${context}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt }
      ]
    });

    const reply = completion.choices?.[0]?.message?.content || 'No reply';
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Chat failed' });
  }
});

// ---------- page routes ----------
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// root → if authed, serve chat; else login (handled by guard above)
app.get('/', (req, res) => {
  if (req.headers.cookie && req.headers.cookie.includes('auth=ok')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// fallback
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ OHLA GPT running on http://localhost:${PORT}`));
