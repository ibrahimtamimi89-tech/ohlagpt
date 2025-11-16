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

// ===== In-memory index of project files =====
let s3IndexSummary = "";
let s3IndexJson = null;
// full list of objects so we can map filenames -> keys
let s3Objects = [];

// ---------- helpers for S3 / Textract ----------

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
    // 1) Try optional index.json (human-maintained)
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
      console.log("No index.json found or failed to parse – proceeding with object list only.");
    }

    // 2) Build a list of *all* objects under S3_PREFIX
    const parts = [];
    s3Objects = [];
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
        s3Objects.push(obj);
        const shortKey = S3_PREFIX ? key.replace(S3_PREFIX, "") : key;
        parts.push(shortKey);
      });

      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    s3IndexSummary =
      parts.length > 0
        ? `The OHLA I-5 project files in S3 include documents such as:\n- ${parts.join(
            "\n- "
          )}\n\nUse these names when referring to documents (permits, RFIs, PCOs, specs, submittals, etc.).`
        : "No project files were found in S3.";

    console.log("Built S3 index summary with", parts.length, "objects.");
  } catch (err) {
    console.error("Error while loading S3 index:", err);
  }
}

// Extract a PDF name from free-text user message
function extractPdfName(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  // first: something inside quotes "...pdf"
  const quoted = text.match(/"([^"]+\.pdf)"/i);
  if (quoted && quoted[1]) {
    return quoted[1].trim();
  }

  // second: first substring that looks like "<anything>.pdf"
  // allow letters, numbers, spaces, dots, dashes, underscores
  const match = text.match(/([a-z0-9._\- ]+\.pdf)/i);
  if (match && match[1]) {
    return match[1].trim();
  }

  // if the user just writes the file name alone
  if (lower.endsWith(".pdf")) {
    return text.trim();
  }

  return null;
}

// Given "2025.11.01 - POTD.pdf" find its full S3 key
function findS3KeyForPdf(pdfName) {
  if (!pdfName || !s3Objects.length) return null;

  const target = pdfName.toLowerCase().trim();

  // try exact endsWith match first (folder + filename)
  let found = s3Objects.find((obj) =>
    obj.Key.toLowerCase().endsWith("/" + target)
  );

  if (!found) {
    // maybe no folder, or slightly different path – just endsWith filename
    found = s3Objects.find((obj) => obj.Key.toLowerCase().endsWith(target));
  }

  return found ? found.Key : null;
}

// cache key for extracted text in S3
function textractCacheKeyFor(s3Key) {
  // Example:
  //   original: GPT Files/18 Permits/01. Encroachment Permits/0721ADP3197_Permit.pdf
  //   cache:   GPT Files/__cache/18 Permits/01. Encroachment Permits/0721ADP3197_Permit.pdf.txt
  const relative = S3_PREFIX ? s3Key.replace(S3_PREFIX, "") : s3Key;
  return path.posix.join(S3_PREFIX, "__cache", relative + ".txt");
}

// get cached Textract text or call Textract & cache
async function getOrExtractPdfText(s3Key) {
  if (!S3_BUCKET || !s3Key) return null;

  const cacheKey = textractCacheKeyFor(s3Key);
  console.log("[OHLA-GPT] Looking for cached text at S3 key:", cacheKey);

  // 1) try cache
  try {
    const cachedObj = await s3
      .getObject({
        Bucket: S3_BUCKET,
        Key: cacheKey,
      })
      .promise();

    const txt = cachedObj.Body.toString("utf-8");
    if (txt && txt.trim().length > 0) {
      console.log("[OHLA-GPT] Found cached Textract text.");
      return txt;
    }
  } catch (err) {
    console.log("[OHLA-GPT] No cached text found at", cacheKey, "- will run Textract...");
  }

  // 2) run Textract
  console.log("[OHLA-GPT] Downloading PDF source for Textract:", s3Key);

  const params = {
    Document: {
      S3Object: {
        Bucket: S3_BUCKET,
        Name: s3Key,
      },
    },
  };

  const textractResp = await textract
    .detectDocumentText(params)
    .promise()
    .catch((err) => {
      console.error(
        "Textract error for",
        s3Key,
        err && err.code,
        err && err.message
      );
      throw err;
    });

  const blocks = textractResp.Blocks || [];
  const lines = blocks
    .filter((b) => b.BlockType === "LINE" && b.Text)
    .map((b) => b.Text);
  const fullText = lines.join("\n");

  // cache it back to S3 for next time
  try {
    await s3
      .putObject({
        Bucket: S3_BUCKET,
        Key: cacheKey,
        Body: fullText,
        ContentType: "text/plain",
      })
      .promise();
    console.log("[OHLA-GPT] Cached Textract text to", cacheKey);
  } catch (err) {
    console.error("Failed to cache Textract result:", err);
  }

  return fullText;
}

// very rough detector for financial / cost questions
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

    // 2) Optional: detect PDF name and try Textract
    let pdfName = null;
    let pdfS3Key = null;
    let pdfExtractText = null;
    let textractNote = null;

    if (S3_BUCKET) {
      pdfName = extractPdfName(userMessage);
      if (pdfName) {
        console.log('[OHLA-GPT] Detected mentioned PDF name in question:', pdfName);
        pdfS3Key = findS3KeyForPdf(pdfName);

        if (pdfS3Key) {
          console.log("[OHLA-GPT] Mapped PDF name to S3 key:", pdfS3Key);
          try {
            pdfExtractText = await getOrExtractPdfText(pdfS3Key);
          } catch (err) {
            textractNote = `Textract could not read "${pdfName}". Reason: ${err.message || err.code || "Unknown error"}.`;
          }
        } else {
          textractNote = `Textract could not read "${pdfName}". Reason: No S3 object found for ${pdfName}.`;
          console.warn("[OHLA-GPT]", textractNote);
        }
      }
    }

    // 3) Build system prompt describing behaviour
    let systemPrompt = `
You are "OHLA GPT — I-5 Project Assistant" for the Santa Clarita I-5 North County Enhancement Project.

You have access to a summary of the OHLA I-5 project documents stored in an AWS S3 bucket (permits, RFIs, PCOs, contracts, submittals, specs, etc.).
You also have general civil-construction knowledge.

First, try to answer using the OHLA I-5 project context only. If the question clearly cannot be answered from project context, you may fall back on general knowledge, but you must clearly say when you are doing that.

If the question asks for project financial / cost information and the user did not provide the correct admin password, respond ONLY with:
"Financial questions need admin permission."

Project file summary (from S3):

${s3IndexSummary || "No S3 index is currently loaded."}
`;

    if (pdfExtractText) {
      systemPrompt += `
The user mentioned a specific PDF file (${pdfName}). The following text was extracted from that PDF using OCR (AWS Textract). You may use it to answer their question. If something is unclear, explain the limitation instead of guessing.

"""${pdfExtractText.slice(0, 8000)}"""
`;
    } else if (textractNote) {
      // internal note so the model knows why it doesn't see OCR text
      systemPrompt += `
Internal note: ${textractNote}
If you cannot see any extracted text from the PDF, explain that OCR was not available and answer based only on project summaries / general knowledge. Do not invent specific content from the file.
`;
    }

    // 4) Optional: include a compact JSON index for better grounding
    const indexJsonSnippet = s3IndexJson
      ? JSON.stringify(s3IndexJson).slice(0, 6000) // keep prompt small
      : null;

    if (indexJsonSnippet) {
      systemPrompt += `

Additional machine-readable index data:
${indexJsonSnippet}
`;
    }

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
      temperature: 0.2,
    });

    const answer = completion.choices[0].message.content.trim();

    res.json({
      fromFiles: true,
      answer,
      needsPassword: false,
      textractNote: textractNote || null,
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
