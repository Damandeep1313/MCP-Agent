/*******************************************************
 * server.js
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

// OpenAI Client (for embeddings only)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/*******************************************************
 * 2. HELPER: Generate Embedding
 *    (Uses OpenAI's Embeddings for semantic search)
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
 * 3. HELPER: Convert Arrays <-> Buffer
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
 * 4. HELPER: Cosine Similarity
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
 * TABLE SCHEMA (in libSQL):
   CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     content TEXT NOT NULL,
     embedding BLOB NOT NULL,
     created_at TEXT NOT NULL
   );
 *******************************************************/

/*******************************************************
 * 5. EXPRESS APP
 *******************************************************/
const app = express();
app.use(bodyParser.json());

/*******************************************************
 * (A) SINGLE ENDPOINT: /ask
 * 
 * We detect the user’s intent by keywords:
 *   - "store"   => store the entire query minus the word "store"
 *   - "search"  => search for the entire query minus the word "search"
 *   - "history" => return conversation
 *   - otherwise => "ask" top 3 matches
 *******************************************************/
app.post("/ask", async (req, res) => {
  try {
    // Headers
    console.log("\n==== Incoming Request ====");
    console.log("Headers:", req.headers);
    console.log("Body:", req.body);
    console.log("==========================");
    const user_id = req.header("x-user-id");
    const conversation_id = req.header("x-conversation-id") || "default";

    // Body
    const { query } = req.body;

    if (!user_id || !query) {
      return res
        .status(400)
        .json({ error: "Missing x-user-id header or 'query' in body" });
    }

    console.log(`\n🔎 /ask | user=${user_id} | convo=${conversation_id} | query="${query}"`);

    const lower = query.toLowerCase();

    /****************************************************
     * 1) STORE if query includes "store"
     ****************************************************/
    if (lower.includes("store")) {
      console.log("[ACTION] Storing data => we embed and insert into DB.");
      // Remove "store" from the string to get the actual content
      // (simple approach—improve if you want more sophisticated parsing)
      const contentToStore = query.replace(/store/i, "").trim();

      if (!contentToStore) {
        return res.json({ error: "No content to store after removing 'store'." });
      }

      // Insert
      const createdAt = new Date().toISOString();
      const embeddingArray = await generateEmbedding(contentToStore);
      const embeddingBuf = floatArrayToBuffer(embeddingArray);

      await db.execute({
        sql: `
          INSERT INTO messages (user_id, conversation_id, content, embedding, created_at)
          VALUES (?, ?, ?, ?, ?);
        `,
        args: [user_id, conversation_id, contentToStore, embeddingBuf, createdAt],
      });

      return res.json({
        status: "ok",
        message: `Data stored: "${contentToStore}"`,
      });
    }

    /****************************************************
     * 2) SEARCH if query includes "search"
     ****************************************************/
    if (lower.includes("search")) {
      console.log("[ACTION] Searching data => we embed and compare.");
      // Remove "search" from the string
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
        return res.json({ results: [], note: "No messages found for that user/conversation." });
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
          SELECT id, content, created_at
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
