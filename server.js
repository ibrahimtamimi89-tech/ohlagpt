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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==== fixed Drive folder (hidden) ====
const FIXED_FOLDER_URL = 'https://drive.google.com/drive/folders/1YQmBC9LXDdMe9qm4G0wnUZToMBmDM7wB?usp=sharing';
// ==== password (as requested) ====
const APP_PASSWORD = 'tamimi202';

// ---------------- helpers ----------------
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ body: buf });
        else reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      });
    }).on('error', reject);
  });
}

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
    const id = extractDriveId((raw||'').trim());
    if (!id) continue;
    let handled = false;
    try { const t = await exportPublicDocTxt(id); if (t?.trim()) { out.push(`\n===== DOC ${id} =====\n${t}`); handled = true; } } catch {}
    if (handled) continue;
    try { const t = await exportPublicSheetCsv(id); if (t?.trim()) { out.push(`\n===== SHEET ${id} =====\n${t}`); handled = true; } } catch {}
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

// cache Drive list
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

// -------- policies --------
const financialRegex = new RegExp(
  [
    'financial','finance','cost','costs','price','prices','pricing','budget','budgets','estimate','estimation',
    'invoice','invoices','payment','payments','fee','fees','quote','quotes','bid','bids','bidding',
    'markup','mark-up','contingency','allowance','capex','opex','unit price','labor rate','material cost',
    '\\$\\s*\\d','usd','dollar','dollars','change order','co','pay app','pay application'
  ].join('|'),'i'
);
const platformProbeRegex = /(openai|api key|api provider|gpt|model name|who hosts you|are you connected|google drive|drive link|data source)/i;

// -------- password routes & guard --------
app.post('/api/login', (req, res) => {
  try {
    const { password } = req.body || {};
    if (password && password === APP_PASSWORD) {
      res.cookie('auth','ok',{ httpOnly:true, sameSite:'lax', secure:process.env.NODE_ENV==='production', maxAge:24*60*60*1000 });
      return res.json({ ok:true });
    }
    res.status(401).json({ error:'Invalid password' });
  } catch { res.status(500).json({ error:'Login failed' }); }
});

// protect everything HTML/API except login & static assets (added later)
app.use((req, res, next) => {
  // allow login API
  if (req.method==='POST' && req.path==='/api/login') return next();
  // allow static files (they’ll be mounted at /static)
  if (req.path.startsWith('/static/') || req.path==='/favicon.ico') return next();
  // allow login page
  if (req.path==='/login') return next();

  const authed = req.headers.cookie && req.headers.cookie.includes('auth=ok');
  if (!authed) {
    if (req.method==='GET') return res.sendFile(path.join(__dirname,'public','login.html'));
    return res.status(403).json({ error:'Access denied' });
  }
  next();
});

// mount static files AFTER guard, under /static
app.use('/static', express.static(path.join(__dirname,'public'), { maxAge: '1h' }));

// chat endpoint (protected)
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body || {};
    const q = (message||'').trim();
    if (!q) return res.status(400).json({ error:'No message' });

    if (financialRegex.test(q)) {
      return res.json({ reply: 'Financial questions needs admin permission.' });
    }
    if (platformProbeRegex.test(q)) {
      return res.json({ reply: "I'm an internal project assistant and can't discuss system implementation details." });
    }

    const fileLinks = await getCachedLinks();
    const context = await buildContextFromPublicLinks(fileLinks);

    const system = `You are a helpful internal assistant. Answer ONLY using the provided context from project documents. If not present, say you don't know. Do not mention providers, APIs, or data sources.`;
    const userPrompt = `Question: ${q}\n\nContext:\n${context}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [{ role:'system', content:system }, { role:'user', content:userPrompt }]
    });

    res.json({ reply: completion.choices?.[0]?.message?.content || 'No reply' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error:'Chat failed' });
  }
});

// pages
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname,'public','login.html')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

// fallback
app.get('*', (_req, res) => res.redirect('/'));

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ OHLA GPT running on :${PORT}`));
