import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import lunr from "lunr";
const SESSION_MEMORY = new Map();

const COUNTRY_ALIASES = {
  CRO: ["cro", "croatia", "hr", "hrvatska", "hrv", "cro "],
  PL: ["pl", "poland", "polska"],
  IT: ["it", "italy", "italia"],
  GR: ["gr", "greece", "hellas", "ellada"],
  LT: ["lt", "lithuania", "lietuva"],
};

const COUNTRY_NAMES = {
  CRO: "Croatia",
  PL: "Poland",
  IT: "Italy",
  GR: "Greece",
  LT: "Lithuania",
};

function normalizeToken(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9čćđšž]+/gi, "").trim();
}

function detectCountryInMessage(message) {
  const raw = (message || "").toLowerCase();
  const tokens = raw.split(/\s+/).map(normalizeToken).filter(Boolean);

  for (const [code, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (tokens.includes(code.toLowerCase())) return code;
    for (const a of aliases) {
      if (tokens.includes(normalizeToken(a))) return code;
    }
  }
  return null;
}

function stripCountryFromMessage(message) {
  const raw = (message || "").toLowerCase();
  const words = raw.split(/\s+/);

  const removeSet = new Set();
  for (const [code, aliases] of Object.entries(COUNTRY_ALIASES)) {
    removeSet.add(code.toLowerCase());
    aliases.forEach(a => removeSet.add(normalizeToken(a)));
  }

  const kept = words.filter(w => !removeSet.has(normalizeToken(w)));
  return kept.join(" ").trim();
}

function inferCountryFromFilename(filename) {
  const f = (filename || "").toLowerCase();

  // po tvojim KB filenameovima:
  if (f.includes("croatia")) return "CRO";
  if (f.includes("poland")) return "PL";
  if (f.includes("italy")) return "IT";
  if (f.includes("greece")) return "GR";
  if (f.includes("lithuania")) return "LT";

  // core/global dokumenti:
  return "GLOBAL";
}

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
  const cleaned = (md || "").trim();

  // Split into Q blocks: find lines starting with "Q:"
  const lines = cleaned.split(/\r?\n/);

  const blocks = [];
  let current = null;

  const pushCurrent = () => {
    if (current && current.question && current.bodyLines.length) blocks.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();

    // ignore empty or separator lines
    if (!line) continue;
    if (/^=+$/.test(line)) continue;
    if (/^-+$/.test(line)) continue;

    // New question block
    if (/^Q:\s*/i.test(line)) {
      pushCurrent();
      current = { question: line.replace(/^Q:\s*/i, "").trim(), bodyLines: [] };
      continue;
    }

    // Add content lines to current block
    if (current) current.bodyLines.push(line);
  }
  pushCurrent();

  const chunks = blocks.map((block, i) => {
    const q = block.question;
    const body = block.bodyLines.join("\n");

    const short = extractSection(body, "Short");
    const full = extractSection(body, "Full");
    const example = extractSection(body, "Example");
    const task = extractSection(body, "Mini Task");

    return {
      id: `${filename}::Q${i + 1}`,
      title: `${filename} :: ${q}`,
      text: [q, short, full, example, task].filter(Boolean).join("\n"),
      answerShort: short,
      answerFull: full,
      answerExample: example,
      answerTask: task,
      filename,
      countryCode: inferCountryFromFilename(filename),
    };
  });

  return chunks;
}

function extractSection(body, sectionName) {
  // grabs text after "### {sectionName}" until next "### " or end
  const re = new RegExp(
    `###\\s*${escapeReg(sectionName)}\\s*\\n([\\s\\S]*?)(?=\\n###\\s|$)`,
    "i"
  );
  const m = body.match(re);
  if (!m) return null;

  return m[1]
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeReg(s) {
  return (s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      return "You’re welcome! Tell me the country (CRO/PL/IT/GR/LT) and the topic, and I’ll answer faster.";
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
  return "I’m specialized only for the S.O.S. Erasmus project content, so I can’t answer that. Please ask about science, engineering, art, green skills, or green jobs in CRO/PL/IT/GR/LT.";
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

function sanitizeForLunr(q) {
  return (q || "")
    .toLowerCase()
    .replace(/['"]/g, " ")          // makni navodnike
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // makni interpunkciju (uklj. ? ! : etc.)
    .replace(/\s+/g, " ")
    .trim();
}

function pickTop(query, k = 5) {
  if (!KB_INDEX) return [];
  const safe = sanitizeForLunr(query);
if (!safe) return [];
const results = KB_INDEX.search(safe).slice(0, k);
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

function formatAnswer(message, hits) {
  const best = hits[0];
  if (!best || best.score < 0.15) return null;

  const c = best.chunk;
  const clean = (t) => (t || "")
    .replace(/=+/g, " ")
    .replace(/-+/g, " ")
    .replace(/###\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  let short = clean(c.answerShort);
  const cc = c.countryCode && c.countryCode !== "GLOBAL" ? c.countryCode : null;

  if (short) return { reply: cc ? `(${cc}) ${short}` : short };

  return null;
}

// ---------- Routes ----------
app.get("/", (req, res) => res.send("S.O.S. chatbot server running"));

app.post("/chat", (req, res) => {
  const message = (req.body?.message || "").toString().trim();
  if (!message) return res.status(400).json({ error: "Missing message" });

  const sessionId = req.ip; // simple session
  const state = SESSION_MEMORY.get(sessionId) || {};
  const detected = detectCountryInMessage(message);

  // if user inputs only "CRO" / "PL" / ...
  if (detected && stripCountryFromMessage(message).length === 0) {
    SESSION_MEMORY.set(sessionId, { ...state, country: detected });
    return res.json({ reply: `OK — using ${detected}. Ask your question.` });
  }

  // if user inputs "CRO green job" -> detect CRO and remove token from query
  let country = state.country || null;
  let queryMessage = message;

  if (detected) {
    country = detected;
    queryMessage = stripCountryFromMessage(message);
    SESSION_MEMORY.set(sessionId, { ...state, country });
  }

  const hitsAll = pickTop(expandQuery(queryMessage), 15);
  const hits = country ? hitsAll.filter(h => h.chunk?.countryCode === country) : hitsAll;

  const out = formatAnswer(queryMessage, hits.length ? hits : hitsAll, sessionId);
  if (!out) return res.json({ reply: outOfScopeReply() });

  return res.json(out);
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