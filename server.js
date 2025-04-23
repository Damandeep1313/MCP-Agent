/*******************************************************
 * server.js
 *
 * - If query includes "emailed" + "successfully": set connected_already='true'
 * - If query includes "emailed" + "failed": set connected_already='false'
 * - Otherwise, do store/search/history/ask logic as before.
 *******************************************************/
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { createClient } = require("@libsql/client");
const OpenAI = require("openai");

/*******************************************************
 * 1. CONFIGURATION
 *******************************************************/
const PORT = process.env.PORT || 3000;
const DB_URL = process.env.LIBSQL_DB_URL;
const DB_AUTH_TOKEN = process.env.LIBSQL_DB_AUTH_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!DB_URL || !OPENAI_API_KEY) {
  throw new Error("Missing DB_URL or OPENAI_API_KEY in .env");
}

// libSQL Client
const db = createClient({
  url: DB_URL,
  authToken: DB_AUTH_TOKEN,
});

// OpenAI Client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/*******************************************************
 * 2. HELPER: Chat-based LLM call to parse messy "store"
 *    text into a structured command: "store name=..., email=..., ..."
 *******************************************************/
async function parseWithLLM(rawText) {
  const systemPrompt = `
You are a helpful parser that extracts contact information from natural language. 
When the user has written something like "store some info for John, his email is john@xyz.com", 
you must convert it into a single line format like:

store name=John; email=john@xyz.com; company=...; last_contacted=...;

Include whichever fields you find (name, email, linkedin, company, last_contacted).
If any field is not found, omit it. Do not add extra text, just the line above.
Remember: never skip email if the user provided it explicitly.
`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: rawText },
  ];

  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: messages,
    temperature: 0.2,
  });

  return response.choices[0].message.content;
}

/*******************************************************
 * 3. HELPER: Generate Embedding (for semantic search)
 *******************************************************/
async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: text,
  });
  const vector = response?.data?.[0]?.embedding;
  if (!vector || !Array.isArray(vector)) {
    throw new Error("Embedding generation failed or returned invalid data");
  }
  return vector;
}

/*******************************************************
 * 4. HELPER: Convert Arrays <-> Buffer
 *******************************************************/
function floatArrayToBuffer(arr) {
  const float32Arr = new Float32Array(arr);
  return Buffer.from(float32Arr.buffer);
}

function bufferToFloatArray(buf) {
  try {
    const float32Arr = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    return Array.from(float32Arr);
  } catch (err) {
    console.error("❌ Failed to parse embedding buffer:", err);
    return [];
  }
}

/*******************************************************
 * 5. HELPER: Cosine Similarity
 *******************************************************/
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) {
    return null;
  }
  let dot = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] ** 2;
    normB += vecB[i] ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/*******************************************************
 * 6. PARSE THE "store" COMMAND (like "store name=..., email=...")
 *******************************************************/
function parseFields(storeString) {
  // remove "store" prefix if present
  let text = storeString.replace(/^store[:\s]*/i, "").trim();

  const parts = text.split(";");
  const result = {
    name: null,
    email: null,
    linkedin: null,
    company: null,
    last_contacted: null,
    content: text, // fallback
  };

  parts.forEach(part => {
    const [k, ...rest] = part.split("=");
    if (!k || rest.length === 0) return;

    const key = k.trim().toLowerCase();
    const value = rest.join("=").trim();

    if (key === "name") result.name = value;
    if (key === "email") result.email = value;
    if (key === "linkedin") result.linkedin = value;
    if (key === "company") result.company = value;
    if (key === "last_contacted") result.last_contacted = value;
  });

  return result;
}

/*******************************************************
 * 7. Naive Email Extractor (for "emailed X successfully/failed")
 *******************************************************/
function extractEmailFromText(text) {
  const emailRegex = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;
  const match = text.match(emailRegex);
  return match ? match[0] : null;
}

/*******************************************************
 * 8. EXPRESS APP + /ask ENDPOINT
 *******************************************************/
const app = express();
app.use(bodyParser.json());

app.post("/ask", async (req, res) => {
  try {
    console.log("\n==== Incoming Request ====");
    console.log("Headers:", req.headers);
    console.log("Body:", req.body);
    console.log("==========================");

    const user_id = req.header("x-uid");
    const conversation_id = req.header("x-conversation-id") || "default";
    const { query } = req.body;

    if (!user_id || !query) {
      return res.status(400).json({ error: "Missing x-uid header or 'query' in body" });
    }

    console.log(`\n🔎 /ask | user=${user_id} | convo=${conversation_id} | query="${query}"`);
    const lower = query.toLowerCase();

    /****************************************************
     * A) "emailed X successfully" => connected_already='true'
     * B) "emailed X failed" => connected_already='false'
     ****************************************************/
    if (lower.includes("emailed")) {
      const email = extractEmailFromText(query);
      if (!email) {
        return res.json({ error: "No email found in your statement." });
      }

      // check if it's "successfully" or "failed"
      if (
        lower.includes("successfully") ||
        lower.includes("delivered") ||
        lower.includes("completed") ||
        lower.includes("connected_already = true") ||
        (lower.includes("connected_already") && lower.includes("true"))
          ) {
        console.log(`[ACTION] Setting connected_already='true' for ${email}`);
        const { rows } = await db.execute({
          sql: "SELECT * FROM messages WHERE email=? LIMIT 1",
          args: [email],
        });
        if (!rows.length) {
          return res.json({ status: "not_found", message: `No record found for email=${email}.` });
        }
        await db.execute({
          sql: "UPDATE messages SET connected_already='true' WHERE email=?",
          args: [email],
        });
        return res.json({
          status: "ok",
          message: `Set connected_already='true' for email=${email}`,
        });
      }

      if (
        lower.includes("failed") ||
        (lower.includes("connected_already") && (
        lower.includes("failed") ||
        lower.includes("fail") ||
        lower.includes("unsuccessful")
          )) {
        console.log(`[ACTION] Setting connected_already='false' for ${email}`);
        const { rows } = await db.execute({
          sql: "SELECT * FROM messages WHERE email=? LIMIT 1",
          args: [email],
        });
        if (!rows.length) {
          return res.json({ status: "not_found", message: `No record found for email=${email}.` });
        }
        await db.execute({
          sql: "UPDATE messages SET connected_already='false' WHERE email=?",
          args: [email],
        });
        return res.json({
          status: "ok",
          message: `Set connected_already='false' for email=${email}`,
        });
      }
    }

    /****************************************************
     * 1) "STORE" DETECTION + LLM PARSING
     ****************************************************/
    if (lower.includes("store")) {
      // Step A: We ask LLM to parse the messy user text
      console.log("[ACTION] Interpreting user text with LLM...");
      const structuredCommand = await parseWithLLM(query);
      console.log("LLM structured command:", structuredCommand);

      // Step B: Now parse the structured command
      const parsed = parseFields(structuredCommand);
      const {
        name,
        email,
        linkedin,
        company,
        last_contacted,
        content,
      } = parsed;

      // If there's literally nothing to store, bail out
      if (!email && !name && !linkedin && !company && !content) {
        return res.json({ error: "LLM produced no fields to store." });
      }

      // Step C: Generate embedding
      const embeddingArray = await generateEmbedding(content);
      const embeddingBuf = floatArrayToBuffer(embeddingArray);

        // Step D: If no email AND no linkedin/company/name => treat as general log, store it
    if (!email && !linkedin && !name && !company) {
        console.log("[INFO] No contact fields found. Storing as a general message log.");
    
        const createdAt = new Date().toISOString();
        const result = await db.execute({
        sql: `
            INSERT INTO messages (
            user_id, conversation_id,
            name, email, linkedin, company, last_contacted,
            content, embedding, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        `,
        args: [
            user_id,
            conversation_id,
            null,
            null,
            null,
            null,
            null,
            content,
            embeddingBuf,
            createdAt,
        ],
        });
    
        return res.json({
        status: "ok",
        message: `Stored general message log [rowid=${result.lastInsertRowid}].`,
        });
    }
    
    // If email is missing but other contact fields are present, skip
    if (!email) {
        console.log("[SKIP] Contact info provided without email. Skipping insert.");
        return res.json({
        status: "skipped",
        message: "Missing email for contact. Insert skipped.",
        });
    }
    

      // Step E: If we do have an email => unify by email
      const { rows } = await db.execute({
        sql: "SELECT * FROM messages WHERE email = ? LIMIT 1",
        args: [email],
      });

      if (rows.length > 0) {
        // Found existing => partial update
        const existingRow = rows[0];
        console.log(`[ACTION] Found existing record with email=${email}, id=${existingRow.id}`);

        await db.execute({
          sql: `
            UPDATE messages
            SET
              user_id = ?,
              conversation_id = ?,
              name = CASE WHEN name IS NULL THEN ? ELSE name END,
              linkedin = CASE WHEN linkedin IS NULL THEN ? ELSE linkedin END,
              company = CASE WHEN company IS NULL THEN ? ELSE company END,
              last_contacted = CASE WHEN last_contacted IS NULL THEN ? ELSE last_contacted END,
              content = ?,
              embedding = ?,
              created_at = ?
            WHERE email = ?
          `,
          args: [
            user_id,
            conversation_id,
            name,
            linkedin,
            company,
            last_contacted,
            content,
            embeddingBuf,
            new Date().toISOString(),
            email,
          ],
        });

        return res.json({
          status: "ok",
          message: `Updated existing record (partial) for email=${email}.`,
        });
      } else {
        // Insert new
        console.log("[ACTION] No record found, inserting new row (email).");

        const createdAt = new Date().toISOString();
        const result = await db.execute({
          sql: `
            INSERT INTO messages (
              user_id, conversation_id,
              name, email, linkedin, company, last_contacted,
              content, embedding, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
          `,
          args: [
            user_id,
            conversation_id,
            name,
            email,
            linkedin,
            company,
            last_contacted,
            content,
            embeddingBuf,
            createdAt,
          ],
        });

        return res.json({
          status: "ok",
          message: `Inserted new record for email=${email} [rowid=${result.lastInsertRowid}].`,
        });
      }
    }

    /****************************************************
     * 2) SEARCH if query includes "search"
     ****************************************************/
    if (lower.includes("search")) {
      console.log("[ACTION] Searching data => we embed and compare.");
      const searchQuery = query.replace(/search/i, "").trim();

      if (!searchQuery) {
        return res.json({ error: "No search text found after removing 'search'." });
      }

      const queryEmbedding = await generateEmbedding(searchQuery);
      const { rows } = await db.execute({
        sql: `SELECT * FROM messages WHERE user_id = ? AND conversation_id = ?`,
        args: [user_id, conversation_id],
      });

      if (!rows.length) {
        return res.json({
          results: [],
          note: "No messages found for that user/conversation.",
        });
      }

      const scored = rows.map((row) => {
        const storedEmbedding = bufferToFloatArray(Buffer.from(row.embedding, "base64"));
        const score = cosineSimilarity(queryEmbedding, storedEmbedding);
        return {
          id: row.id,
          content: row.content,
          created_at: row.created_at,
          score,
        };
      }).filter(r => r.score !== null);

      scored.sort((a, b) => b.score - a.score);
      const top5 = scored.slice(0, 5);

      return res.json({
        results: top5,
        note: `Top 5 matches for "${searchQuery}".`,
      });
    }

    /****************************************************
     * 3) HISTORY if query includes "history"
     ****************************************************/
    if (lower.includes("history")) {
      console.log("[ACTION] Returning conversation history.");
      const { rows } = await db.execute({
        sql: `
          SELECT
            id, name, email, linkedin, company,
            last_contacted, content, created_at,
            connected_already
          FROM messages
          WHERE user_id = ? AND conversation_id = ?
          ORDER BY created_at ASC;
        `,
        args: [user_id, conversation_id],
      });

      return res.json({
        history: rows,
        note: `Full history for user=${user_id}, convo=${conversation_id}`,
      });
    }

    /****************************************************
     * 4) ELSE => "ASK" for top 3 matches
     ****************************************************/
    console.log("[ACTION] ASK => returning top 3 matching messages.");

    const queryEmbedding = await generateEmbedding(query);
    const { rows } = await db.execute({
      sql: `SELECT * FROM messages WHERE user_id = ? AND conversation_id = ?`,
      args: [user_id, conversation_id],
    });

    if (!rows.length) {
      return res.json({
        answer: [],
        note: "No stored data found for that user/conversation.",
      });
    }

    const scored = rows.map((row) => {
      const storedEmbedding = bufferToFloatArray(Buffer.from(row.embedding, "base64"));
      const score = cosineSimilarity(queryEmbedding, storedEmbedding);
      return {
        id: row.id,
        content: row.content,
        created_at: row.created_at,
        score,
      };
    }).filter(r => r.score !== null);

    scored.sort((a, b) => b.score - a.score);
    const top3 = scored.slice(0, 3);

    return res.json({
      answer: top3,
      note: "Strictly returning existing messages from DB, no AI text generation.",
    });
  } catch (err) {
    console.error("❌ Error in /ask route:", err);
    return res.status(500).json({ error: err.message });
  }
});

/*******************************************************
 * START SERVER
 *******************************************************/
app.listen(PORT, () => {
  console.log(`🚀 MCP server running on port ${PORT}`);
});
