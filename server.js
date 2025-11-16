// server.js
require("dotenv").config();

const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const OpenAI = require("openai");
const AWS = require("aws-sdk");

// -----------------------------------------------------------------------------
// Basic setup
// -----------------------------------------------------------------------------

const app = express();
const PORT = process.env.PORT || 10000;

// Simple timestamped logger
function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

// -----------------------------------------------------------------------------
// OpenAI client
// -----------------------------------------------------------------------------

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -----------------------------------------------------------------------------
// AWS SDK (S3 + Textract)
// -----------------------------------------------------------------------------

const AWS_REGION = process.env.AWS_REGION || "us-east-2";
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = process.env.S3_PREFIX || "";

AWS.config.update({ region: AWS_REGION });

const s3 = new AWS.S3();
const textract = new AWS.Textract();

// -----------------------------------------------------------------------------
// In-memory project index + filename map
// -----------------------------------------------------------------------------

let s3IndexSummary = "";
let s3IndexJson = null;
let filenameToKey = {}; // maps "0721adp3197_permit.pdf" -> "GPT Files/18 Permits/0721ADP3197_Permit.pdf"

// Normalize prefix to always end with "/"
function normalizedPrefix() {
  if (!S3_PREFIX) return "";
  return S3_PREFIX.endsWith("/") ? S3_PREFIX : S3_PREFIX + "/";
}

// Build a simple filename map entry
function addFilenameMapping(key) {
  const base = path.posix.basename(key).toLowerCase();
  if (!filenameToKey[base]) {
    filenameToKey[base] = key;
  }
}

// Load index.json (optional) + object listing from S3
async function loadS3Index() {
  if (!S3_BUCKET) {
    log("S3_BUCKET is not set. S3 search and Textract will be disabled.");
    return;
  }

  const prefix = normalizedPrefix();

  log("=== Loading S3 index ===");
  log("AWS_REGION:", AWS_REGION);
  log("S3_BUCKET:", S3_BUCKET);
  log("S3_PREFIX:", prefix || "(none)");

  try {
    // 1) Optional custom index.json
    try {
      const indexObj = await s3
        .getObject({
          Bucket: S3_BUCKET,
          Key: path.posix.join(prefix, "index.json"),
        })
        .promise();

      const json = JSON.parse(indexObj.Body.toString("utf-8"));
      s3IndexJson = json;
      log("Loaded custom index.json from S3 with", json.length, "entries");

      // if entries have "key" property, add them to filename map
      for (const entry of json) {
        if (entry && entry.key) {
          addFilenameMapping(entry.key);
        }
      }
    } catch (err) {
      log("No index.json found or failed to parse – proceeding with object list only.");
    }

    // 2) Build text summary of all objects under S3_PREFIX
    const parts = [];
    filenameToKey = filenameToKey || {};

    let continuationToken = undefined;
    let count = 0;

    do {
      const result = await s3
        .listObjectsV2({
          Bucket: S3_BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
        .promise();

      (result.Contents || []).forEach((obj) => {
        const key = obj.Key;
        if (!key || key.endsWith("/")) return; // skip folder markers

        const shortKey = prefix ? key.replace(prefix, "") : key;
        parts.push(shortKey);
        addFilenameMapping(key);
        count += 1;
      });

      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    s3IndexSummary =
      parts.length > 0
        ? `The OHLA I-5 project files in S3 include documents such as:\n- ${parts.join(
            "\n- "
          )}\n\nUse these names when referring to documents (permits, RFIs, PCOs, specs, submittals, etc.).`
        : "No project files were found in S3.";

    log("Built S3 index summary with", count, "objects.");
  } catch (err) {
    log("Error while loading S3 index:", err);
  }
}

// -----------------------------------------------------------------------------
// Textract OCR with S3 caching
// -----------------------------------------------------------------------------

// Turn an S3 key into a cache key, e.g.
// "GPT Files/18 Permits/0721ADP3197_Permit.pdf"
// -> "GPT Files/_cache/18 Permits/0721ADP3197_Permit.pdf.txt"
function cacheKeyForS3Key(key) {
  const prefix = normalizedPrefix();
  let relative = key;
  if (prefix && key.startsWith(prefix)) {
    relative = key.slice(prefix.length);
  }
  return path.posix.join(prefix, "_cache", relative + ".txt");
}

async function extractTextForS3Key(key) {
  if (!S3_BUCKET) {
    log("extractTextForS3Key called but S3_BUCKET is not set");
    return null;
  }

  const prefix = normalizedPrefix();
  const cacheKey = cacheKeyForS3Key(key);
  log("Looking for cached text at:", cacheKey);

  // 1) Try to read cached text
  try {
    const cached = await s3
      .getObject({
        Bucket: S3_BUCKET,
        Key: cacheKey,
      })
      .promise();

    const text = cached.Body.toString("utf-8");
    log("Found cached OCR text for:", key, "- length:", text.length);
    return text;
  } catch (err) {
    log("No cached text found at:", cacheKey, "- running Textract...");
  }

  // 2) Download original PDF and run Textract
  try {
    const obj = await s3
      .getObject({
        Bucket: S3_BUCKET,
        Key: key,
      })
      .promise();

    const bytes = obj.Body;
    log("Downloaded source file from S3 for Textract:", key, "- size:", bytes.length);

    const texRes = await textract
      .detectDocumentText({
        Document: { Bytes: bytes },
      })
      .promise();

    const lines = [];
    if (texRes && Array.isArray(texRes.Blocks)) {
      for (const block of texRes.Blocks) {
        if (block.BlockType === "LINE" && block.Text) {
          lines.push(block.Text);
        }
      }
    }

    const fullText = lines.join("\n");
    log("Textract extracted", fullText.length, "characters from", key);

    // 3) Save to cache
    try {
      await s3
        .putObject({
          Bucket: S3_BUCKET,
          Key: cacheKey,
          Body: fullText,
          ContentType: "text/plain",
        })
        .promise();
      log("Saved cached text to S3:", cacheKey);
    } catch (err) {
      log("Failed to save cached text:", err);
    }

    return fullText;
  } catch (err) {
    log("Textract error for", key, ":", err);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Rough detection of financial / cost questions
function isFinancialQuestion(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  const keywords = [
    "cost",
    "costs",
    "price",
    "budget",
    "dollar",
    "$",
    "pay item",
    "pay items",
    "payment",
    "unit price",
    "lump sum",
    "change order value",
    "amount",
    "flagging cost",
    "extra work bill",
    "ewb",
    "invoice",
    "billing",
  ];

  return keywords.some((k) => lower.includes(k));
}

// Try to recognize a filename from the user message
function detectFilenameFromMessage(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  // Direct match like "0721ADP3197_Permit.pdf"
  const direct = lower.match(/([0-9a-z_\-\.]+\.pdf)/i);
  if (direct) {
    return direct[1].toLowerCase();
  }

  // Fuzzy match: if the message contains the base name (without .pdf)
  for (const base of Object.keys(filenameToKey || {})) {
    const baseNoExt = base.replace(/\.pdf$/, "");
    if (lower.includes(baseNoExt)) {
      return base; // already lowercase
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// -----------------------------------------------------------------------------
// API: /api/chat
// -----------------------------------------------------------------------------

app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = (req.body && req.body.message) || "";
    const financePassword = (req.body && req.body.financePassword) || "";
    const FINANCE_PASSWORD = process.env.FINANCE_PASSWORD || "";

    log("User message:", userMessage);

    // 1) Financial guardrail
    if (isFinancialQuestion(userMessage)) {
      if (!FINANCE_PASSWORD || financePassword !== FINANCE_PASSWORD) {
        return res.json({
          fromFiles: true,
          answer:
            "Financial questions need admin permission. Please provide the admin password to proceed.",
          needsPassword: true,
        });
      }
    }

    // 2) Optional PDF OCR context
    let extraContext = "";
    let previewText = null;
    let previewSource = null;
    let previewTitle = null;

    const detectedName = detectFilenameFromMessage(userMessage);
    log("detectFilenameFromMessage result:", detectedName);

    if (detectedName && S3_BUCKET) {
      const key = filenameToKey[detectedName];
      if (key) {
        log("User mentioned PDF:", detectedName, "→ S3 key:", key);

        const fullText = await extractTextForS3Key(key);
        if (fullText && fullText.trim().length > 0) {
          const truncated = fullText.slice(0, 8000); // limit tokens
          extraContext = `\n\nEXTRACTED TEXT FROM PROJECT DOCUMENT "${detectedName}" (first 8000 characters):\n\n${truncated}\n\nEND OF EXTRACTED TEXT\n`;
          previewText = fullText.slice(0, 3000); // for UI preview
          previewSource = key;
          previewTitle = detectedName;
        } else {
          log("Textract returned empty or null text for:", key);
        }
      } else {
        log("Detected filename in question but no matching S3 object:", detectedName);
      }
    }

    // 3) Build system prompt
    const indexJsonSnippet = s3IndexJson
      ? JSON.stringify(s3IndexJson).slice(0, 6000)
      : null;

    const systemPrompt = `
You are "OHLA GPT — I-5 Project Assistant" for the Santa Clarita I-5 North County Enhancement Project.

You have access to:
• A summary of OHLA I-5 project documents stored in AWS S3 (permits, RFIs, PCOs, contracts, submittals, specs, etc.).
• In some cases, OCR text extracted from PDF files via AWS Textract.

When OCR text for a document is provided in this prompt (it will start with:
"EXTRACTED TEXT FROM PROJECT DOCUMENT ..."), you MUST treat that text as the
actual content of the PDF and you MUST NOT say that you cannot read PDFs.
Use that extracted text as your primary source of truth.

If NO OCR text is provided for the current question, it is OK to say that you
cannot directly read the PDF and can only answer based on summaries or general
knowledge.

First, always try to answer using project documents and any OCR text provided below. 
If something is not clearly specified, explain the uncertainty instead of guessing. 
If you must use general civil-construction knowledge, clearly state that it is general knowledge
and may not be contractually binding.

If the question asks for project financial / cost information and the user did not provide the correct admin password, respond ONLY with:
"Financial questions need admin permission."

Project file summary (from S3):

${s3IndexSummary || "No S3 index is currently loaded."}

If you reference a specific document, use its file name or folder like "RFI Log.xls", "Encroachment Permits", "Subcontractors contracts", "0721ADP3197_Permit.pdf", etc.
${
  indexJsonSnippet
    ? `\nAdditional machine-readable index data:\n${indexJsonSnippet}\n`
    : ""
}
${extraContext}
`.trim();

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    // 4) Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.2,
    });

    const answer = (completion.choices[0].message.content || "").trim();

    // 5) Respond to client
    res.json({
      fromFiles: true,
      answer,
      needsPassword: false,
      previewText,
      previewSource,
      previewTitle,
    });
  } catch (err) {
    log("Error in /api/chat:", err);
    res.status(500).json({
      fromFiles: false,
      answer: "Sorry, something went wrong while processing your request.",
    });
  }
});

// -----------------------------------------------------------------------------
// Fallback: serve SPA
// -----------------------------------------------------------------------------

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -----------------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------------

(async () => {
  log("=== OHLA GPT STARTUP ===");
  log("AWS_REGION:", AWS_REGION);
  log("S3_BUCKET:", S3_BUCKET || "(not set)");
  log("S3_PREFIX:", normalizedPrefix() || "(none)");
  if (process.env.FINANCE_PASSWORD) {
    log("FINANCE_PASSWORD set: true");
  } else {
    log("FINANCE_PASSWORD set: false");
  }

  await loadS3Index();

  app.listen(PORT, () => {
    log(`OHLA GPT (S3 hybrid + Textract) running on port ${PORT}`);
  });
})();
