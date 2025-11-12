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

// ================== CONFIG ==================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Fixed public Drive folder (hidden)
const FIXED_FOLDER_URL =
  'https://drive.google.com/drive/folders/1YQmBC9LXDdMe9qm4G0wnUZToMBmDM7wB?usp=sharing';

// Site password (gate to view the site)
const APP_PASSWORD = 'tamimi202';

// Admin password for finance questions
const FINANCE_PASSWORD = 'tamimi202';
// ===========================================

// ---------- helpers ----------
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ body: buf });
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    }).on('error', reject);
  });
}

// ---------- Drive scraping ----------
async function expandPublicFolderToLinks(folderUrl) {
  try {
    const r = await httpsGet(folderUrl);
    const html = r.body.toString('utf8');
    const ids = new Set();
    const rxes = [
      /\u002Ffile\u002Fd\u002F([a-zA-Z0-9_-]{10,})/g,
      /\/file\/d\/([a-zA-Z0-9_-]{10,})/g,
      /\/document\/d\/([a-zA-Z0-9_-]{10,})/g,
      /\/spreadsheets\/d\/([a-zA-Z0-9_-]{10,})/g
    ];
    for (const rx of rxes) { let m; while ((m = rx.exec(html))) ids.add(m[1]); }
    return [...ids].map(id => `https://drive.google.com/file/d/${id}/view`);
  } catch { return []; }
}

function extractDriveId(s) {
  const rxes = [
    /\/d\/([a-zA-Z0-9_-]{10,})/,
    /id=([a-zA-Z0-9_-]{10,})/,
    /file\/d\/([a-zA-Z0-9_-]{10,})/,
    /^([a-zA-Z0-9_-]{15,})$/
  ];
  for (const rx of rxes) { const m = (s||'').match(rx); if (m) return m[1]; }
  return null;
}

async function exportPublicDocTxt(id) {
  const r = await httpsGet(`https://docs.google.com/document/d/${id}/export?format=txt`);
  return r.body.toString('utf8');
}
async function exportPublicSheetCsv(id) {
  const r = await httpsGet(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv`);
  return r.body.toString('utf8');
}
async function downloadPublicBinary(id) {
  const r = await httpsGet(`https://drive.google.com/uc?export=download&id=${id}`);
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
      if (t?.trim()) { out.push(`\n===== DOC ${id} =====\n${t}`); handled = true; }
    } catch {}
    if (handled) continue;

    try {
      const t = await exportPublicSheetCsv(id);
      if (t?.trim()) { out.push(`\n===== SHEET ${id} =====\n${t}`); handled = true; }
    } catch {}
    if (handled) continue;

    try {
      const buf = await downloadPublicBinary(id);
      try {
        const parsed = await pdfParse(buf);
        if (parsed.text?.trim()) { out.push(`\n===== PDF ${id} =====\n${parsed.text}`); handled = true; }
      } catch {}
      if (!handled) {
        const asText = buf.toString('utf8');
        if (asText.trim()) out.push(`\n===== RAW ${id} =====\n${asText}`);
      }
    } catch {}
  }
  return out.join('\n').slice(0, 180000);
}

// cache
let cachedLinks = []; let lastRefresh = 0;
async function getCachedLinks() {
  const now = Date.now();
  if (!cachedLinks.length || now - lastRefresh > 6*60*60*1000) {
    console.log('🔄 Refreshing Drive folder file list…');
    cachedLinks = await expandPublicFolderToLinks(FIXED_FOLDER_URL);
    lastRefresh = now;
    console.log(`✅ Loaded ${cachedLinks.length} file links`);
  }
  return cachedLinks;
}

// ---------- policies ----------
const financialRegex = new RegExp(
  [
    'financial','finance','cost','price','budget','estimate','invoice','payment','fee','quote','bid',
    'markup','allowance','capex','opex','unit price','labor rate','material cost',
    '\\$\\s*\\d','usd','dollar','change order','pay app','pay application'
  ].join('|'),'i'
);
const platformProbeRegex = /(openai|api key|api provider|gpt|model|google drive|data source)/i;
const smallTalkRegex = /(hello|hi|hey|good (morning|afternoon|evening)|help|test)$/i;

// ---------- auth endpoints ----------
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password === APP_PASSWORD) {
    res.cookie('auth', 'ok', { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 24*60*60*1000 });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid password' });
});

app.post('/api/finance-auth', (req, res) => {
  const { password } = req.body || {};
  if (password === FINANCE_PASSWORD) {
    res.cookie('fin', 'ok', { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 15*60*1000 });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid finance password' });
});

// ---------- guard ----------
app.use((req, res, next) => {
  if (req.method === 'POST' && (req.path === '/api/login' || req.path === '/api/finance-auth')) return next();
  if (req.path.startsWith('/static/') || req.path === '/favicon.ico' || req.path === '/login') return next();
  const authed = req.headers.cookie && req.headers.cookie.includes('auth=ok');
  if (!authed) {
    if (req.method === 'GET') return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
});

app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// ---------- CHAT ----------
app.post('/api/chat', async (req, res) => {
  try {
    const { message, withWeb, financeOk } = req.body || {};
    const q = (message || '').trim();
    if (!q) return res.status(400).json({ error: 'No message' });

    const hasFinanceCookie = req.headers.cookie && req.headers.cookie.includes('fin=ok');
    if (financialRegex.test(q) && !(hasFinanceCookie || financeOk)) {
      return res.json({ reply: 'Financial questions needs admin permission.', requiresFinanceAuth: true });
    }

    if (platformProbeRegex.test(q))
      return res.json({ reply: "I'm an internal project assistant and can't discuss system design." });

    if (smallTalkRegex.test(q))
      return res.json({ reply: "Hello! I’m your I-5 project assistant. Ask me about topics in the shared project documents." });

    if (withWeb) {
      const g = await openai.chat.completions.create({
        model: 'gpt-4o-mini', temperature: 0.3,
        messages: [{ role: 'system', content: 'Answer accurately, without revealing internal systems.' },
                   { role: 'user', content: q }]
      });
      return res.json({ reply: g.choices?.[0]?.message?.content || 'No reply' });
    }

    const links = await getCachedLinks();
    const context = await buildContextFromPublicLinks(links);
    const system = "You are a project assistant. Use ONLY the provided project context. If context doesn't contain answer, reply exactly 'NO_MATCH'.";
    const userPrompt = `Question: ${q}\n\nContext:\n${context}`;

    const ans = await openai.chat.completions.create({
      model: 'gpt-4o-mini', temperature: 0.1,
      messages: [{ role: 'system', content: system }, { role: 'user', content: userPrompt }]
    });

    const driveReply = ans.choices?.[0]?.message?.content?.trim() || '';
    if (!context || driveReply.toUpperCase() === 'NO_MATCH' || driveReply.toLowerCase().includes("i don't know"))
      return res.json({ reply: "I couldn’t find this in the project documents. Do you want me to check the internet?", offerWeb: true });

    res.json({ reply: driveReply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Chat failed' });
  }
});

// ---------- pages ----------
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('*', (_req, res) => res.redirect('/'));

// ---------- start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ OHLA GPT running on :${PORT}`));
