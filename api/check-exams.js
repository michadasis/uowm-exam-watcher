// Vercel Cron target: GET /api/check-exams
//
// The CS department does NOT post exam schedules as new blog announcements.
// Instead there's one static page ("Πρόγραμμα Εξετάσεων") listing schedule
// documents newest-first; when a new exam period is announced, a new
// .docx link is added to the TOP of that list (the old ones stay below it
// under a "Παλαιότερα Προγράμματα" separator).
//
// So: fetch that page, look at whichever document link is currently first,
// and compare it against the link we saw last time (stored in Upstash
// Redis). If it changed, download the new doc, extract its text, and post
// it to Discord via webhook.

import { Redis } from "@upstash/redis";
import * as cheerio from "cheerio";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";

const EXAMS_PAGE_URL =
  process.env.EXAMS_PAGE_URL ||
  "https://cs.uowm.gr/archiki-selida/programma-spoudwn/programma-exetaseon/";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const LAST_SEEN_KEY = "uowm:exams-page:last-doc-url";
// Προσωρινή άδεια + Φοιτητές
const PING_ROLE_IDS = (process.env.EXAMS_PING_ROLE_IDS || "1553097744984571935,1553095048260751390")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

// Vercel's Storage tab connects Upstash Redis under the legacy "KV_"
// variable names (KV_REST_API_URL / KV_REST_API_TOKEN), not Upstash's own
// UPSTASH_REDIS_REST_* names — support both so this works either way the
// database ends up connected.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;

async function fetchBuffer(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "uowm-exam-watcher/1.0 (+discord relay)" },
  });
  if (!res.ok) throw new Error(`Fetch failed for ${url}: ${res.status}`);
  const arrBuf = await res.arrayBuffer();
  return Buffer.from(arrBuf);
}

// Finds the first document link on the exam schedule page — that's always
// the current/most recent one, per how the department maintains this page.
async function fetchCurrentExamDoc() {
  const res = await fetch(EXAMS_PAGE_URL, {
    headers: { "User-Agent": "uowm-exam-watcher/1.0 (+discord relay)" },
  });
  if (!res.ok) {
    throw new Error(
      `Exams page fetch failed: ${res.status} ${res.statusText}`
    );
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const content = $(".entry-content, article .entry-content, article").first();
  const scope = content.length ? content : $("body");

  const link = scope.find('a[href$=".docx"], a[href$=".doc"], a[href$=".pdf"]').first();
  if (!link.length) {
    throw new Error("No document link found on the exam schedule page");
  }

  const url = new URL(link.attr("href"), EXAMS_PAGE_URL).toString();
  const label = link.text().trim();
  return { url, label };
}

async function extractDocText(buf, url) {
  if (/\.docx(\?|#|$)/i.test(url)) {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  }
  if (/\.pdf(\?|#|$)/i.test(url)) {
    const { text } = await pdfParse(buf);
    return text.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  }
  // Legacy .doc: no reliable pure-JS parser. Caller still gets the raw file
  // as a Discord attachment; just can't inline the text.
  return "(Το αρχείο είναι .doc — δες το συνημμένο.)";
}

function chunkText(text, maxLen = 1900) {
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? current + "\n" + line : line;
    if (candidate.length > maxLen) {
      if (current) chunks.push(current);
      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen) {
          chunks.push(line.slice(i, i + maxLen));
        }
        current = "";
      } else {
        current = line;
      }
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function postJson(body) {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Discord post failed: ${res.status} ${await res.text()}`);
  }
}

async function postWithFile(content, attachment) {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content }));
  form.append("files[0]", new Blob([attachment.buf]), attachment.name || "attachment");
  const res = await fetch(DISCORD_WEBHOOK_URL, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`Discord file post failed: ${res.status} ${await res.text()}`);
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function relayToDiscord(doc, text, fileBuf) {
  // 1. A card-style announcement (title + link + timestamp) instead of a
  //    plain wall of bold text.
  await postJson({
    embeds: [
      {
        title: "📅 Νέο πρόγραμμα εξετάσεων",
        description: doc.label,
        url: doc.url,
        color: 0x57f287,
        timestamp: new Date().toISOString(),
        footer: { text: "cs.uowm.gr — Πρόγραμμα Εξετάσεων" },
      },
    ],
  });
  await sleep(400);

  // 2. The schedule text itself, readable inline, numbered if it spans
  //    multiple messages.
  const chunks = chunkText(text);
  for (let i = 0; i < chunks.length; i++) {
    const label = chunks.length > 1 ? `**Μέρος ${i + 1}/${chunks.length}**\n` : "";
    await postJson({ content: label + "```\n" + chunks[i] + "\n```" });
    await sleep(400);
  }

  // 3. The original file, sent last, for anyone who wants the formatted
  //    document instead of the plain-text version above.
  const fileName = doc.url.split("/").pop().split("?")[0];
  await postWithFile("📎 Πρωτότυπο αρχείο", { buf: fileBuf, name: fileName });
  await sleep(400);

  // 4. Ping the student roles now that the schedule is fully posted.
  await postJson({
    content: PING_ROLE_IDS.map((id) => `<@&${id}>`).join(" "),
    allowed_mentions: { roles: PING_ROLE_IDS },
  });
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }
  if (!DISCORD_WEBHOOK_URL) {
    res.status(500).json({ error: "DISCORD_WEBHOOK_URL is not configured" });
    return;
  }

  const dryRun = req.query?.dryRun === "1" || req.query?.dryRun === "true";

  try {
    const current = await fetchCurrentExamDoc();
    const lastSeen = redis ? await redis.get(LAST_SEEN_KEY) : null;
    const isNew = current.url !== lastSeen;

    let posted = false;
    if (isNew && !dryRun) {
      const buf = await fetchBuffer(current.url);
      const text = await extractDocText(buf, current.url);
      await relayToDiscord(current, text, buf);
      if (redis) await redis.set(LAST_SEEN_KEY, current.url);
      posted = true;
    }

    res.status(200).json({
      ok: true,
      dryRun,
      redisConnected: Boolean(redis),
      current,
      lastSeen,
      isNew,
      posted,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
