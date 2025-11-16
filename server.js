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
const S3_PREFIX = process.env.S3_PREFIX || "";

AWS.config.update({ region: AWS_REGION });

const s3 = new AWS.S3();
const textract = new AWS.Textract();

// ===== In-memory index of S3 objects =====
let s3IndexSummary = "";
let s3Objects = []; // array of { Key, Size, LastModified }
let s3IndexLoaded = false;

// simple in-memory OCR cache (per process)
const textractCache = new Map(); // key: s3Key, value: text

// ---------- Helpers for S3 index / file name matching ----------

async function loadS3Index() {
  if (!S3_BUCKET) {
    console.log("S3_BUCKET is not set. S3 search/OCR will be disabled.");
    return;
  }

  console.log("=== Loading S3 index ===");
  console.log("AWS_REGION:", AWS_REGION);
  console.log("S3_BUCKET:", S3_BUCKET);
  console.log("S3_PREFIX:", S3_PREFIX);

  try {
    const parts = [];
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
        if (!obj.Key || obj.Key.endsWith("/")) return; // skip folders
        s3Objects.push(obj);

        const shortKey = S3_PREFIX ? obj.Key.replace(S3_PREFIX, "") : obj.Key;
        parts.push(shortKey);
      });

      continuationToken = result.IsTruncated
        ? result.NextContinuationToken
        : undefined;
    } while (continuationToken);

    s3IndexSummary =
      parts.length > 0
        ? `The OHLA I-5 project files in S3 include documents such as:\n- ${parts.join(
            "\n- "
          )}\n\nUse these names when referring to documents (permits, RFIs, POTDs, PCOs, specs, submittals, etc.).`
        : "No project files were found in S3.";

    console.log(
      `Built S3 index summary with ${parts.length} objects. (pdfs: ${
        s3Objects.filter((o) => o.Key.toLowerCase().endsWith(".pdf")).length
      })`
    );
    s3IndexLoaded = true;
  } catch (err) {
    console.error("Error while loading S3 index:", err);
  }
}

/**
 * Extract something that looks like a PDF file name from the user question,
 * e.g. "give me summary for this file 2025.11.01 - POTD.pdf"
 *   -> "2025.11.01 - POTD.pdf"
 */
function extractFilenameFromQuestion(question) {
  if (!question) return null;
  const m = question.match(/([0-9A-Za-z()[\]_\- ,]+\.pdf)/i);
  if (!m) return null;
  return m[1].trim();
}

/**
 * Given a PDF file name like "2025.11.01 - POTD.pdf",
 * find the best matching S3 object key from our index.
 */
function findS3KeyForFilename(filename) {
  if (!filename || !s3Objects.length) return null;
  const lowerName = filename.toLowerCase();

  let bestKey = null;

  for (const obj of s3Objects) {
    const base = path.basename(obj.Key).toLowerCase();

    if (base === lowerName) {
      // perfect match
      return obj.Key;
    }

    if (!bestKey) {
      // loose contains match
      if (lowerName.includes(base) || base.includes(lowerName)) {
        bestKey = obj.Key;
      }
    }
  }

  return bestKey;
}

/**
 * Try to load cached OCR text for a given S3 key from memory.
 */
function getCachedOcrForKey(s3Key) {
  return textractCache.get(s3Key) || null;
}

/**
 * Cache OCR text in memory for this process.
 */
function setCachedOcrForKey(s3Key, text) {
  if (!s3Key || !text) return;
  textractCache.set(s3Key, text);
}

/**
 * Run AWS Textract DetectDocumentText on a PDF stored in S3.
 * Uses simple in-memory caching to avoid re-scanning the same file.
 *
 * Returns { status: "ok" | "error", text?, errorMessage? }
 */
async function runTextractOnPdf(s3Key) {
  if (!S3_BUCKET || !s3Key) {
    return {
      status: "error",
      errorMessage: "Textract is not configured for this environment.",
    };
  }

  // in-memory cache first
  const cached = getCachedOcrForKey(s3Key);
  if (cached) {
    console.log(`[Textract] Using cached OCR for S3 key: ${s3Key}`);
    return { status: "ok", text: cached, cached: true };
  }

  console.log(`[Textract] Running DetectDocumentText for S3 key: ${s3Key}`);

  try {
    const params = {
      Document: {
        S3Object: {
          Bucket: S3_BUCKET,
          Name: s3Key, // "Name" is the correct Textract field
        },
      },
    };

    const response = await textract.detectDocumentText(params).promise();

    const lines = [];
    if (response && Array.isArray(response.Blocks)) {
      for (const b of response.Blocks) {
        if (b.BlockType === "LINE" && b.Text) {
          lines.push(b.Text);
        }
      }
    }

    const text = lines.join("\n");
    console.log(
      `[Textract] Extracted ${lines.length} lines (approximately ${text.length} chars).`
    );

    if (text.length > 0) {
      setCachedOcrForKey(s3Key, text);
    }

    return { status: "ok", text };
  } catch (err) {
    console.error(
      `[Textract] Error for key: ${s3Key} -> ${err.code || ""}: ${
        err.message || err
      }`
    );
    return {
      status: "error",
      errorMessage: `${err.code || "TextractError"}: ${err.message || err}`,
    };
  }
}

/**
 * Very rough detector for financial / cost questions.
 */
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

    // 2) Optional Textract step – try to detect if user mentioned a PDF
    let textractInfo = {
      status: "none",
      filename: null,
      s3Key: null,
      textPreview: null,
      errorMessage: null,
    };

    if (S3_BUCKET && s3IndexLoaded) {
      const filename = extractFilenameFromQuestion(userMessage);
      if (filename) {
        console.log(
          `[Textract] User question appears to mention PDF filename: "${filename}"`
        );

        const s3Key = findS3KeyForFilename(filename);
        if (!s3Key) {
          console.log(
            `[Textract] Could not find any S3 object matching "${filename}".`
          );
          textractInfo = {
            status: "error",
            filename,
            s3Key: null,
            textPreview: null,
            errorMessage: `No S3 object found that matches the file name "${filename}".`,
          };
        } else {
          console.log(`[Textract] Matched to S3 key: ${s3Key}`);
          const ocrResult = await runTextractOnPdf(s3Key);

          if (ocrResult.status === "ok" && ocrResult.text) {
            const preview = ocrResult.text.slice(0, 2500); // keep prompt small
            textractInfo = {
              status: "ok",
              filename,
              s3Key,
              textPreview: preview,
              errorMessage: null,
            };
          } else {
            textractInfo = {
              status: "error",
              filename,
              s3Key,
              textPreview: null,
              errorMessage: ocrResult.errorMessage,
            };
          }
        }
      }
    }

    // 3) Build system prompt describing behaviour
    let systemPrompt = `
You are "OHLA GPT — I-5 Project Assistant" for the Santa Clarita I-5 North County Enhancement Project.

You have access to a summary of the OHLA I-5 project documents stored in an AWS S3 bucket (permits, POTDs, RFIs, PCOs, contracts, submittals, specs, etc.).
You also have general civil-construction knowledge.

First, try to answer using the OHLA I-5 project context only. If the question clearly cannot be answered from project context, you may fall back on general knowledge, but you must clearly say when you are doing that.

If the question asks for project financial / cost information and the user did not provide the correct admin password, respond ONLY with:
"Financial questions need admin permission."

Project file summary (from S3):

${s3IndexSummary || "No S3 index is currently loaded."}
`;

    if (textractInfo.status === "ok" && textractInfo.textPreview) {
      systemPrompt += `

Additional extracted text from the PDF "${textractInfo.filename}" (via AWS Textract).
Use this as highly relevant context if the user is asking about that document:

"""${textractInfo.textPreview}"""
`;
    }

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.2,
    });

    const answer = (completion.choices[0].message.content || "").trim();

    res.json({
      fromFiles: true,
      answer,
      needsPassword: false,
      textract: textractInfo,
    });
  } catch (err) {
    console.error("Error in /api/chat:", err);
    res.status(500).json({
      fromFiles: false,
      answer: "Sorry, something went wrong while processing your request.",
      needsPassword: false,
      textract: {
        status: "error",
        filename: null,
        s3Key: null,
        textPreview: null,
        errorMessage: "Internal server error in /api/chat.",
      },
    });
  }
});

// ===== Fallback: serve index.html =====
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===== Start server after loading S3 index =====
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
