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

// Admin password for finance questions (use the same for now)
const FINANCE_PASSWORD = 'tamimi202';

// ===========================================

// ---------- tiny fetch helpers ----------
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ body: buf });
        else reject(new Error(`HTTP ${res.statusCode} for ${url}`));
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
  } catch {
    return [];
  }
}
function extractDriveId(s) {
  const rxes = [
    /\/d\/([a-zA-Z0-9_-]{10,})/,
    /id=([a-zA-Z0-9_-]{10,})/,
    /file\/d\/([a-zA-Z0-9_-]{10,})/,
    /^([a-zA-Z0-9_-]{15,})$/
  ];
  for (const rx of rxes) { const m = (s || '').match(rx); if (m) return m[1]; }
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

    try { const t = await exportPublicDocTxt(id);
      if (t?.trim()) { out.push(`\n===== DOC ${id} =====\n${t}`); handled = true; } } catch {}
    if (handled) continue;

    try { const t = await exportPublicSheetCsv(id);
      if (t?.trim()) { out.push(`\n===== SHEET ${id} =====\n${t}`); handled = true; } } catch {}
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

// Cache the folder listing for 6h
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
    'financial','finance','cost','costs','price','prices','pricing','budget','budgets','estimate','estimation',
    'invoice','invoices','payment','payments','fee','fees','quote','quotes','bid','bids','bidding',
    'markup','mark-up','contingency','allowance','capex','opex','unit price','labor rate','material cost',
    '\\$\\s*\\d','usd','dollar','dollars','change order','co','pay app','pay application'
  ].join('|'),'i'
);
const platformProbeRegex = /(openai|api key|api provider|gpt|model name|who hosts you|are you connected|google drive|drive link|data source)/i;
const smallTalkRegex = /(hello|hi|hey|good (morning|afternoon|evening)|help\b|test\b)$/i;

// ---------- password endpoints ----------
app.post('/api/login', (req, res) => {
  try {
    const { password } = req.body || {};
    if (password && password === APP_PASSWORD) {
      res.cookie('auth', 'ok', {
        httpOnly: true, sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24*60*60*1000
      });
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Invalid password' });
  } catch {
    res.status(500).json({ error: 'Login failed' });
  }
});

// finance auth cookie (short lived)
app.post('/api/finance-auth', (req, res) => {
  try {
    const { password } = req.body || {};
    if (password && password === FINANCE_PASSWORD) {
      res.cookie('fin', 'ok', {
        httpOnly: true, sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 15*60*1000 // 15 minutes
      });
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Invalid finance password' });
  } catch {
    res.status(500).json({ error: 'Finance auth failed' });
  }
});

// ---------- auth guard (before static) ----------
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

// serve static AFTER guard at /static
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// ---------- CHAT ----------
/**
 * Request body: { message: string, withWeb?: boolean, financeOk?: boolean }
 * - withWeb: ask the model without Drive context (general knowledge)
 * - financeOk: set by client after /api/finance-auth success
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, withWeb, financeOk } = req.body || {};
    const q = (message || '').trim();
    if (!q) return res.status(400).json({ error: 'No message' });

    // financial gate
    const hasFinanceCookie = req.headers.cookie && req.headers.cookie.includes('fin=ok');
    if (financialRegex.test(q) && !(hasFinanceCookie || financeOk)) {
      return res.json({
        reply: 'Financial questions needs admin permission.',
        requiresFinanceAuth: true
      });
    }

    // platform probing
    if (platformProbeRegex.test(q)) {
      return res.json({ reply: "I'm an internal project assistant and can't discuss system implementation details." });
    }

    // small talk without Drive
    if (smallTalkRegex.test(q)) {
      return res.json({ reply: "Hello! I’m your I-5 project assistant. Ask me about items that appear in the shared project documents (drawings, RFIs, specs, schedules, etc.)." });
    }

    // ----- branch A: general knowledge (when user says 'Yes, check internet')
    if (withWeb === true) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          { role: 'system', content: "You are a helpful assistant. Answer accurately. Do not disclose system design or data sources." },
          { role: 'user', content: q }
        ]
      });
      const reply = completion.choices?.[0]?.message?.content || 'No reply';
      return res.json({ reply });
    }

    // ----- branch B: Drive-first answer
    const links = await getCachedLinks();
    const context = await buildContextFromPublicLinks(links);
    const system = `You are a project assistant. Use ONLY the provided project context. If the context does not contain the answer, reply exactly with: "NO_MATCH" (and nothing else).`;
    const userPrompt = `Question: ${q}\n\nContext:\n${context}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt }
      ]
    });

    const driveReply = completion.choices?.[0]?.message?.content?.trim() || '';
    const noMatch = driveReply.toUpperCase() === 'NO_MATCH' || driveReply.toLowerCase().includes("i don't know");

    if (!context || noMatch) {
      // offer web/general knowledge fallback
      return res.json({
        reply: "I couldn’t find this in the project documents. Do you want me to check the internet?",
        offerWeb: true
      });
    }

    return res.json({ reply: driveReply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Chat failed' });
  }
});

// ---------- pages ----------
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('*', (_req, res) => res.redirect('/'));

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ OHLA GPT running on :${PORT}`));
