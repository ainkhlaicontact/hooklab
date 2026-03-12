const express = require("express");
const OpenAI = require("openai");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const APP_URL = process.env.APP_URL || "http://localhost:3000";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

const requiredEnv = [
  "OPENAI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY"
];

const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error("Missing required environment variables:", missingEnv.join(", "));
  process.exit(1);
}

app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);

app.use(
  cors({
    origin: APP_URL,
    methods: ["GET", "POST"],
    credentials: false
  })
);

app.use(express.json({ limit: "10kb" }));
app.use(express.static("."));

const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many hook generation requests. Please try again later."
  }
});

const waitlistLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many waitlist attempts. Please try again later."
  }
});

const analyticsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many analytics requests."
  }
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

function sanitizeText(value = "", maxLength = 120) {
  return String(value).trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function isValidEmail(email = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(email).trim().toLowerCase()
  );
}

function safeJson(res, status, payload) {
  return res.status(status).json(payload);
}

app.get("/health", async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from("waitlist")
      .select("id")
      .limit(1);

    if (error) {
      console.error("Health check Supabase error:", error);
      return safeJson(res, 500, {
        ok: false,
        env: NODE_ENV,
        db: "down",
        timestamp: new Date().toISOString()
      });
    }

    return safeJson(res, 200, {
      ok: true,
      env: NODE_ENV,
      db: "up",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Health route error:", error);
    return safeJson(res, 500, {
      ok: false,
      env: NODE_ENV,
      db: "down",
      timestamp: new Date().toISOString()
    });
  }
});

app.post("/generate-hooks", generateLimiter, async (req, res) => {
  try {
    const topic = sanitizeText(req.body.topic, 120);
    const audience = sanitizeText(req.body.audience, 120);
    const platform = sanitizeText(req.body.platform, 40);
    const tone = sanitizeText(req.body.tone || "curiosity", 40);

    if (!topic || !audience || !platform) {
      return safeJson(res, 400, {
        error: "Missing topic, audience, or platform."
      });
    }

    const allowedPlatforms = ["TikTok", "YouTube Shorts"];
    const allowedTones = ["curiosity", "bold", "educational", "dramatic"];

    if (!allowedPlatforms.includes(platform)) {
      return safeJson(res, 400, {
        error: "Invalid platform."
      });
    }

    const safeTone = allowedTones.includes(tone) ? tone : "curiosity";

    const input = `
Create 10 viral short-video hooks.

Topic: ${topic}
Audience: ${audience}
Platform: ${platform}
Tone: ${safeTone}

Rules:
- max 10 words
- one hook per line
- no intro text
- no bullet points
- no numbering
- make them punchy and scroll-stopping
- output only the hooks
`;

    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input
    });

    const output = (response.output_text || "").trim();

    if (!output) {
      return safeJson(res, 500, {
        error: "No output returned from AI."
      });
    }

    return safeJson(res, 200, { output });
  } catch (error) {
    console.error("Hook generation error:", error);

    if (error?.status === 429) {
      return safeJson(res, 429, {
        error: "Rate limit or quota issue. Please try again shortly."
      });
    }

    return safeJson(res, 500, {
      error: "Failed to generate hooks."
    });
  }
});

app.post("/waitlist", waitlistLimiter, async (req, res) => {
  try {
    const email = sanitizeText(req.body.email, 160).toLowerCase();

    if (!email || !isValidEmail(email)) {
      return safeJson(res, 400, {
        error: "Please enter a valid email address."
      });
    }

    const { error } = await supabaseAdmin
      .from("waitlist")
      .insert([{ email, source: "hooklab-web" }]);

    if (error) {
      const code = String(error.code || "");
      const message = String(error.message || "").toLowerCase();

      if (code === "23505" || message.includes("duplicate") || message.includes("unique")) {
        return safeJson(res, 409, {
          error: "This email is already on the waitlist."
        });
      }

      console.error("Supabase waitlist error:", error);
      return safeJson(res, 500, {
        error: "Failed to save waitlist email."
      });
    }

    return safeJson(res, 201, {
      success: true,
      message: "You are on the waitlist."
    });
  } catch (error) {
    console.error("Waitlist route error:", error);
    return safeJson(res, 500, {
      error: "Failed to save waitlist email."
    });
  }
});

app.post("/events", analyticsLimiter, async (req, res) => {
  try {
    const name = sanitizeText(req.body.name, 60);
    const meta =
      req.body.meta && typeof req.body.meta === "object" ? req.body.meta : {};

    if (!name) {
      return safeJson(res, 400, {
        error: "Missing event name."
      });
    }

    const { error } = await supabaseAdmin
      .from("events")
      .insert([{ name, meta }]);

    if (error) {
      console.error("Supabase events error:", error);
      return safeJson(res, 500, {
        error: "Failed to store event."
      });
    }

    return safeJson(res, 200, { ok: true });
  } catch (error) {
    console.error("Events route error:", error);
    return safeJson(res, 400, {
      error: "Invalid event payload."
    });
  }
});

app.use((req, res) => {
  return safeJson(res, 404, {
    error: "Route not found."
  });
});

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);
  return safeJson(res, 500, {
    error: "Internal server error."
  });
});

app.listen(PORT, () => {
  console.log(`HookLab running at ${APP_URL}`);
  console.log(`Server listening on port ${PORT}`);
});