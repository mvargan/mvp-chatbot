import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import lunr from "lunr";
const SESSION_MEMORY = new Map(); // sessionId -> { country, fullText }

const app = express();
app.use(express.json({ limit: "128kb" }));
app.use(cors({ origin: "*", methods: ["POST", "GET"] }));
app.use("/chat", rateLimit({ windowMs: 60_000, max: 40 }));

// serve widget + test page
app.use("/public", express.static(path.join(process.cwd(), "public")));

// ---------- KB: load .md from ./kb and build chunks + search index ----------
const kbDir = path.join(process.cwd(), "kb");
let KB_CHUNKS = [];
let KB_INDEX = null;

function loadAllMdFiles() {
  return fs
    .readdirSync(kbDir)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .map((f) => ({
      filename: f,
      text: fs.readFileSync(path.join(kbDir, f), "utf8"),
    }));
}

function chunkMd(md, filename) {
  const parts = md.split(/\n##\s+/g);
  const chunks = [];

  // fallback if no headings
  if (parts.length <= 1) {
    const cleaned = md.trim();
    const size = 2200;
    const overlap = 200;
    let i = 0;
    let idx = 1;
    while (i < cleaned.length) {
      const end = Math.min(i + size, cleaned.length);
      const body = cleaned.slice(i, end).trim();
      if (body.length > 120) {
        chunks.push({
          id: `${filename}::chunk${idx}`,
          title: `${filename} :: chunk ${idx}`,
          text: body,
          filename,
        });
        idx++;
      }
      if (end === cleaned.length) break;
      i = Math.max(0, end - overlap);
    }
    return chunks;
  }

  // split by headings
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].trim();
    const lines = part.split("\n");
    const title = (lines[0] || `Section ${i}`).trim();
    const body = lines.slice(1).join("\n").trim();
    if (!body) continue;

    chunks.push({
      id: `${filename}::${title}`,
      title: `${filename} :: ${title}`,
      text: `## ${title}\n${body}`,
      filename,
    });
  }
  return chunks;
}

function buildIndex(chunks) {
  return lunr(function () {
    this.ref("id");
    this.field("title");
    this.field("text");
    // keep more literal matching for Q&A docs
    this.pipeline.remove(lunr.stemmer);
    chunks.forEach((c) => this.add(c));
  });
}

function reloadKb() {
  const docs = loadAllMdFiles();
  const all = [];
  for (const d of docs) all.push(...chunkMd(d.text, d.filename));
  KB_CHUNKS = all;
  KB_INDEX = buildIndex(KB_CHUNKS);
  return KB_CHUNKS.length;
}

// ---------- Intent handling (friendly + safe + SOS-only) ----------
function detectIntent(message) {
  const inappropriate = [
    /\b(sex|porn|nude|blowjob|fuck|dick|pussy)\b/i,
    /\b(kill myself|suicide|self harm)\b/i,
    /\b(hate|racist|nazi)\b/i,
  ];
  if (inappropriate.some((r) => r.test(message))) return "inappropriate";

  if (/^(hi|hello|hey|good morning|good afternoon|good evening)\b/i.test(message)) return "greeting";
  if (/\b(thanks|thank you|thx|ty)\b/i.test(message)) return "thanks";
  if (/\b(how are you|how r you|how's it going)\b/i.test(message)) return "howareyou";
  if (/\b(who are you|what are you|your name)\b/i.test(message)) return "identity";
  if (/\b(what can you do|help|how to use)\b/i.test(message)) return "help";

  return "domain";
}

function smallTalkReply(intent) {
  switch (intent) {
    case "greeting":
      return "Hi! I’m the S.O.S. chatbot. Ask me about the Erasmus S.O.S. project (science, engineering, art, green skills & green jobs).";
    case "thanks":
      return "You’re welcome! Tell me the country (HR/PL/IT/GR/LT) and the topic, and I’ll answer faster.";
    case "howareyou":
      return "I’m doing great — ready to help with the S.O.S. project. What topic are you working on?";
    case "identity":
      return "I’m the S.O.S. chatbot for a school Erasmus project. I answer only from the S.O.S. knowledge base.";
    case "help":
      return "Ask about: science, engineering, art, green skills or green jobs. Example: “Green jobs in Italy related to art?”";
    default:
      return null;
  }
}

function inappropriateReply() {
  return "I can’t help with that. I’m a school project chatbot focused on S.O.S. Erasmus topics. Please ask a respectful question about the project.";
}

function outOfScopeReply() {
  return "I’m specialized only for the S.O.S. Erasmus project content, so I can’t answer that. Please ask about science, engineering, art, green skills, or green jobs in HR/PL/IT/GR/LT.";
}

// query expansion = better matching (permutations)
function expandQuery(q) {
  let s = q;

  const repl = [
    [/eco jobs/gi, "green jobs sustainable jobs"],
    [/sustainable jobs/gi, "green jobs eco jobs"],
    [/green careers/gi, "green jobs"],
    [/green skill/gi, "green skills sustainable skills eco skills"],
    [/renewable energy/gi, "solar wind renewable energy"],
    [/recycling/gi, "waste sorting recycling circular economy"],
    [/circular economy/gi, "recycling reuse repair circular economy"],
    [/eco design/gi, "sustainable design green design"],
  ];
  for (const [re, add] of repl) if (re.test(s)) s = s + " " + add;

  return s;
}

// Function to sanitize queries for Lunr
function safeQuery(q) {
  return q
    .replace(/[^a-zA-Z0-9čćđšžČĆĐŠŽ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickTop(query, k = 5) {
  if (!KB_INDEX) return [];
  const q = safeQuery(query);
  if (!q) return [];

  const results = KB_INDEX.search(q).slice(0, k);
  const byId = new Map(KB_CHUNKS.map((c) => [c.id, c]));
  return results
    .map((r) => ({ score: r.score, chunk: byId.get(r.ref) }))
    .filter((x) => x.chunk);
}

function simplifySentence(sentence) {
  return sentence
    .replace(/\s{2,}/g, " ")
    .replace(/However,/gi, "")
    .replace(/Moreover,/gi, "")
    .replace(/In addition,/gi, "")
    .trim();
}

function formatAnswer(message, hits, sessionId) {
  const best = hits[0];
  if (!best || best.score < 0.35) return null;

  const text = best.chunk.text;

  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.length > 20);

  const bullets = sentences
    .slice(0, 3)
    .map(s => "• " + simplifySentence(s))
    .join("\n");

  SESSION_MEMORY.set(sessionId, {
    fullText: text,
    title: best.chunk.title
  });

  return {
    reply:
      bullets +
      "\n\nWould you like:\n" +
      "1) Full explanation\n" +
      "2) A simple example\n" +
      "3) A mini task?",
    sources: []
  };
}

// Helper function to apply country context to a query
function applyCountryToQuery(query, countryCode) {
  if (!countryCode) return query;
  // boost matching by adding country code + common name into query
  const extra = {
    HR: "HR Croatia CRO",
    PL: "PL Poland",
    IT: "IT Italy",
    GR: "GR Greece",
    LT: "LT Lithuania Lith"
  }[countryCode] || countryCode;

  return query + " " + extra;
}

// ---------- Routes ----------
app.get("/", (req, res) => res.send("S.O.S. chatbot server running"));

const COUNTRY_ALIASES = {
  HR: ["hr", "croatia", "croatian"],
  PL: ["pl", "poland", "polish"],
  IT: ["it", "italy", "italian"],
  GR: ["gr", "greece", "greek"],
  LT: ["lt", "lithuania", "lithuanian"]
};

function detectCountryFromText(text) {
  const t = text.toLowerCase();
  for (const [code, aliases] of Object.entries(COUNTRY_ALIASES)) {
    for (const a of aliases) {
      // match whole word to avoid accidental hits
      const re = new RegExp(`\\b${a}\\b`, "i");
      if (re.test(t)) return code;
    }
  }
  return null;
}

function countryPrompt() {
  return (
    "Which country do you mean? Please choose one:\n" +
    "• HR (Croatia)\n" +
    "• PL (Poland)\n" +
    "• IT (Italy)\n" +
    "• GR (Greece)\n" +
    "• LT (Lithuania)\n\n" +
    "Reply with the code (e.g., PL) or the country name."
  );
}

app.post("/chat", (req, res) => {
  const message = (req.body?.message || "").toString().trim();
  if (!message) return res.status(400).json({ error: "Missing message" });

  const sessionId = req.ip; // simple session

  const memory = SESSION_MEMORY.get(sessionId) || {};

  // 1) Detect explicit country in the current message
  const detected = detectCountryFromText(message);

  // 2) If user is replying with a country after we asked
  if (!detected) {
    const m = message.trim().toUpperCase();
    if (["HR", "PL", "IT", "GR", "LT"].includes(m)) {
      memory.country = m;
      SESSION_MEMORY.set(sessionId, memory);
      return res.json({ reply: `Great — I’ll use ${m}. Now ask your S.O.S. question.` });
    }
  }

  // 3) Save detected country into session memory
  if (detected) {
    memory.country = detected;
    SESSION_MEMORY.set(sessionId, memory);
  }

  const intent = detectIntent(message);

  if (intent === "inappropriate") return res.json({ reply: inappropriateReply(), sources: [] });

  if (intent !== "domain") {
    const r = smallTalkReply(intent);
    if (r) return res.json({ reply: r, sources: [] });
  }

  // If this is a domain question and no country is known yet, ask for country
  if (!memory.country) {
    return res.json({ reply: countryPrompt() });
  }

  const q = applyCountryToQuery(expandQuery(message), memory.country);
  const hits = pickTop(q, 5);

  // ✅ EARLY: if user replies with a country code, just store it and stop
  const code = message.trim().toUpperCase();
  if (["HR", "PL", "IT", "GR", "LT"].includes(code)) {
    memory.country = code;
    SESSION_MEMORY.set(sessionId, memory);
    return res.json({ reply: `Great — I'll use ${code}. Now ask your S.O.S. question.` });
  }

  // ...existing code...
});

// reload KB manually after editing kb/*.md
app.post("/admin/reload-kb", (req, res) => {
  const n = reloadKb();
  res.json({ ok: true, chunks: n });
});

// ---------- Boot ----------
const count = reloadKb();
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`S.O.S. chatbot running on :${port} (chunks: ${count})`));