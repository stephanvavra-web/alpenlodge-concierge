import fs from "fs";
import path from "path";
import OpenAI from "openai";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

if (!config.OPENAI_API_KEY || config.OPENAI_API_KEY.length < 20) {
  console.error("❌ OPENAI_API_KEY in config.json fehlt oder ist zu kurz.");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
});

const app = express();
app.use(cors());
app.use(express.json());

// Thiersee Koordinaten (ca. Landl 37)
const THIERSEE_LAT = 47.593;
const THIERSEE_LON = 12.091;

// Basis-Prompt für den Concierge
const SYSTEM_PROMPT = `
Du bist der freundliche AI Concierge der Alpenlodge Thiersee (Landl 37, 6335 Thiersee, Tirol).
Sprache: Immer Deutsch, ruhig, freundlich, hilfsbereit.

Du hilfst bei:
- Unterkunft, Anreise, Check-in, Hausinfos
- Aktivitäten im Sommer & Winter
- Fragen zur Region Thiersee / Kufsteinerland

Wenn dir zusätzlich AKTUELLE WETTERDATEN übergeben werden, darfst du daraus eine kompakte Wetterzusammenfassung machen.
Wenn KEINE Wetterdaten vorhanden sind, sag ehrlich, dass du keine Live-Daten hast und verweise auf Wetter-Apps (Bergfex, Meteoblue, ZAMG).
`;

// Wetter aus Open-Meteo holen (heute + morgen, sehr grob)
async function getWeatherSummary() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${THIERSEE_LAT}&longitude=${THIERSEE_LON}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Europe/Berlin`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Weather HTTP " + res.status);
  }
  const data = await res.json();
  if (!data.daily || !data.daily.time || data.daily.time.length < 1) {
    throw new Error("Weather data incomplete");
  }

  const dates = data.daily.time;
  const tMin = data.daily.temperature_2m_min;
  const tMax = data.daily.temperature_2m_max;
  const rainProb = data.daily.precipitation_probability_max;

  const today = 0;
  const tomorrow = dates.length > 1 ? 1 : 0;

  function line(idx, label) {
    return `${label}: min ${Math.round(tMin[idx])}°C, max ${Math.round(
      tMax[idx]
    )}°C, max. Niederschlagswahrscheinlichkeit ca. ${rainProb[idx]}%.`;
  }

  const parts = [
    "Aktuelle Wetterdaten für Thiersee (Quelle: Open-Meteo):",
    line(today, "Heute"),
  ];

  if (tomorrow !== today) {
    parts.push(line(tomorrow, "Morgen"));
  }

  return parts.join("\n");
}

// einfache Wetter-Intent-Erkennung
function isWeatherQuestion(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return false;
  const txt = (lastUser.content || "").toLowerCase();
  return /wetter|regen|schnee|temperatur|sturm|vorhersage|forecast/.test(txt);
}

app.post("/api/concierge", async (req, res) => {
  try {
    const { messages = [] } = req.body || {};

    let weatherContext = "";
    if (isWeatherQuestion(messages)) {
      try {
        weatherContext = await getWeatherSummary();
      } catch (err) {
        console.error("Weather fetch error:", err.message);
      }
    }

    const conversation = [
      { role: "system", content: SYSTEM_PROMPT },
      ...(weatherContext
        ? [
            {
              role: "system",
              content:
                "Zusätzliche Info für Wetterantworten:\n" + weatherContext,
            },
          ]
        : []),
      ...messages.map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: String(m.content || "").slice(0, 2000),
      })),
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: conversation,
      temperature: 0.5,
    });

    const reply =
      completion.choices?.[0]?.message?.content ??
      "Entschuldige – ich konnte gerade nicht antworten.";

    res.json({ reply });
  } catch (err) {
    console.error("Concierge Fehler:", err);
    res.status(500).json({ error: "backend error" });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(
    `🤖 Alpenlodge Concierge läuft auf http://localhost:${PORT}/api/concierge`
  );
});