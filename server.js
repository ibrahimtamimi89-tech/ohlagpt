// server.js
require("dotenv").config();

const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const OpenAI = require("openai");
const AWS = require("aws-sdk");

// ==================== Basic setup ====================
const app = express();
const PORT = process.env.PORT || 10000;

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// AWS config (S3 + Textract)
const AWS_REGION = process.env.AWS_REGION || "us-east-2";
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = process.env.S3_PREFIX || "";

AWS.config.update({ region: AWS_REGION });

const s3 = new AWS.S3();
const textract = new AWS.Textract();

// In-memory index of S3 objects
let s3IndexSummary = "";
let s3IndexJson = null;
// map: lowercase base filename -> full S3 key
let s3KeyByBaseName = Object.create(null);

// ==================== Load S3 index ====================
async function loadS3Index() {
  if (!S3_BUCKET) {
    console.log("S3_BUCKET is not set. S3 search will be disabled.");
    return;
  }

  console.log("=== Loading S3 index ===");
  console.log("AWS_REGION:", AWS_REGION);
  console.log("S3_BUCKET:", S3_BUCKET);
  console.log("S3_PREFIX:", S3_PREFIX);

  try {
    // 1) Optional custom index.json
    try {
      const indexObj = await s3
        .getObject({
          Bucket: S3_BUCKET,
          Key: path.posix.join(S3_PREFIX, "index.json"),
        })
        .promise();

      const json = JSON.parse(indexObj.Body.toString("utf-8"));
      s3IndexJson = json;
      console.log(
        "Loaded custom index.json from S3 with",
        Array.isArray(json) ? json.length : Object.keys(json).length,
        "entries"
      );
    } catch (err) {
      console.log(
        "No index.json found or failed to parse – proceeding with object list only."
      );
    }

    // 2) Build summary + baseName -> key map
    const parts = [];
    s3KeyByBaseName = Object.create(null);

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
        if (!key || key.endsWith("/")) return; // folder marker
        const shortKey = S3_PREFIX ? key.replace(S3_PREFIX, "") : key;

        parts.push(shortKey);

        const base = path.posix.basename(shortKey).toLowerCase();
        // If there are duplicates, we just keep the first one.
        if (!s3KeyByBaseName[base]) {
          s3KeyByBaseName[base] = key;
        }
      });

      continuationToken = result.IsTruncated
        ? result.NextContinuationToken
        : undefined;
    } while (continuationToken);

    s3IndexSummary =
      parts.length > 0
        ? `The OHLA I-5 project files in S3 include documents such as:\n- ${parts.join(
            "\n- "
          )}\n\nUse these names when referring to documents (permits, RFIs, PCOs, specs, submittals, POTDs, etc.).`
        : "No project files were found in S3.";

    console.log("Built S3 index summary with", parts.length, "objects.");
  } catch (err) {
    console.error("Error while loading S3 index:", err);
  }
}

// ==================== Helpers ====================

// crude keyword detection for financial questions
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

// extract first "<something>.pdf" from user text
function findPdfNameInText(text) {
  if (!text) return null;
  const match = text.match(/([0-9A-Za-z_\- .]+\.pdf)/i);
  if (!match) return null;
  return match[1].trim();
}

// turn S3 object key into a cache object key
function makeCacheKeyFor(originalKey) {
  // Put cache objects under "<prefix>_cache/"
  const prefix = S3_PREFIX || "";
  const safeName = originalKey.replace(/\//g, "__");
  return path.posix.join(prefix, "_cache", `${safeName}.txt`);
}

// Try to get text for a PDF via Textract (with S3 cache)
async function getPdfTextFromTextract(baseFileName) {
  if (!S3_BUCKET) return { text: null, error: "S3_BUCKET not set" };

  const baseLower = baseFileName.toLowerCase();
  const s3Key = s3KeyByBaseName[baseLower];
  if (!s3Key) {
    return { text: null, error: `No S3 object found for ${baseFileName}` };
  }

  const cacheKey = makeCacheKeyFor(s3Key);

  // 1) try cached text
  try {
    const cached = await s3
      .getObject({
        Bucket: S3_BUCKET,
        Key: cacheKey,
      })
      .promise();

    const text = cached.Body.toString("utf-8");
    console.log(
      `[OHLA-GPT] Using cached text from S3 for: ${baseFileName} (key: ${cacheKey})`
    );
    return { text, error: null, fromCache: true, s3Key };
  } catch (err) {
    console.log(
      `[OHLA-GPT] No cached text found at ${cacheKey} – will call Textract.`
    );
  }

  // 2) download original PDF
  try {
    console.log(
      `[OHLA-GPT] Downloading source file for Textract: bucket=${S3_BUCKET}, key=${s3Key}`
    );
    const obj = await s3
      .getObject({
        Bucket: S3_BUCKET,
        Key: s3Key,
      })
      .promise();

    const bytes = obj.Body;

    // 3) call Textract (synchronous DetectDocumentText)
    console.log(
      `[OHLA-GPT] Calling Textract DetectDocumentText for ${baseFileName}...`
    );
    const result = await textract
      .detectDocumentText({
        Document: {
          Bytes: bytes,
        },
      })
      .promise();

    const lines = [];
    for (const block of result.Blocks || []) {
      if (block.BlockType === "LINE" && block.Text) {
        lines.push(block.Text);
      }
    }

    const text = lines.join("\n");
    console.log(
      `[OHLA-GPT] Textract returned ${lines.length} lines for ${baseFileName}.`
    );

    // 4) write cache for next time
    try {
      await s3
        .putObject({
          Bucket: S3_BUCKET,
          Key: cacheKey,
          Body: text,
          ContentType: "text/plain; charset=utf-8",
        })
        .promise();
      console.log(
        `[OHLA-GPT] Stored Textract cache at ${cacheKey} (length=${text.length}).`
      );
    } catch (cacheErr) {
      console.error(
        "[OHLA-GPT] Failed to write Textract cache to S3:",
        cacheErr
      );
    }

    return { text, error: null, fromCache: false, s3Key };
  } catch (err) {
    console.error(
      `[OHLA-GPT] Textract error for ${baseFileName} (key: ${s3Key})`,
      err
    );
    let msg = "Textract failed.";
    if (err.code === "UnsupportedDocumentException") {
      msg =
        "AWS Textract says this PDF format is not supported (possibly multi-page, encrypted, or too large for the synchronous API).";
    } else if (err.code === "InvalidParameterException") {
      msg =
        "AWS Textract rejected this PDF (InvalidParameterException). The file may be corrupted or not a standard PDF.";
    } else if (err.code === "DocumentTooLargeException") {
      msg =
        "AWS Textract says this PDF is too large for synchronous processing.";
    } else if (err.message) {
      msg = err.message;
    }
    return { text: null, error: msg, s3Key };
  }
}

// ==================== Middleware ====================
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ==================== Chat API ====================
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

    // 2) Try to detect a specific PDF file mentioned in the question
    let pdfContextText = "";
    let pdfPreview = null;
    let pdfFileName = null;
    let pdfNote = "";

    const mentionedPdf = findPdfNameInText(userMessage);
    if (mentionedPdf) {
      pdfFileName = mentionedPdf.trim();
      console.log(`[OHLA-GPT] User mentioned PDF: "${pdfFileName}"`);

      const tex = await getPdfTextFromTextract(pdfFileName);
      if (tex.text) {
        // include at most ~16k chars in prompt to stay safe
        const snippet = tex.text.slice(0, 16000);
        pdfContextText = `\n\nEXTRACTED TEXT FROM ${pdfFileName} (via AWS Textract):\n${snippet}`;
        pdfPreview = snippet;
        pdfNote = tex.fromCache
          ? `Extracted text loaded from cache for ${pdfFileName}.`
          : `Extracted text freshly processed by Textract for ${pdfFileName}.`;
      } else if (tex.error) {
        pdfNote = `Textract could not read "${pdfFileName}". Reason: ${tex.error}`;
        console.log("[OHLA-GPT] " + pdfNote);
      }
    }

    // 3) Build system prompt
    const systemPrompt = `
You are "OHLA GPT — I-5 Project Assistant" for the Santa Clarita I-5 North County Enhancement Project.

You have access to a summary of the OHLA I-5 project documents stored in an AWS S3 bucket (permits, RFIs, PCOs, contracts, submittals, specs, POTDs, etc.), and general civil-construction knowledge.

First, try to answer using the OHLA I-5 project context only. If the answer clearly cannot be answered from project context, you may fall back on general knowledge, but you must clearly say when you are doing that.

If the question asks for project financial / cost information and the user did not provide the correct admin password, respond ONLY with:
"Financial questions need admin permission."

Project file summary (from S3):

${s3IndexSummary || "No S3 index is currently loaded."}

If you reference a specific document, use its file name or folder like "RFI Log.xls", "Encroachment Permits", "POTD", "Subcontractors contracts", etc.${pdfContextText}

${
  pdfNote
    ? `\nImportant note about Textract: ${pdfNote}\nIf Textract failed, you must NOT invent contents of that PDF.`
    : ""
}
`;

    // 4) Optional compact JSON index
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
      { role: "user", content: userMessage },
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
      pdfPreview,
      pdfFileName,
      pdfNote,
    });
  } catch (err) {
    console.error("Error in /api/chat:", err);
    res.status(500).json({
      fromFiles: false,
      answer: "Sorry, something went wrong while processing your request.",
      needsPassword: false,
    });
  }
});

// ==================== Fallback: SPA routing ====================
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ==================== Startup ====================
(async () => {
  console.log("=== OHLA GPT STARTUP ===");
  console.log("AWS_REGION:", AWS_REGION);
  console.log("S3_BUCKET:", S3_BUCKET);
  console.log("S3_PREFIX:", S3_PREFIX);
  if (process.env.FINANCE_PASSWORD) {
    console.log("FINANCE_PASSWORD set: true");
  } else {
    console.log("FINANCE_PASSWORD set: false");
  }

  await loadS3Index();

  app.listen(PORT, () => {
    console.log(`OHLA GPT (S3 hybrid + Textract) running on port ${PORT}`);
  });
})();
