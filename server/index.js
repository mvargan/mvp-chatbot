import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import lunr from "lunr";
const SESSION_MEMORY = new Map();

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
    const cleaned = md.trim();

  // 1) TRY Q/A chunks: each "Question?" + next lines as answer
  const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
  const qa = [];
  for (let i = 0; i < lines.length; i++) {
    const q = lines[i];
    if (!q.endsWith("?")) continue;

    let a = [];
    let j = i + 1;
    while (j < lines.length && !lines[j].endsWith("?")) {
      a.push(lines[j]);
      j++;
    }
    const ans = a.join(" ").trim();
    if (ans) {
      qa.push({
        id: `${filename}::Q${qa.length + 1}`,
        title: `${filename} :: ${q}`,
        text: `Q: ${q}\nA: ${ans}`,
        filename,
      });
    }
  }
  if (qa.length >= 5) return qa;

  // 2) original heading chunking
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

function formatAnswer(message, hits, sessionId) {
  const best = hits[0];
  if (!best || best.score < 0.15) return null;

  const text = best.chunk.text;

  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.length > 20);

  const bullets = sentences
    .slice(0, 3)
    .map(s => "• " + simplifySentence(s))
    .join("\n");

  return {
    reply:
      bullets +
      "\n\nWould you like:\n" +
      "1) Full explanation\n" +
      "2) A simple example\n" +
      "3) A mini task?"
  };
}

// ---------- Routes ----------
app.get("/", (req, res) => res.send("S.O.S. chatbot server running"));

app.post("/chat", (req, res) => {
  const message = (req.body?.message || "").toString().trim();
  if (!message) return res.status(400).json({ error: "Missing message" });

  const sessionId = req.ip; // simple session

  const memory = SESSION_MEMORY.get(sessionId);

  if (memory) {
    const m = message.toLowerCase();

    if (m.includes("1") || m.includes("full")) {
      return res.json({
        reply: memory.fullText
      });
    }

    if (m.includes("2") || m.includes("example")) {
      return res.json({
        reply:
          "Example:\n\n" +
          memory.fullText.split(".")[0] +
          ".\n\nThis is how it works in practice."
      });
    }

    if (m.includes("3") || m.includes("task")) {
      return res.json({
        reply:
          "Mini task:\n\nExplain this concept in 3 sentences in your own words.\nThen give one real-life example from your country."
      });
    }
  }

  const intent = detectIntent(message);

  if (intent === "inappropriate") return res.json({ reply: inappropriateReply() });

  if (intent !== "domain") {
    const r = smallTalkReply(intent);
    if (r) return res.json({ reply: r });
  }

  const hits = pickTop(expandQuery(message), 5);
  const out = formatAnswer(message, hits, sessionId);
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