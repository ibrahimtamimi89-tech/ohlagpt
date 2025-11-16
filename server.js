// server.js
require("dotenv").config();

const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const OpenAI = require("openai");
const AWS = require("aws-sdk");

const app = express();
const PORT = process.env.PORT || 10000;

// ===== OpenAI client =====
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== AWS SDK (S3 + Textract) =====
const AWS_REGION = process.env.AWS_REGION || "us-east-2";
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = process.env.S3_PREFIX || "GPT Files/";

AWS.config.update({ region: AWS_REGION });

const s3 = new AWS.S3();
const textract = new AWS.Textract();

// ===== In-memory index of project files =====
let s3IndexSummary = "";
let s3IndexJson = null;
let s3ObjectKeys = [];
let filenameToKey = {};

// Simple cache to avoid repeated OCR in the same process
const memoryTextCache = new Map();

// ---------- helpers ----------

function log(...args) {
  console.log("[OHLA-GPT]", ...args);
}

// very rough financial-question detector
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

async function loadS3Index() {
  if (!S3_BUCKET) {
    log("S3_BUCKET is not set. S3 search will be disabled.");
    return;
  }

  log("=== Loading S3 index ===");
  log("AWS_REGION:", AWS_REGION);
  log("S3_BUCKET:", S3_BUCKET);
  log("S3_PREFIX:", S3_PREFIX);

  try {
    // 1) Optional index.json
    try {
      const indexObj = await s3
        .getObject({
          Bucket: S3_BUCKET,
          Key: path.posix.join(S3_PREFIX, "index.json"),
        })
        .promise();

      const json = JSON.parse(indexObj.Body.toString("utf-8"));
      s3IndexJson = json;
      log("Loaded custom index.json from S3 with", json.length, "entries");
    } catch (err) {
      log("No index.json found or failed to parse – proceeding with object list only.");
    }

    // 2) Build simple list & summary of all objects
    const parts = [];
    s3ObjectKeys = [];
    filenameToKey = {};

    let continuationToken = undefined;

    do {
      const result = await s3
        .listObjectsV2({
          Bucket: S3_BUCKET,
          Prefix: S3_PREFIX,
          ContinuationToken: continuationToken,
        })
        .promise();

      (result.Contents || []).forEach((obj) => {
        const key = obj.Key;
        if (key.endsWith("/")) return; // folder marker

        s3ObjectKeys.push(key);

        const shortKey = S3_PREFIX ? key.replace(S3_PREFIX, "") : key;
        parts.push(shortKey);

        const base = path.posix.basename(key).toLowerCase();
        if (!filenameToKey[base]) {
          filenameToKey[base] = key;
        }
      });

      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    s3IndexSummary =
      parts.length > 0
        ? `The OHLA I-5 project files in S3 include documents such as:\n- ${parts.join(
            "\n- "
          )}\n\nUse these names when referring to documents (permits, RFIs, PCOs, specs, submittals, etc.).`
        : "No project files were found in S3.";

    log("Built S3 index summary with", parts.length, "objects.");
  } catch (err) {
    console.error("Error while loading S3 index:", err);
  }
}

// Build cache key under same folder tree but in _cache
function makeCacheKeyForSourceKey(sourceKey) {
  const prefixWithoutTrailingSlash = S3_PREFIX.replace(/\/$/, "");
  const cacheRoot = `${prefixWithoutTrailingSlash}/_cache/`;
  const relative = sourceKey.replace(S3_PREFIX, "");
  return `${cacheRoot}${relative}.txt`;
}

// Extract full text for a single S3 object (PDF, image) via Textract, with S3 + memory caching
async function extractTextForS3Key(s3Key) {
  if (!S3_BUCKET) {
    log("S3_BUCKET not set, cannot run Textract.");
    return null;
  }

  if (!s3Key) return null;

  const memoryKey = `mem:${s3Key}`;
  if (memoryTextCache.has(memoryKey)) {
    log("Using in-process cached text for", s3Key);
    return memoryTextCache.get(memoryKey);
  }

  const cacheKey = makeCacheKeyForSourceKey(s3Key);

  // 1) Try cached text from S3
  try {
    log("Looking for cached text at:", cacheKey);
    const cachedObj = await s3
      .getObject({
        Bucket: S3_BUCKET,
        Key: cacheKey,
      })
      .promise();

    const text = cachedObj.Body.toString("utf-8");
    log("Loaded cached text from S3 (length", text.length, ")");
    memoryTextCache.set(memoryKey, text);
    return text;
  } catch (err) {
    log("No cached text found at", cacheKey, "- running Textract...");
  }

  // 2) Download original file
  let fileBuffer;
  try {
    const obj = await s3
      .getObject({
        Bucket: S3_BUCKET,
        Key: s3Key,
      })
      .promise();

    fileBuffer = obj.Body;
    log("Downloaded source file from S3 for Textract:", s3Key);
  } catch (err) {
    console.error("Error downloading source file from S3:", err);
    return null;
  }

  // 3) Run Textract DetectDocumentText (synchronous)
  let fullText = "";
  try {
    const params = {
      Document: {
        Bytes: fileBuffer,
      },
    };

    const result = await textract.detectDocumentText(params).promise();
    const lines = (result.Blocks || [])
      .filter((b) => b.BlockType === "LINE" && b.Text)
      .map((b) => b.Text);

    fullText = lines.join("\n");
    log("Textract extracted", fullText.length, "characters");
  } catch (err) {
    console.error("Textract error for", s3Key, err);
    return null;
  }

  // 4) Save extracted text back to S3 cache
  try {
    await s3
      .putObject({
        Bucket: S3_BUCKET,
        Key: cacheKey,
        Body: fullText,
        ContentType: "text/plain; charset=utf-8",
      })
      .promise();

    log("Saved cached text to S3:", cacheKey);
  } catch (err) {
    console.error("Error saving cached text to S3:", err);
  }

  memoryTextCache.set(memoryKey, fullText);
  return fullText;
}

// Try to detect a single filename like "0721ADP3197_Permit.pdf" in the user message
function detectFilenameFromMessage(text) {
  if (!text) return null;
  const match = text.match(/([0-9A-Za-z_\-\.]+\.pdf)/i);
  if (!match) return null;
  return match[1].toLowerCase();
}

// ===== Middleware =====
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== API: chat =====
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = (req.body && req.body.message) || "";
    const financePassword = (req.body && req.body.financePassword) || "";
    const FINANCE_PASSWORD = process.env.FINANCE_PASSWORD || "";

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

    // 2) Optional: detect a single PDF filename in the question
    let extraContext = "";
    let previewText = null;
    let previewSource = null;

    const detectedName = detectFilenameFromMessage(userMessage);
    if (detectedName && S3_BUCKET) {
      const key = filenameToKey[detectedName];
      if (key) {
        log("User mentioned PDF:", detectedName, "→ S3 key:", key);
        const fullText = await extractTextForS3Key(key);

        if (fullText) {
          const snippetForModel = fullText.slice(0, 8000); // keep model prompt small
          const snippetForPreview = fullText.slice(0, 1800); // show smaller preview in UI

          extraContext = `\n\nEXTRACTED TEXT FROM PROJECT DOCUMENT "${path.posix.basename(
            key
          )}" (via AWS Textract, truncated):\n${snippetForModel}\n\nUse this text as the source of truth for answering the user's question.`;

          previewText = snippetForPreview;
          previewSource = path.posix.basename(key);
        }
      } else {
        log("Detected filename in question but no matching S3 object:", detectedName);
      }
    }

    // 3) Build system prompt
    const systemPrompt = `
You are "OHLA GPT — I-5 Project Assistant" for the Santa Clarita I-5 North County Enhancement Project.

You have access to:
• A summary of OHLA I-5 project documents stored in AWS S3 (permits, RFIs, PCOs, contracts, submittals, specs, etc.).
• In some cases, OCR text extracted from PDF files via AWS Textract.

First, always try to answer using project documents and any OCR text provided below. If something is not clearly specified, explain the uncertainty instead of guessing. 
If you must use general civil-construction knowledge, clearly state that it is general knowledge and may not be contractually binding.

If the question asks for project financial / cost information and the user did not provide the correct admin password, you must ONLY reply:
"Financial questions need admin permission."

Project file summary (from S3):

${s3IndexSummary || "No S3 index is currently loaded."}
${extraContext || ""}

If you reference a specific document, use its file name or folder like "RFI Log.xls", "Encroachment Permits", "0721ADP3197_Permit.pdf", etc.
`;

    const indexJsonSnippet = s3IndexJson
      ? JSON.stringify(s3IndexJson).slice(0, 6000)
      : null;

    const messages = [
      {
        role: "system",
        content:
          systemPrompt +
          (indexJsonSnippet
            ? `\n\nAdditional machine-readable index data:\n${indexJsonSnippet}\n`
            : ""),
      },
      {
        role: "user",
        content: userMessage,
      },
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.2,
    });

    const answer = completion.choices[0].message.content.trim();

    res.json({
      fromFiles: true,
      answer,
      needsPassword: false,
      previewText,
      previewSource,
    });
  } catch (err) {
    console.error("Error in /api/chat:", err);
    res.status(500).json({
      fromFiles: false,
      answer: "Sorry, something went wrong while processing your request.",
    });
  }
});

// ===== Fallback: serve index.html =====
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===== Start server after loading S3 index =====
(async () => {
  log("=== OHLA GPT STARTUP ===");
  log("AWS_REGION:", AWS_REGION);
  log("S3_BUCKET:", S3_BUCKET);
  log("S3_PREFIX:", S3_PREFIX);
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
