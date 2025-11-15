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

// ========== OpenAI client ==========
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ========== AWS SDK (S3 + Textract) ==========
const AWS_REGION = process.env.AWS_REGION || "us-east-2";
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = process.env.S3_PREFIX || "GPT Files/";

AWS.config.update({ region: AWS_REGION });

const s3 = new AWS.S3();
const textract = new AWS.Textract();

// ========== In-memory S3 index ==========
let s3IndexSummary = "";
let s3ObjectKeys = []; // full S3 keys
let s3IndexJson = null;

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
    // 1) Optional custom index.json (hand-maintained)
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
        Array.isArray(json) ? json.length : 0,
        "entries"
      );
    } catch (err) {
      console.log(
        "No index.json found or failed to parse – proceeding with object list only."
      );
    }

    // 2) List all objects under prefix for filename search
    const parts = [];
    s3ObjectKeys = [];
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

        const shortKey = key.replace(S3_PREFIX, "");
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
          )}\n\nUse these names when referring to documents (permits, RFIs, PCOs, specs, submittals, etc.).`
        : "No project files were found in S3.";

    console.log(
      "Built S3 index summary with",
      parts.length,
      "objects (",
      s3ObjectKeys.length,
      "keys )."
    );
  } catch (err) {
    console.error("Error while loading S3 index:", err);
  }
}

// ========== Helpers ==========

// very rough financial question detector
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

// find S3 key(s) for a filename mentioned in the user message
function findS3KeyForFilename(filename) {
  if (!filename || !s3ObjectKeys || s3ObjectKeys.length === 0) return null;
  const lowerName = filename.toLowerCase();

  const match = s3ObjectKeys.find((key) =>
    key.toLowerCase().endsWith(lowerName)
  );

  return match || null;
}

// extract first filename like "something.pdf" from text
function extractFilenameFromText(text) {
  if (!text) return null;
  const regex = /([0-9A-Za-z_\-\.]+?\.(pdf|docx?|xlsx?|xls))/i;
  const m = text.match(regex);
  return m ? m[1] : null;
}

// Textract + S3-based cache
async function getDocumentTextFromS3Key(s3Key) {
  if (!S3_BUCKET || !s3Key) return null;

  // cache key: <S3_PREFIX>__cache/<relative_path>.txt
  const relative = s3Key.replace(S3_PREFIX, "");
  const cacheKey = path.posix.join(S3_PREFIX, "__cache", relative + ".txt");

  console.log("Looking for cached text at:", cacheKey);

  // 1) Try cache first
  try {
    const cacheObj = await s3
      .getObject({
        Bucket: S3_BUCKET,
        Key: cacheKey,
      })
      .promise();

    const cachedText = cacheObj.Body.toString("utf-8");
    console.log("✓ Cache hit for", s3Key);
    return cachedText;
  } catch (err) {
    if (err.code !== "NoSuchKey") {
      console.warn(
        "Cache lookup error for",
        cacheKey,
        "- proceeding to Textract:",
        err.code || err.message
      );
    } else {
      console.log("No cached text found for", cacheKey);
    }
  }

  console.log("No cached text for", s3Key, "– running Textract...");

  // 2) Call Textract directly on S3 object
  let texResult;
  try {
    texResult = await textract
      .detectDocumentText({
        Document: {
          S3Object: {
            Bucket: S3_BUCKET,
            Name: s3Key,
          },
        },
      })
      .promise();
  } catch (err) {
    console.error(
      "Textract error for",
      s3Key,
      "-",
      err.code || err.message || err
    );
    throw err;
  }

  const lines = (texResult.Blocks || [])
    .filter((b) => b.BlockType === "LINE" && b.Text)
    .map((b) => b.Text.trim());

  const text = lines.join("\n");

  console.log(
    "Textract completed for",
    s3Key,
    "- extracted",
    lines.length,
    "lines."
  );

  // 3) Save to cache (best effort)
  try {
    await s3
      .putObject({
        Bucket: S3_BUCKET,
        Key: cacheKey,
        Body: text,
        ContentType: "text/plain; charset=utf-8",
      })
      .promise();
    console.log("Cached Textract text at", cacheKey);
  } catch (err) {
    console.warn("Failed to write cache object", cacheKey, "-", err.message);
  }

  return text;
}

// ========== Middleware ==========
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ========== API: /api/chat ==========
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = (req.body && req.body.message) || "";
    const financePassword = (req.body && req.body.financePassword) || "";
    const FINANCE_PASSWORD = process.env.FINANCE_PASSWORD || "";

    console.log("=== Incoming question ===");
    console.log("Q:", userMessage);

    // 1) Financial guardrail
    if (isFinancialQuestion(userMessage)) {
      console.log("Detected financial question.");
      if (!FINANCE_PASSWORD || financePassword !== FINANCE_PASSWORD) {
        console.log("Rejected – missing or incorrect FINANCE_PASSWORD.");
        return res.json({
          fromFiles: true,
          answer:
            "Financial questions need admin permission. Please provide the admin password to proceed.",
          needsPassword: true,
        });
      } else {
        console.log("Finance password accepted.");
      }
    }

    // 2) Try to detect a filename and get OCR text
    let preview = null;
    let fileContextText = "";
    const filename = extractFilenameFromText(userMessage);

    if (filename) {
      console.log("Detected filename in question:", filename);
      const s3Key = findS3KeyForFilename(filename);

      if (s3Key) {
        console.log("Matched filename to S3 key:", s3Key);

        try {
          const fullText = await getDocumentTextFromS3Key(s3Key);

          if (fullText && fullText.trim()) {
            // keep a chunk for the model, and a shorter chunk for the UI preview
            const maxForModel = 6000;
            const maxForPreview = 1500;

            fileContextText = fullText.slice(0, maxForModel);
            preview = {
              filename,
              s3Key,
              text: fullText.slice(0, maxForPreview),
            };
          } else {
            console.log(
              "Textract returned empty text for",
              s3Key,
              "- no preview."
            );
          }
        } catch (err) {
          console.error(
            "Error while getting Textract text for",
            filename,
            "-",
            err.code || err.message
          );
        }
      } else {
        console.log(
          "Could not match filename",
          filename,
          "to any S3 key in the index."
        );
      }
    } else {
      console.log("No filename detected in question.");
    }

    // 3) Build system prompt describing behaviour
    const systemPrompt = `
You are "OHLA GPT — I-5 Project Assistant" for the Santa Clarita I-5 North County Enhancement Project.

You know about OHLA I-5 project documents stored in an AWS S3 bucket (permits, RFIs, PCOs, contracts, submittals, specs, etc.).
You also have general civil-construction knowledge.

First, try to answer using the OHLA I-5 project context only. If the question clearly cannot be answered from project context, you may fall back on general knowledge, but clearly say when you do so.

If the question asks for project financial / cost information and the user did not provide the correct admin password, respond ONLY with:
"Financial questions need admin permission."

Project file summary (from S3):

${s3IndexSummary || "No S3 index is currently loaded."}

${
  fileContextText
    ? `\n\nIf the user is asking about the file "${filename}", here is OCR text extracted from that document (possibly truncated):\n\n${fileContextText}\n\nUse this document text as the primary source when answering. Summarize and explain in plain language.`
    : ""
}
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
      { role: "user", content: userMessage },
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.2,
    });

    const answer = completion.choices[0].message.content.trim();

    console.log("Answer length:", answer.length, "chars");

    res.json({
      fromFiles: true,
      answer,
      needsPassword: false,
      preview, // <-- OCR preview for the UI
    });
  } catch (err) {
    console.error("Error in /api/chat:", err);
    res.status(500).json({
      fromFiles: false,
      answer:
        "Sorry, something went wrong while processing your request. Please try again.",
    });
  }
});

// ========== Fallback: serve index.html ==========
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ========== Start server after loading S3 index ==========
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
