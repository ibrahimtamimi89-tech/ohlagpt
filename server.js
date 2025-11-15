import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import pdfParse from 'pdf-parse';
import XLSX from 'xlsx';
import mammoth from 'mammoth';

// AWS SDK v3
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { TextractClient, DetectDocumentTextCommand } from '@aws-sdk/client-textract';

// ---------------------------------------------------------------------
// Basic app setup
// ---------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true }
  })
);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
// OpenAI client
// ---------------------------------------------------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------
// AWS clients (S3 + Textract)
// ---------------------------------------------------------------------
const awsRegion = process.env.AWS_REGION || 'us-east-1';
const s3Bucket = process.env.S3_BUCKET;      // e.g. "ohla-gpt-project-files"
const s3Prefix = (process.env.S3_PREFIX || '').replace(/^\/+/, '').replace(/\/+$/, '') + '/'; // "GPT Files/"

if (!s3Bucket) {
  console.warn('⚠ S3_BUCKET is not set. S3 search will be disabled.');
}

const commonAwsConfig = {
  region: awsRegion,
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    : undefined
};

const s3 = new S3Client(commonAwsConfig);
const textract = new TextractClient(commonAwsConfig);

// ---------------------------------------------------------------------
// Helpers: S3 listing + streaming
// ---------------------------------------------------------------------
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function getExt(key) {
  const m = key.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

let s3Index = [];            // { key, name, ext }
let lastIndexRefresh = 0;
const INDEX_TTL_MS = 5 * 60 * 1000; // refresh every 5 minutes

async function refreshS3Index() {
  if (!s3Bucket) return;

  const now = Date.now();
  if (now - lastIndexRefresh < INDEX_TTL_MS && s3Index.length) return;

  const listParams = {
    Bucket: s3Bucket,
    Prefix: s3Prefix === '/' ? undefined : s3Prefix
  };

  const objects = [];
  let token;
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        ...listParams,
        ContinuationToken: token
      })
    );
    (resp.Contents || []).forEach((obj) => {
      if (!obj.Key.endsWith('/')) objects.push(obj.Key);
    });
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);

  s3Index = objects.map((key) => ({
    key,
    name: key.split('/').slice(-1)[0],
    ext: getExt(key)
  }));

  lastIndexRefresh = now;
  console.log(`Indexed ${s3Index.length} S3 objects under ${s3Bucket}/${s3Prefix}`);
}

// ---------------------------------------------------------------------
// Helpers: text extraction per file type
// ---------------------------------------------------------------------
const textCache = new Map(); // key -> text

async function getObjectBuffer(key) {
  const resp = await s3.send(
    new GetObjectCommand({
      Bucket: s3Bucket,
      Key: key
    })
  );
  return streamToBuffer(resp.Body);
}

async function extractTextFromS3Object(meta) {
  if (!s3Bucket) return '';
  if (textCache.has(meta.key)) return textCache.get(meta.key);

  const ext = meta.ext;
  let text = '';

  try {
    if (['txt', 'csv', 'log'].includes(ext)) {
      const buf = await getObjectBuffer(meta.key);
      text = buf.toString('utf8');
    } else if (['json'].includes(ext)) {
      const buf = await getObjectBuffer(meta.key);
      const obj = JSON.parse(buf.toString('utf8'));
      text = JSON.stringify(obj, null, 2);
    } else if (['pdf'].includes(ext)) {
      const buf = await getObjectBuffer(meta.key);
      const parsed = await pdfParse(buf);
      text = parsed.text || '';
    } else if (['xls', 'xlsx'].includes(ext)) {
      const buf = await getObjectBuffer(meta.key);
      const wb = XLSX.read(buf, { type: 'buffer' });
      const pieces = [];
      wb.SheetNames.forEach((name) => {
        const sheet = wb.Sheets[name];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        pieces.push(`\n\n=== Sheet: ${name} ===\n${csv}`);
      });
      text = pieces.join('\n');
    } else if (['docx'].includes(ext)) {
      const buf = await getObjectBuffer(meta.key);
      const result = await mammoth.extractRawText({ buffer: buf });
      text = result.value || '';
    } else if (['jpg', 'jpeg', 'png', 'tif', 'tiff'].includes(ext)) {
      // Use AWS Textract OCR directly from S3
      const texResp = await textract.send(
        new DetectDocumentTextCommand({
          Document: {
            S3Object: {
              Bucket: s3Bucket,
              Name: meta.key
            }
          }
        })
      );
      const blocks = texResp.Blocks || [];
      text = blocks
        .filter((b) => b.BlockType === 'LINE')
        .map((b) => b.Text)
        .join('\n');
    } else {
      // Unsupported type – still try to read as text to be safe
      const buf = await getObjectBuffer(meta.key);
      text = buf.toString('utf8');
    }
  } catch (err) {
    console.error(`Error extracting text from ${meta.key}:`, err.message);
    text = '';
  }

  const trimmed = text.trim();
  textCache.set(meta.key, trimmed);
  return trimmed;
}

// ---------------------------------------------------------------------
// Simple scoring & context building
// ---------------------------------------------------------------------
function tokenize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function scoreDocument(questionTokens, text) {
  if (!text) return 0;
  const sample = text.slice(0, 8000).toLowerCase();
  let score = 0;
  for (const tok of questionTokens) {
    if (sample.includes(tok)) score += 1;
  }
  return score;
}

async function buildS3Context(question) {
  if (!s3Bucket) return { context: '', usedDocs: [] };

  await refreshS3Index();

  const qTokens = tokenize(question);
  const scored = [];

  for (const meta of s3Index) {
    const text = await extractTextFromS3Object(meta);
    if (!text) continue;
    const score = scoreDocument(qTokens, text);
    if (score > 0) {
      scored.push({
        meta,
        text,
        score
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);

  const parts = top.map(
    (d) =>
      `\n\n===== DOCUMENT: ${d.meta.name} (S3 key: ${d.meta.key}) =====\n${d.text.slice(
        0,
        8000
      )}`
  );

  return {
    context: parts.join('\n'),
    usedDocs: top.map((d) => d.meta.name)
  };
}

// ---------------------------------------------------------------------
// Finance / cost detection
// ---------------------------------------------------------------------
const FINANCE_PASSWORD = process.env.FINANCE_PASSWORD || 'tamimi202';

function isFinancialQuestion(msg) {
  if (!msg) return false;
  const re =
    /(cost|budget|price|dollar|usd|\$|estimate|pay\s*item|payment|invoice|change order|extra work|EWB|PCO|CO #)/i;
  return re.test(msg);
}

// ---------------------------------------------------------------------
// API: Chat
// ---------------------------------------------------------------------
app.post('/api/chat', async (req, res) => {
  try {
    const { message, allowInternet, financePassword } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Missing message' });
    }

    // Finance protection
    if (isFinancialQuestion(message) && financePassword !== FINANCE_PASSWORD) {
      return res.json({
        reply: 'Financial questions need admin permission.',
        needsFinancePassword: true
      });
    }

    // Build S3 context
    const { context: s3Context, usedDocs } = await buildS3Context(message);
    const hasUsefulDocs = s3Context && s3Context.trim().length > 0;

    const systemParts = [];
    systemParts.push(
      'You are the OHLA I-5 project assistant for the Santa Clarita I-5 North County Enhancement Project.'
    );
    systemParts.push(
      'Use the project documents provided in the "Project documents" section as your primary source.'
    );
    systemParts.push(
      'When you can answer from those documents, clearly answer and, when helpful, mention the document names in parentheses, e.g. (from RFI Log.xls).'
    );
    systemParts.push(
      "If the documents don't clearly answer the question, briefly say that you couldn't find it in the current I-5 project documents."
    );

    if (allowInternet) {
      systemParts.push(
        'In addition, you may use your general engineering and construction knowledge to give a reasonable answer, but still make it clear when something is *not* explicitly in the documents.'
      );
    } else {
      systemParts.push(
        'Do NOT invent details that are not implied by the documents. If the documents do not answer, say so; the UI will ask the user if they want you to check general knowledge (similar to checking the internet).'
      );
    }

    systemParts.push(
      'Never mention OpenAI, APIs, AWS, S3, Textract, or any implementation details. Just behave like a helpful internal project assistant.'
    );

    const systemMessage = systemParts.join(' ');

    const userContent = `User question:\n${message}\n\nProject documents (from AWS S3):\n${s3Context ||
      '[No matching documents were found or could be read.]'}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userContent }
      ]
    });

    const reply = completion.choices?.[0]?.message?.content || 'No reply';

    res.json({
      reply,
      usedDocs,
      usedInternet: !!allowInternet && !hasUsefulDocs
    });
  } catch (err) {
    console.error('Chat failed:', err);
    res.status(500).json({ error: 'Chat failed' });
  }
});

// ---------------------------------------------------------------------
// Serve frontend
// ---------------------------------------------------------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
