// server.js
require("dotenv").config();

const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const OpenAI = require("openai");
const AWS = require("aws-sdk");
const pdfParse = require("pdf-parse");
const XLSX = require("xlsx");

const app = express();
const PORT = process.env.PORT || 10000;

// ========== OpenAI client ==========
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ========== AWS SDK (S3 only) ==========
const AWS_REGION = process.env.AWS_REGION || "us-east-2";
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = process.env.S3_PREFIX || "";

AWS.config.update({ region: AWS_REGION });
const s3 = new AWS.S3();

// ========== In-memory S3 index ==========
let s3IndexSummary = "";
let s3IndexJson = null;
let s3ObjectKeys = []; // full list of keys for matching

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
    // Optional human-maintained index.json
    try {
      const indexObj = await s3
        .getObject({
          Bucket: S3_BUCKET,
          Key: path.posix.join(S3_PREFIX, "index.json"),
        })
        .promise();

      const json = JSON.parse(indexObj.Body.toString("utf-8"));
      s3IndexJson = json;
      console.log("Loaded custom index.json from S3 with", json.length, "entries");
    } catch (err) {
      console.log(
        "No index.json found or failed to parse – proceeding with S3 object list only."
      );
    }

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

        const shortKey = S3_PREFIX ? key.replace(S3_PREFIX, "") : key;
        parts.push(shortKey);
      });

      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    s3IndexSummary =
      parts.length > 0
        ? `The OHLA I-5 project files in S3 include documents such as:\n- ${parts.join(
            "\n- "
          )}\n\nUse these names when referring to documents (POTDs, permits, RFIs, PCOs, specs, submittals, contracts, etc.).`
        : "No project files were found in S3.";

    console.log("Built S3 index summary with", parts.length, "objects.");
  } catch (err) {
    console.error("Error while loading S3 index:", err);
  }
}

// ========== Simple helpers ==========

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

function getFileNameFromKey(key) {
  return key.split("/").pop();
}

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[\s_\-]+/g, " ")
    .replace(/[()]/g, "")
    .trim();
}

/**
 * Try to guess which S3 object the user is talking about.
 * We score each key by how many of its "words" appear in the question.
 */
function findBestMatchingS3Key(question) {
  if (!question || s3ObjectKeys.length === 0) return null;

  const q = normalize(question);
  const qWords = q.split(/\s+/).filter((w) => w.length > 2);

  let bestKey = null;
  let bestScore = 0;

  for (const key of s3ObjectKeys) {
    const fileName = normalize(getFileNameFromKey(key));
    const fileWords = fileName.split(/\s+|\./).filter((w) => w.length > 2);

    let score = 0;
    for (const w of fileWords) {
      if (q.includes(w)) score += 1;
    }

    // Slight bonus if raw filename appears directly
    if (question.toLowerCase().includes(getFileNameFromKey(key).toLowerCase())) {
      score += 3;
    }

    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }

  if (bestScore >= 2) return bestKey;
  return null;
}

/**
 * Download a file from S3 as Buffer
 */
async function downloadS3Object(key) {
  const resp = await s3
    .getObject({
      Bucket: S3_BUCKET,
      Key: key,
    })
    .promise();
  return resp.Body;
}

/**
 * Extract text from various file types WITHOUT Textract.
 */
async function extractTextFromS3Key(key) {
  try {
    const buf = await downloadS3Object(key);
    const fileName = getFileNameFromKey(key).toLowerCase();

    console.log(`[OCR] Extracting text for key: ${key}`);

    if (fileName.endsWith(".pdf")) {
      const data = await pdfParse(buf);
      const text = (data.text || "").trim();
      if (!text) {
        console.log(`[OCR] pdf-parse returned empty text for ${fileName}`);
        return null;
      }
      return text;
    }

    if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
      const wb = XLSX.read(buf, { type: "buffer" });
      let textParts = [];
      wb.SheetNames.forEach((name) => {
        const sheet = wb.Sheets[name];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
        rows.forEach((row) => {
          textParts.push(row.join(" ").trim());
        });
      });
      const joined = textParts.join("\n").trim();
      return joined || null;
    }

    if (
      fileName.endsWith(".txt") ||
      fileName.endsWith(".csv") ||
      fileName.endsWith(".log")
    ) {
      return buf.toString("utf-8");
    }

    console.log(`[OCR] Unsupported file type for OCR: ${fileName}`);
    return null;
  } catch (err) {
    console.error(`[OCR] Error extracting text for ${key}:`, err);
    return null;
  }
}

/**
 * From a long document, pick the most relevant paragraphs for the question.
 * This keeps the context focused and makes answers more precise.
 */
function getRelevantExcerpt(fullText, question, maxChars = 12000) {
  if (!fullText) return null;
  if (fullText.length <= maxChars) return fullText;

  const qWords = new Set(
    normalize(question)
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );

  const paragraphs = fullText.split(/\n{2,}/); // split on blank lines
  const scored = paragraphs.map((p) => {
    const words = normalize(p).split(/\s+/);
    let score = 0;
    for (const w of words) {
      if (qWords.has(w)) score++;
    }
    return { p: p.trim(), score };
  });

  scored.sort((a, b) => b.score - a.score);

  let chosen = [];
  let total = 0;
  for (const { p, score } of scored) {
    // once we have at least one paragraph, skip completely irrelevant ones
    if (chosen.length > 0 && score === 0) break;

    if (!p) continue;
    if (total + p.length > maxChars) continue;
    chosen.push(p);
    total += p.length + 2;
    if (total >= maxChars) break;
  }

  if (chosen.length === 0) {
    // fallback: just take the beginning
    return fullText.slice(0, maxChars);
  }

  return chosen.join("\n\n");
}

// ========== Middleware ==========
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ========== /api/chat ==========
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = (req.body && req.body.message) || "";
    const financePassword = (req.body && req.body.financePassword) || "";
    const FINANCE_PASSWORD = process.env.FINANCE_PASSWORD || "";

    // --- Financial guardrail ---
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

    // --- Try to match a specific S3 file ---
    let matchedKey = null;
    let extractedText = null;
    let relevantText = null;
    let extractionNote = "";
    let textPreview = null;

    if (S3_BUCKET && s3ObjectKeys.length > 0) {
      matchedKey = findBestMatchingS3Key(userMessage);

      if (matchedKey) {
        console.log(
          `[OHLA-GPT] User question appears to mention file: "${getFileNameFromKey(
            matchedKey
          )}"`
        );

        extractedText = await extractTextFromS3Key(matchedKey);

        if (!extractedText) {
          extractionNote = `Could not extract text from S3 file "${getFileNameFromKey(
            matchedKey
          )}". I will answer using general project knowledge instead.`;
        } else {
          relevantText = getRelevantExcerpt(extractedText, userMessage, 12000);

          textPreview =
            relevantText && relevantText.length > 800
              ? relevantText.slice(0, 800) + " ..."
              : relevantText || null;

          console.log(
            `[OHLA-GPT] Extracted text length for "${getFileNameFromKey(
              matchedKey
            )}": ${extractedText.length} characters (using ${relevantText?.length ||
              0} chars as focused context)`
          );
        }
      } else {
        console.log(
          "[OHLA-GPT] No specific S3 file confidently matched – answering from general context."
        );
      }
    }

    // --- Build system prompt ---
    const fileName = matchedKey ? getFileNameFromKey(matchedKey) : null;

    let systemPrompt = `
You are "OHLA GPT — I-5 Project Assistant" for the Santa Clarita I-5 North County Enhancement Project.

You have access to:
- A high-level summary of project documents stored in an AWS S3 bucket (POTDs, permits, RFIs, PCOs, contracts, submittals, specs, etc.).
- When available, a focused excerpt of text extracted from a specific document the user is asking about.
- General civil-construction and project-controls knowledge.

If a focused document excerpt is provided, you MUST:
- Treat that excerpt as the primary source of truth.
- Answer the user's question by carefully reading that text.
- Explicitly extract the requested information (for example: list all dates, summarize key conditions, identify requirements, etc.).
- If the information the user asks for is not present in the excerpt, clearly say that it cannot be found instead of guessing.

When listing items (dates, requirements, conditions, etc.), use clear bullet points.

If no document excerpt is provided, first try to answer using the project context summary. Only if that is insufficient, fall back to general civil-construction knowledge and say that you are doing so.

If the question asks for project financial / cost information and the user did not provide the correct admin password, respond ONLY with:
"Financial questions need admin permission."
`;

    systemPrompt += `\n\nProject file summary (from S3):\n\n${s3IndexSummary ||
      "No S3 index is currently loaded."}\n`;

    if (relevantText && fileName) {
      systemPrompt += `\n\nThe user is asking about the specific document "${fileName}". Here is the focused excerpt from that document that should be used for answering the question:\n\n${relevantText}\n\n(End of excerpt.)\n`;
    } else if (fileName && !relevantText) {
      systemPrompt += `\n\nNote: Text could not be extracted from "${fileName}". Use project context and general knowledge only.\n`;
    }

    // Optional machine-readable index
    const indexJsonSnippet = s3IndexJson
      ? JSON.stringify(s3IndexJson).slice(0, 6000)
      : null;

    if (indexJsonSnippet) {
      systemPrompt += `\nAdditional machine-readable index data:\n${indexJsonSnippet}\n`;
    }

    // --- Call OpenAI ---
    const messages = [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userMessage,
      },
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.15, // a bit lower for more deterministic answers
    });

    const answer = completion.choices[0].message.content.trim();

    res.json({
      fromFiles: !!relevantText,
      answer,
      needsPassword: false,
      matchedFileKey: matchedKey || null,
      matchedFileName: fileName || null,
      ocrNote: extractionNote || null,
      sourceTextPreview: textPreview || null,
    });
  } catch (err) {
    console.error("Error in /api/chat:", err);
    res.status(500).json({
      fromFiles: false,
      answer: "Sorry, something went wrong while processing your request.",
    });
  }
});

// ========== Fallback: SPA routing ==========
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ========== Start server ==========
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
    console.log(`OHLA GPT (S3 hybrid, focused context) running on port ${PORT}`);
  });
})();
