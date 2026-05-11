import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import lunr from "lunr";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_MEMORY = new Map();

const COUNTRY_ALIASES = {
  CRO: ["cro", "croatia", "hr", "hrvatska", "hrv", "cro "],
  PL: ["pl", "poland", "polska"],
  IT: ["it", "italy", "italia"],
  GR: ["gr", "greece", "hellas", "ellada", "greek"],
  LT: ["lt", "lithuania", "lietuva"],
};

function normalizeToken(s) {
  return (s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").trim();
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

function stripQuestionWords(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\b(what|who|where|when|why|how|is|are|do|does|did|can|could|should|would|tell|me|about|the|a|an|please|explain)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function norm(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s) {
  return norm(s).split(" ").filter(Boolean);
}

function exactQuestionMatch(queryMessage) {
  const q = norm(queryMessage);
  if (!q) return null;

  let best = null;

  for (const c of KB_CHUNKS) {
    const questions = (c.questions || []).map(norm);
    const keywords = (c.keywords || []).map(norm);
    const topics = (c.topics || []).map(norm);

    let score = 0;
    if (keywords.includes(q)) score = Math.max(score, 300);
    if (questions.includes(q)) score = Math.max(score, 250);
    if (topics.includes(q)) score = Math.max(score, 120);

    if (!score) continue;

    if (!best || score > best.score) {
      best = { score, chunk: c };
    }
  }

  return best ? best.chunk : null;
}

const app = express();
app.use(express.json({ limit: "128kb" }));
app.use(cors({ origin: "*", methods: ["POST", "GET"] }));
app.use("/chat", rateLimit({ windowMs: 60_000, max: 40 }));

// serve widget + test page
app.use("/public", express.static(path.join(__dirname, "public")));

// ---------- KB: load .json from ./kb and build chunks + search index ----------
const kbDir = path.join(__dirname, "kb");
let KB_CHUNKS = [];
let KB_INDEX = null;

function loadAllJsonFiles() {
  return fs
    .readdirSync(kbDir)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .sort()
    .map((f) => {
      const p = path.join(kbDir, f);
      const raw = fs.readFileSync(p, "utf8");

      // zaštita od BOM/zero-width sranja
      const cleaned = raw.replace(/^\uFEFF/, "");

      let data;
      try {
        data = JSON.parse(cleaned);
      } catch (e) {
        throw new Error(`KB JSON parse error in ${f}: ${e.message}`);
      }

      const entries = Array.isArray(data) ? data : (data.entries || []);
      if (!Array.isArray(entries)) {
        throw new Error(`KB JSON format error in ${f}: expected array or {entries: []}`);
      }

      return { filename: f, entries };
    });
}

function normalizeEntry(entry, filename, i) {
  const id = (entry && entry.id) ? String(entry.id) : `${filename}::E${i + 1}`;

  const topics = Array.isArray(entry?.topics) ? entry.topics.map(String) : [];
  const keywords = Array.isArray(entry?.keywords) ? entry.keywords.map(String).filter(Boolean) : [];
  const questions = Array.isArray(entry?.questions) ? entry.questions.map(String).filter(Boolean) : [];

  const answerShort = entry?.answerShort ? String(entry.answerShort) : "";
  const answerLong =
    entry?.answerLong ? String(entry.answerLong) :
    (entry?.answerFull ? String(entry.answerFull) : ""); // fallback ako imaš staro polje

  // tekst za indeksiranje
  const text = [
    ...questions,
    topics.join(" "),
    keywords.join(" "),
    answerShort,
    answerLong
  ].filter(Boolean).join("\n");

  return {
    id,
    title: `${filename} :: ${questions[0] || id}`,
    text,
    questions,
    topics,
    keywords,
    answerShort,
    answerLong,
    filename,
    countryCode: entry?.countryCode ? String(entry.countryCode).toUpperCase() : inferCountryFromFilename(filename),
  };
}

function buildIndex(chunks) {
  return lunr(function () {
    this.ref("id");
    this.field("title");
    this.field("text");
    this.pipeline.remove(lunr.stemmer);
    chunks.forEach((c) => this.add(c));
  });
}

function reloadKb() {
  const files = loadAllJsonFiles();
  const all = [];

  for (const file of files) {
    file.entries.forEach((e, i) => {
      all.push(normalizeEntry(e, file.filename, i));
    });
  }

  KB_CHUNKS = all;
  KB_INDEX = buildIndex(KB_CHUNKS);
  return KB_CHUNKS.length;
}

// ---------- Intent handling (friendly + safe + SOS-only) ----------
function detectIntent(message) {
  const normalizedMessage = norm(message);
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
  if (["help", "what can you do", "how to use", "how do i use this", "what can this bot do"].includes(normalizedMessage)) return "help";

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
function isYes(s) {
  return /^(y|yes|da|d|sure|ok|okay|more|opširnije|opsirnije|full)$/i.test((s || "").trim());
}

function isNo(s) {
  return /^(n|no|ne|nah|nope)$/i.test((s || "").trim());
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
    [/school/gi, "partner school coordinator country"],
    [/project/gi, "erasmus project partner schools coordinators"],
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

function keywordSearch(query, k = 8) {
  const q = norm(query);
  if (!q) return [];

  const qTokens = tokenize(q).filter((token) => token.length >= 2);
  if (!qTokens.length) return [];

  return KB_CHUNKS.map((c) => {
    const questions = (c.questions || []).map(norm);
    const topics = (c.topics || []).map(norm);
    const keywords = (c.keywords || []).map(norm);
    const text = norm(c.text);

    let score = 0;

    if (questions.includes(q)) score += 120;
    if (keywords.includes(q)) score += 140;
    if (topics.includes(q)) score += 90;

    for (const token of qTokens) {
      if (keywords.some((value) => value === token)) score += 40;
      if (topics.some((value) => value === token)) score += 28;
      if (questions.some((value) => value.includes(token))) score += 16;
      if (text.includes(token)) score += 4;
    }

    if (qTokens.length <= 3 && keywords.some((value) => qTokens.every((token) => value.includes(token)))) score += 60;
    if (qTokens.length <= 3 && questions.some((value) => qTokens.every((token) => value.includes(token)))) score += 25;

    return { score, chunk: c };
  })
    .filter((result) => result.score >= 18)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function fallbackSearch(query, k = 5) {
  const STOP = new Set([
    "what","who","where","when","why","how","is","are","do","does","did","can","could","should","would",
    "tell","me","about","the","a","an","and","or","to","in","of","for","on","with","please","explain"
  ]);

  const q = stripQuestionWords(query);
  if (!q) return [];

  const tokens = q.split(" ").filter((token) => token.length >= 3 && !STOP.has(token));

  return KB_CHUNKS.map((c) => {
    const hay = norm(c.text || "");
    const qhay = norm([
      ...(c.questions || []),
      ...(c.keywords || []),
      ...(c.topics || []),
    ].join(" "));

    let score = 0;
    for (const token of tokens) {
      if (qhay.includes(token)) score += 12;
      if (hay.includes(token)) score += 3;
    }

    if (qhay.includes(q)) score += 40;
    if (hay.includes(q)) score += 10;

    return { score, chunk: c };
  })
    .filter((result) => result.score >= 8)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function pickTop(query, k = 5) {
  const keywordHits = keywordSearch(query, k);
  if (keywordHits.length) return keywordHits;

  const safe = sanitizeForLunr(query);
  if (!safe) return [];

  // 1) probaj lunr
  if (KB_INDEX) {
    let results = [];
    try {
      results = KB_INDEX.search(safe).slice(0, k);
    } catch (e) {
      results = [];
    }

    if (results.length) {
      const byId = new Map(KB_CHUNKS.map((c) => [c.id, c]));
      return results
        .map((r) => ({ score: r.score, chunk: byId.get(r.ref) }))
        .filter((x) => x.chunk);
    }
  }

  // 2) fallback: plain search (za 202 entryja je turbo brzo i stabilno)
  return fallbackSearch(query, k);
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
  if (!best) return null;

  const c = best.chunk;
  const clean = (t) => (t || "")
    .replace(/=+/g, " ")
    .replace(/-+/g, " ")
    .replace(/###\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  let short = clean(c.answerShort) || clean(c.answerLong);
  
  // limit na max 220 znakova (MVP), bez rezanja riječi
  if (short.length > 220) {
    short = short.slice(0, 220).replace(/\s+\S*$/, "") + "...";
  }
  
  const cc = c.countryCode && c.countryCode !== "GLOBAL" ? c.countryCode : null;

  if (short) {
    const base = cc ? `(${cc}) ${short}` : short;
    return {
      reply: `${base}\n\nDo you want the full answer? (y/n)`,
      pendingId: c.id,
      pendingLong: clean(c.answerLong) || clean(c.answerShort) || ""
    };
  }

  return null;
}

// ---------- Routes ----------
app.get("/", (req, res) => res.send("S.O.S. chatbot server running"));

app.post("/chat", (req, res) => {
  const message = (req.body?.message || "").toString().trim();
  if (!message) return res.status(400).json({ error: "Missing message" });

  const sessionId = req.ip; // simple session
  const state = SESSION_MEMORY.get(sessionId) || {};

  // If we previously asked "full answer? (y/n)"
  if (state?.pending && (isYes(message) || isNo(message))) {
    if (isYes(message)) {
      const longText = state.pendingLong || "No extended answer available.";
      SESSION_MEMORY.set(sessionId, { ...state, pending: null, pendingLong: null, pendingId: null });
      return res.json({ reply: longText });
    } else {
      SESSION_MEMORY.set(sessionId, { ...state, pending: null, pendingLong: null, pendingId: null });
      return res.json({ reply: "OK." });
    }
  }

  const detected = detectCountryInMessage(message);

  // Detect intent
  const intent = detectIntent(message);
  if (intent === "inappropriate") return res.json({ reply: inappropriateReply() });

  if (intent !== "domain") {
    const reply = smallTalkReply(intent);
    if (reply) return res.json({ reply });
  }

  const exact = exactQuestionMatch(message);
  if (exact) {
    const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
    const short = clean(exact.answerShort) || clean(exact.answerLong);
    const cc = exact.countryCode && exact.countryCode !== "GLOBAL" ? exact.countryCode : null;
    return res.json({ reply: cc ? `(${cc}) ${short}` : short });
  }

  // if user inputs only "CRO" / "PL" / ...
  if (detected && stripCountryFromMessage(message).length === 0) {
    const normalizedMessage = norm(message);
    const bareShortCode = ["cro", "pl", "it", "gr", "lt", "hr"].includes(normalizedMessage);
    SESSION_MEMORY.set(sessionId, { ...state, country: detected });
    if (bareShortCode) {
      return res.json({ reply: `OK — using ${detected}. Ask your question.` });
    }
  }

  // if user inputs "CRO green job" -> detect CRO and remove token from query
  let country = state.country || null;
  let queryMessage = message;

  if (detected) {
    country = detected;
    SESSION_MEMORY.set(sessionId, { ...state, country });
  }

  const expanded = expandQuery(queryMessage);
  let hitsAll = pickTop(expanded, 15);

  if (!hitsAll.length) {
    const simplified = stripQuestionWords(queryMessage);
    hitsAll = pickTop(expandQuery(simplified), 15);
  }

  const hits = country ? hitsAll.filter(h => h.chunk?.countryCode === country || h.chunk?.countryCode === "GLOBAL") : hitsAll;

  const out = formatAnswer(queryMessage, hits.length ? hits : hitsAll);
  if (!out) return res.json({ reply: outOfScopeReply() });

  // store pending long answer in session
  if (out.pendingId) {
    SESSION_MEMORY.set(sessionId, {
      ...state,
      country,
      pending: out.pendingId,
      pendingLong: out.pendingLong,
      pendingId: out.pendingId
    });

    // do not expose internal fields
    const { pendingId, pendingLong, ...publicOut } = out;
    return res.json(publicOut);
  }

  return res.json(out);
});

// reload KB manually after editing kb/*.md
app.post("/admin/reload-kb", (req, res) => {
  const n = reloadKb();
  res.json({ ok: true, chunks: n });
});

// ---------- Boot ----------
const count = reloadKb();
console.log("[KB] hydroponics present:", KB_CHUNKS.some(c => (c.text || "").toLowerCase().includes("hydropon")));
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`S.O.S. chatbot running on :${port} (chunks: ${count})`));