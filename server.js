// server.js
// OHLA GPT — I-5 Project Assistant (S3 hybrid search + OpenAI)

require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");
const fetch = require("node-fetch");
const AWS = require("aws-sdk");
const XLSX = require("xlsx");

const app = express();

// ---------- CONFIG ----------

// IMPORTANT: these MUST exist in Render Environment tab
const {
  OPENAI_API_KEY,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
  S3_BUCKET,
  S3_PREFIX,
  FINANCE_PASSWORD,
  SESSION_SECRET,
  PORT
} = process.env;

// Basic sanity logs (no secrets)
console.log("=== OHLA GPT STARTUP ===");
console.log("AWS_REGION:", AWS_REGION);
console.log("S3_BUCKET:", S3_BUCKET);
console.log("S3_PREFIX:", S3_PREFIX);
console.log("FINANCE_PASSWORD set:", !!FINANCE_PASSWORD);
console.log("========================");

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is missing");
}
if (!S3_BUCKET) {
  console.warn("S3_BUCKET is not set. S3 search will be DISABLED.");
}

// Configure AWS SDK
if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && AWS_REGION) {
  AWS.config.update({
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
    region: AWS_REGION
  });
}

const s3 = new AWS.S3();

// ---------- EXPRESS MIDDLEWARE ----------

app.use(express.json({ limit: "10mb" }));
app.use(
  session({
    secret: SESSION_SECRET || "ohlagpt_default_secret",
    resave: false,
    saveUninitialized: true
  })
);

// Serve static files (front-end)
app.use(express.static(path.join(__dirname, "public")));

// ---------- HELPERS ----------

function isFinancialQuestion(text) {
  if (!text) return false;
  const t = text.toLowerCase();

  const keywords = [
    "cost",
    "costs",
    "price",
    "prices",
    "budget",
    "estimate",
    "amount",
    "dollars",
    "dollar",
    "$",
    "pay item",
    "pay items",
    "change order",
    "pco",
    "rco",
    "invoice",
    "payment",
    "extra work bill",
    "ewb",
    "unit price",
    "lump sum"
  ];

  return keywords.some((word) => t.includes(word));
}

// Read a stream (S3 object) into a string Buffer
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// Extract text from common file types
async function extractTextFromS3Object(obj) {
  const key = obj.Key || "";
  const lower = key.toLowerCase();

  // Only process "light" file types for now
  const allowed =
    lower.endsWith(".txt") ||
    lower.endsWith(".md") ||
    lower.endsWith(".csv") ||
    lower.endsWith(".json") ||
    lower.endsWith(".xls") ||
    lower.endsWith(".xlsx");

  if (!allowed) {
    return null;
  }

  const params = {
    Bucket: S3_BUCKET,
    Key: key
  };

  const data = await s3.getObject(params).promise();
  const body = data.Body;

  // Text-like files
  if (
    lower.endsWith(".txt") ||
    lower.endsWith(".md") ||
    lower.endsWith(".csv") ||
    lower.endsWith(".json")
  ) {
    return {
      key,
      text: body.toString("utf8")
    };
  }

  // Excel files (RFI log, permit logs, etc.)
  if (lower.endsWith(".xls") || lower.endsWith(".xlsx")) {
    try {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const wb = XLSX.read(buf, { type: "buffer" });
      let text = "";
      wb.SheetNames.forEach((sheetName) => {
        const ws = wb.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(ws);
        text += `\n\n[Sheet: ${sheetName}]\n${csv}`;
      });
      return { key, text };
    } catch (err) {
      console.error("Error reading Excel file:", key, err.message);
      return null;
    }
  }

  return null;
}

// Search S3 for relevant context
async function searchS3ForContext(query) {
  if (!S3_BUCKET) {
    return "";
  }

  console.log("Searching S3 for:", query);

  const params = {
    Bucket: S3_BUCKET,
    Prefix: S3_PREFIX || "",
    MaxKeys: 40
  };

  let continuationToken = undefined;
  let matchedDocs = [];
  const queryLower = (query || "").toLowerCase();

  try {
    do {
      const resp = await s3
        .listObjectsV2({ ...params, ContinuationToken: continuationToken })
        .promise();

      const objs = resp.Contents || [];

      for (const obj of objs) {
        if (matchedDocs.length >= 10) break;

        const extracted = await extractTextFromS3Object(obj);
        if (!extracted) continue;

        const textLower = extracted.text.toLowerCase();

        if (textLower.includes(queryLower)) {
          console.log("Matched S3 object:", extracted.key);
          matchedDocs.push(
            `From file: ${extracted.key}\n\n${extracted.text.substring(
              0,
              4000
            )}`
          );
        }
      }

      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
      if (matchedDocs.length >= 10) break;
    } while (continuationToken);

    const combined = matchedDocs.join("\n\n---\n\n");
    console.log("S3 context length:", combined.length);
    return combined;
  } catch (err) {
    console.error("Error searching S3:", err.message);
    return "";
  }
}

// Call OpenAI Chat Completion
async function callOpenAI(messages) {
  const url = "https://api.openai.com/v1/chat/completions";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      messages
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("OpenAI error:", res.status, txt);
    throw new Error("OpenAI API error");
  }

  const data = await res.json();
  const choice = data.choices && data.choices[0];
  return choice && choice.message && choice.message.content
    ? choice.message.content.trim()
    : "Sorry, I couldn't generate a response.";
}

// ---------- API ROUTES ----------

app.post("/api/chat", async (req, res) => {
  try {
    const { message, internetAllowed, financePassword } = req.body || {};
    const userQuestion = (message || "").trim();

    if (!userQuestion) {
      return res.json({ reply: "Please enter a question." });
    }

    // 1) Financial / cost questions require admin password
    if (isFinancialQuestion(userQuestion)) {
      if (!financePassword || financePassword !== FINANCE_PASSWORD) {
        return res.json({
          reply: "Financial questions need admin permission.",
          financialProtected: true
        });
      }
    }

    // 2) First try to answer using project documents (S3)
    let context = await searchS3ForContext(userQuestion);

    if (!context && !internetAllowed) {
      // No match in S3, and user has not allowed general knowledge yet
      return res.json({
        reply:
          "I couldn't find this in the current I-5 project documents I have. Do you want me to check general knowledge (similar to checking the internet)?",
        needsInternetPermission: true
      });
    }

    const systemPrompt = `
You are "OHLA GPT" — an assistant for the Santa Clarita I-5 North County Enhancement Project.
You help with RFIs, permits, PCOs, specs, contracts, submittals, and construction questions.

If project document context is provided, you MUST rely on it first and quote specific info.
If something is not covered in the documents AND internetAllowed=true, you may answer using your own general engineering knowledge.
Do not mention S3, AWS, OpenAI, or how the system is implemented.

If the user asks anything about finances or costs and I have already confirmed an admin password,
you can answer, but still keep the answer professional and concise.
    `.trim();

    const messages = [
      { role: "system", content: systemPrompt }
    ];

    if (context) {
      messages.push({
        role: "system",
        content:
          "Here are excerpts from I-5 project documents. Use them as the main reference:\n\n" +
          context
      });
    } else {
      messages.push({
        role: "system",
        content:
          "No project document context is available. Answer using only general knowledge."
      });
    }

    messages.push({
      role: "user",
      content: userQuestion
    });

    const reply = await callOpenAI(messages);

    return res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    return res.status(500).json({
      reply: "Sorry, something went wrong on the server."
    });
  }
});

// ---------- START SERVER ----------

const port = PORT || 10000;
app.listen(port, () => {
  console.log(`OHLA GPT (S3 hybrid) running on port ${port}`);
});
