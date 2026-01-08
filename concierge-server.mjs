import express from "express";
import cors from "cors";
import OpenAI from "openai";
const THIERSEE = { lat: 47.5860, lon: 12.1070 };

async function getWeatherTomorrow() {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${THIERSEE.lat}&longitude=${THIERSEE.lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode` +
    `&timezone=Europe%2FVienna`;

  const r = await fetch(url);
  if (!r.ok) throw new Error("weather fetch failed");
  const data = await r.json();

  // Morgen = Index 1 (0 = heute)
  const i = 1;
  return {
    date: data.daily.time[i],
    tmin: data.daily.temperature_2m_min[i],
    tmax: data.daily.temperature_2m_max[i],
    pop: data.daily.precipitation_probability_max[i],
    code: data.daily.weathercode[i],
  };
}

function weatherText(w) {
  // Minimal-Mapping – reicht für Concierge
  const map = {
    0: "klar",
    1: "überwiegend klar",
    2: "teils bewölkt",
    3: "bewölkt",
    45: "Nebel",
    48: "Nebel",
    51: "leichter Niesel",
    61: "leichter Regen",
    63: "Regen",
    65: "starker Regen",
    71: "leichter Schnee",
    73: "Schnee",
    75: "starker Schnee",
    80: "Regenschauer",
    81: "kräftige Schauer",
    82: "heftige Schauer",
    95: "Gewitter",
  };
  const desc = map[w.code] ?? `Wettercode ${w.code}`;
  return `Wetter morgen (Thiersee, ${w.date}): ${desc}. ` +
         `Min ${w.tmin}°C / Max ${w.tmax}°C. Regenwahrscheinlichkeit bis ${w.pop}%.`;
}

function isWeatherQuestion(text = "") {
  const t = text.toLowerCase();
  return /(wetter|forecast|weather|regen|schnee|temperatur|sonnig|bewölkt)/.test(t);
}
const app = express();
app.use(cors());
app.use(express.json());

// ✅ Only ENV key (Render → Environment Variables)
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("❌ OPENAI_API_KEY is missing. Set it in Render → Environment.");
  process.exit(1);
}
const openai = new OpenAI({ apiKey });
// ✅ Health check for Render / monitoring
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});
app.post("/api/concierge", async (req, res) => {
  try {
    const messages = req.body?.messages || [];
const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";

if (isWeatherQuestion(lastUser)) {
  try {
    const w = await getWeatherTomorrow();
    return res.json({ reply: weatherText(w) });
  } catch (e) {
    // Fallback: ehrlich bleiben
    return res.json({ reply: "Ich kann das Live-Wetter gerade nicht abrufen. Bitte versuch es gleich nochmal." });
  }
}
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages,
      temperature: 0.4,
    });

    res.json({ reply: completion.choices?.[0]?.message?.content || "" });
  } catch (err) {
    console.error("❌ Concierge error:", err);
    res.status(500).json({ error: "backend error" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🤖 Concierge listening on ${PORT}`));