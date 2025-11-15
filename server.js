import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import OpenAI from 'openai';
import pdfParse from 'pdf-parse';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { Readable } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// -------------------- CONFIG --------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = process.env.S3_PREFIX || ''; // e.g. "GPT Files/"

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-2',
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      : undefined
});

// site login password
const APP_PASSWORD = 'tamimi202';
// extra password for finance questions
const FINANCE_PASSWORD = 'tamimi202';

// -------------------- UTILS --------------------
const streamToBuffer = async (stream) => {
  if (Buffer.isBuffer(stream)) return stream;
  const reader = stream instanceof Readable ? stream : Readable.from(stream);
  const chunks = [];
  for await (const chunk of reader) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const extOf = (key = '') => {
  const m = key.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
};

const textFromBuffer = async (buf, keyHint = '') => {
  const e = extOf(keyHint);

  // text-like
  if (['txt', 'md', 'csv', 'log', 'json'].includes(e)) {
    return buf.toString('utf8');
  }

  // pdf
  if (e === 'pdf') {
    try {
      const parsed = await pdfParse(buf);
      return parsed.text || '';
    } catch {
      return '';
    }
  }

  // docx
  if (e === 'docx') {
    try {
      const res = await mammoth.extractRawText({ buffer: buf });
      return res.value || '';
    } catch {
      return '';
    }
  }

  // xlsx
  if (e === 'xlsx') {
    try {
      const wb = XLSX.read(buf, { type: 'buffer' });
      const sheetNames = wb.SheetNames || [];
      let out = '';
      for (const name of sheetNames) {
        const ws = wb.Sheets[name];
        if (!ws) continue;
        const csv = XLSX.utils.sheet_to_csv(ws);
        out += `\n\n===== SHEET: ${name} =====\n${csv}`;
        if (out.length > 30000) break; // cap per workbook
      }
      return out;
    } catch {
      return '';
    }
  }

  // fallback: try utf8
  try {
    return buf.toString('utf8');
  } catch {
    return '';
  }
};

const listAllKeys = async (prefix = '') => {
  const keys = [];
  let ContinuationToken;

  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix || undefined,
        ContinuationToken
      })
    );

    (resp.Contents || []).forEach((o) => {
      if (o.Key && !o.Key.endsWith('/')) keys.push(o.Key);
    });

    ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (ContinuationToken);

  return keys;
};

const getObjectBuffer = async (key) => {
  const resp = await s3.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key
    })
  );
  return streamToBuffer(resp.Body);
};

const buildContextFromS3 = async (prefix = '') => {
  const keys = await listAllKeys(prefix);
  // newest-ish first (simple sort; you can improve later)
  keys.sort();

  const chunks = [];
  let total = 0;

  for (const key of keys) {
    try {
      const buf = await getObjectBuffer(key);
      const text = await textFromBuffer(buf, key);
      if (!text?.trim()) continue;

      const header = `\n\n===== FILE: ${key} =====\n`;
      const piece = header + text;
      chunks.push(piece);
      total += piece.length;
      if (total > 180000) break; // cap
    } catch (e) {
      console.error('Error reading S3 key', key, e.message);
    }
  }

  return chunks.join('');
};

// simple 6h cache
let cachedContext = '';
let cachedContextTime = 0;
const getCachedS3Context = async () => {
  const now = Date.now();
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (!cachedContext || now - cachedContextTime > SIX_HOURS) {
    console.log('🔄 Refreshing S3 project context…');
    cachedContext = await buildContextFromS3(S3_PREFIX);
    cachedContextTime = now;
    console.log(`✅ Loaded S3 context (${cachedContext.length} chars)`);
  }
  return cachedContext;
};

// finance / platform probes
const financialRegex = new RegExp(
  [
    'financial',
    'finance',
    'cost',
    'price',
    'budget',
    'estimate',
    'invoice',
    'payment',
    'fee',
    'quote',
    'bid',
    'markup',
    'allowance',
    'change order',
    'pay app',
    'pay application',
    'unit price',
    'labor rate',
    'material cost',
    '\\$\\s*\\d',
    'usd',
    'dollar'
  ].join('|'),
  'i'
);

const platformProbeRegex = /(openai|api key|api provider|gpt|model|google drive|aws|s3|bucket|training data)/i;
const smallTalkRegex = /(hello|hi|hey|good (morning|afternoon|evening)|help|test)$/i;

// -------------------- AUTH ROUTES --------------------
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password === APP_PASSWORD) {
    res.cookie('auth', 'ok', {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 24 * 60 * 60 * 1000
    });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid password' });
});

app.post('/api/finance-auth', (req, res) => {
  const { password } = req.body || {};
  if (password === FINANCE_PASSWORD) {
    res.cookie('fin', 'ok', {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 15 * 60 * 1000
    });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid finance password' });
});

// -------------------- GATE MIDDLEWARE --------------------
app.use((req, res, next) => {
  if (req.method === 'POST' && (req.path === '/api/login' || req.path === '/api/finance-auth')) {
    return next();
  }
  if (req.path.startsWith('/static/') || req.path === '/favicon.ico') {
    return next();
  }
  if (req.path === '/login') return next();

  const authed = req.headers.cookie && req.headers.cookie.includes('auth=ok');
  if (!authed) {
    if (req.method === 'GET') return res.redirect('/login');
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
});

// -------------------- STATIC --------------------
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// -------------------- CHAT ROUTE --------------------
app.post('/api/chat', async (req, res) => {
  try {
    const { message, withWeb, financeOk } = req.body || {};
    const q = (message || '').trim();
    if (!q) return res.status(400).json({ error: 'No message' });

    const hasFinanceCookie = req.headers.cookie && req.headers.cookie.includes('fin=ok');
    if (financialRegex.test(q) && !(hasFinanceCookie || financeOk)) {
      return res.json({
        reply: 'Financial questions needs admin permission.',
        requiresFinanceAuth: true
      });
    }

    if (platformProbeRegex.test(q)) {
      return res.json({
        reply: "I'm an internal project assistant and can’t discuss technical platform details."
      });
    }

    if (smallTalkRegex.test(q)) {
      return res.json({
        reply:
          'Hello! I am your I-5 project assistant. Ask me about OHLA USA I-5 project files, specs, RFIs, PCOs, and submittals.'
      });
    }

    // Hybrid: if user already agreed to "internet"
    if (withWeb) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful engineering and construction assistant. Answer using your general knowledge and best practices, but do not mention anything about data sources, APIs, or model names.'
          },
          { role: 'user', content: q }
        ]
      });
      const reply = completion.choices?.[0]?.message?.content || 'No reply';
      return res.json({ reply });
    }

    // S3-first mode
    const context = await getCachedS3Context();
    const systemPrompt =
      'You are an internal project assistant for OHLA USA’s I-5 project. Use ONLY the provided project context. If the answer is not clearly present in the context, reply exactly with the single word: NO_MATCH. Do not mention files, buckets, or internal systems.';

    const userContent = `Question: ${q}\n\nProject context (documents, RFIs, PCOs, permits, specs, submittals, etc.):\n${context}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ]
    });

    const rawReply = completion.choices?.[0]?.message?.content?.trim() || '';
    const upper = rawReply.toUpperCase();

    if (!context || upper === 'NO_MATCH' || rawReply.toLowerCase().includes("i don't know")) {
      return res.json({
        reply:
          "I couldn't find this in the current I-5 project documents I have. Do you want me to check general knowledge (similar to checking the internet)?",
        offerWeb: true
      });
    }

    return res.json({ reply: rawReply });
  } catch (e) {
    console.error('Chat failed', e);
    return res.status(500).json({ error: 'Chat failed' });
  }
});

// -------------------- PAGES --------------------
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.redirect('/');
});

// -------------------- START --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ OHLA GPT (S3 hybrid) running on port ${PORT}`);
});
