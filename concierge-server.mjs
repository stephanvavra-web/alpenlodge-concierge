import express from "express";
import cors from "cors";
import OpenAI from "openai";

// Alpenlodge Concierge Backend (Render)
// - Accepts BOTH: {messages:[...]} OR {question:"..."} (and {lang,page})
// - Always returns: {reply:"..."}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ✅ Only ENV key (Render → Environment Variables)
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("❌ OPENAI_API_KEY is missing. Set it in Render → Environment.");
  process.exit(1);
}
const openai = new OpenAI({ apiKey });

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// ✅ Health check for Render / monitoring
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

function buildMessages(body) {
  const b = body || {};
  const lang = (typeof b.lang === "string" ? b.lang : "de").toLowerCase();
  const page = typeof b.page === "string" ? b.page : "";

  // 1) Prefer explicit messages array (chat-style)
  let msgs = Array.isArray(b.messages) ? b.messages : [];

  // 2) Fallback: accept {question:"..."} or {message:"..."}
  const q =
    (typeof b.question === "string" && b.question.trim()) ||
    (typeof b.message === "string" && b.message.trim()) ||
    "";

  if ((!msgs || msgs.length === 0) && q) {
    msgs = [{ role: "user", content: q }];
  }

  const languageLine =
    lang.startsWith("en") ? "Answer in English." : "Antworte auf Deutsch.";

  const system = [
    "You are the Alpenlodge Concierge for a family-friendly apartment & suite lodge in Landl (Thiersee, Tyrol).",
    languageLine,
    "Be helpful, short, and practical.",
    "Do NOT invent prices, availability, or booking confirmations. If asked, direct guests to the booking page (/buchen/) or ask for dates and number of guests.",
    "If you don't know something, say so and suggest what to check next.",
    page ? `Current page context: ${page}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Prepend system message (but avoid double system if client already sent one)
  const hasSystem = Array.isArray(msgs) && msgs.some((m) => m && m.role === "system");
  const finalMessages = hasSystem ? msgs : [{ role: "system", content: system }, ...(msgs || [])];

  return { finalMessages, lang };
}

app.post("/api/concierge", async (req, res) => {
  try {
    const { finalMessages, lang } = buildMessages(req.body);

    // If still nothing, reply gracefully (no 500)
    if (!finalMessages || finalMessages.length === 0) {
      const txt = lang.startsWith("en")
        ? "I did not receive a message."
        : "Ich habe keine Nachricht erhalten.";
      return res.status(400).json({ reply: txt });
    }

    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: finalMessages,
      temperature: 0.4,
    });

    res.json({ reply: completion.choices?.[0]?.message?.content || "" });
  } catch (err) {
    console.error("❌ Concierge error:", err?.message || err);
    // keep it user-safe; optionally reveal details if DEBUG=1
    if (process.env.DEBUG === "1") {
      return res.status(500).json({ error: "backend error", details: String(err?.message || err) });
    }
    res.status(500).json({ error: "backend error" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🤖 Concierge listening on ${PORT}`));
