import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

// IMPORTANT: OpenAI API Key comes from ENV (Render Environment Variable)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is not set. Add it in Render → Environment.");
  process.exit(1);
}

app.post("/api/concierge", async (req, res) => {
  try {
    const messages = req.body?.messages || [];
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages,
      temperature: 0.4
    });
    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "backend error" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🤖 Concierge listening on ${PORT}`);
});
