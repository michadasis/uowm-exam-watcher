// Vercel Cron target: GET /api/check-timetable
//
// Watches the "Ωρολόγιο Πρόγραμμα Μαθημάτων" page, picks the newest document,
// converts it to PDF (docx-preview + headless Chromium, no paid services),
// posts it to Discord in an embed with the PDF attached, then pings the
// Προσωρινή άδεια and Φοιτητές roles.
//
// Query params:
//   ?dryRun=1   detection only, returns JSON, posts nothing
//   ?preview=1  converts the current file and returns the PDF, posts nothing

import { Redis } from "@upstash/redis";
import * as cheerio from "cheerio";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const PAGE_URL =
  process.env.TIMETABLE_PAGE_URL ||
  "https://cs.uowm.gr/archiki-selida/orologio-programma-mathimaton/";
const WEBHOOK_URL = process.env.TIMETABLE_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
// Προσωρινή άδεια + Φοιτητές
const PING_ROLE_IDS = (process.env.TIMETABLE_PING_ROLE_IDS || "1553097744984571935,1553095048260751390")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const AVATAR_URL =
  process.env.TIMETABLE_AVATAR_URL ||
  "https://raw.githubusercontent.com/michadasis/uowm-exam-watcher/main/assets/uowm-logo.png";
const LAST_SEEN_KEY = "uowm:timetable-page:last-doc-url";
const UA = { "User-Agent": "uowm-exam-watcher/1.0 (+discord relay)" };
const DOC_EXT = /\.(docx?|xlsx?|odt|ods|pdf)(\?|#|$)/i;

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;

function fileNameOf(url) {
  const last = new URL(url).pathname.split("/").pop() || "timetable";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

async function fetchBuffer(url, init = {}) {
  const res = await fetch(url, { headers: UA, ...init });
  if (!res.ok) throw new Error(`Fetch failed for ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Newest = highest /wp-content/uploads/YYYY/MM/ path. Ties (same month) go to
// whichever link appears first on the page, since the department lists
// newest-first.
async function fetchNewestTimetable() {
  const res = await fetch(PAGE_URL, { headers: UA });
  if (!res.ok) throw new Error(`Timetable page fetch failed: ${res.status} ${res.statusText}`);
  const $ = cheerio.load(await res.text());

  const content = $(".entry-content, article .entry-content, article").first();
  const scope = content.length ? content : $("body");

  const links = [];
  scope.find("a[href]").each((order, el) => {
    const href = $(el).attr("href");
    if (!href || !DOC_EXT.test(href)) return;
    const url = new URL(href, PAGE_URL).toString();
    const m = url.match(/\/uploads\/(\d{4})\/(\d{2})\//);
    links.push({
      url,
      label: $(el).text().replace(/\s+/g, " ").trim() || fileNameOf(url),
      stamp: m ? Number(m[1]) * 100 + Number(m[2]) : 0,
      order,
    });
  });

  if (!links.length) throw new Error("No document link found on the timetable page");
  links.sort((a, b) => b.stamp - a.stamp || a.order - b.order);
  const { url, label } = links[0];
  return { url, label };
}

// Free docx -> pdf on Vercel: render the docx with docx-preview (keeps table
// widths, merged cells, colors and page orientation) inside headless
// Chromium, then print to PDF. Vercel functions have no LibreOffice.
// Metric-compatible, Greek-capable stand-ins for the fonts Word docs use.
// The Chromium build on Vercel only ships Open Sans (which covers Greek), so
// anything else falls back to that.
const FONTS = "https://raw.githubusercontent.com/google/fonts/main/ofl";
const FONT_CSS = `
@font-face{font-family:"Calibri";font-weight:400;src:url(${FONTS}/carlito/Carlito-Regular.ttf)}
@font-face{font-family:"Calibri";font-weight:700;src:url(${FONTS}/carlito/Carlito-Bold.ttf)}
@font-face{font-family:"Times New Roman";font-weight:400;src:url(${FONTS}/tinos/Tinos-Regular.ttf)}
@font-face{font-family:"Times New Roman";font-weight:700;src:url(${FONTS}/tinos/Tinos-Bold.ttf)}
@font-face{font-family:"Arial";font-weight:100 900;src:url(${FONTS}/arimo/Arimo%5Bwght%5D.ttf)}
`;

async function docxToPdf(buf) {

  const [docxPreviewJs, jszipJs] = await Promise.all([
    readFile(path.join(path.dirname(require.resolve("docx-preview")), "docx-preview.min.js"), "utf8"),
    readFile(path.join(path.dirname(require.resolve("jszip")), "..", "dist", "jszip.min.js"), "utf8"),
  ]);

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: process.env.CHROME_PATH || (await chromium.executablePath()),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${FONT_CSS}</style></head><body style="margin:0"><div id="out"></div></body></html>`
    );
    await page.addScriptTag({ content: jszipJs });
    await page.addScriptTag({ content: docxPreviewJs });

    const size = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await docx.renderAsync(bytes, document.getElementById("out"), null, {
        inWrapper: false,
        breakPages: true,
        ignoreLastRenderedPageBreak: true,
      });
      await Promise.allSettled([...document.fonts].map((f) => f.load()));
      await document.fonts.ready;
      const first = document.querySelector("section.docx");
      const style = document.createElement("style");
      style.textContent =
        "section.docx{margin:0!important;box-shadow:none!important;break-after:page;}" +
        "section.docx:last-of-type{break-after:auto;}";
      document.head.appendChild(style);
      return first ? { width: first.style.width, height: first.style.minHeight } : null;
    }, buf.toString("base64"));

    // docx-preview reports sizes in pt; puppeteer wants in/mm/cm/px.
    const toIn = (v) => (/pt$/.test(v || "") ? `${parseFloat(v) / 72}in` : null);
    const width = toIn(size?.width);
    const height = toIn(size?.height);
    const pageSize = width && height ? { width, height } : { format: "A4" };
    return Buffer.from(
      await page.pdf({ ...pageSize, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } })
    );
  } finally {
    await browser.close();
  }
}

// .pdf goes through as-is, .docx is converted. Anything else (.doc, .xlsx)
// is sent as the original file since it can't be rendered here.
async function toAttachment(buf, srcName) {
  if (/\.pdf$/i.test(srcName)) return { buf, name: srcName, type: "application/pdf" };
  if (/\.docx$/i.test(srcName)) {
    return {
      buf: await docxToPdf(buf),
      name: srcName.replace(/\.[^.]+$/, "") + ".pdf",
      type: "application/pdf",
    };
  }
  return { buf, name: srcName, type: "application/octet-stream" };
}

async function postTimetable(doc, file) {
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({
      avatar_url: AVATAR_URL,
      embeds: [
        {
          title: "📅 Νέο ωρολόγιο πρόγραμμα",
          description: doc.label,
          url: doc.url,
          color: 0x5865f2,
          timestamp: new Date().toISOString(),
          footer: { text: "cs.uowm.gr — Ωρολόγιο Πρόγραμμα" },
        },
      ],
      attachments: [{ id: 0, filename: file.name }],
    })
  );
  form.append("files[0]", new Blob([file.buf], { type: file.type }), file.name);
  const res = await fetch(WEBHOOK_URL, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Discord file post failed: ${res.status} ${await res.text()}`);
}

async function pingRoles() {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      avatar_url: AVATAR_URL,
      content: PING_ROLE_IDS.map((id) => `<@&${id}>`).join(" "),
      allowed_mentions: { roles: PING_ROLE_IDS },
    }),
  });
  if (!res.ok) throw new Error(`Discord ping failed: ${res.status} ${await res.text()}`);
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }

  const dryRun = req.query?.dryRun === "1" || req.query?.dryRun === "true";
  const preview = req.query?.preview === "1" || req.query?.preview === "true";

  try {
    const current = await fetchNewestTimetable();
    const srcName = fileNameOf(current.url);

    if (preview) {
      const file = await toAttachment(await fetchBuffer(current.url), srcName);
      res.setHeader("Content-Type", file.type);
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      res.status(200).send(file.buf);
      return;
    }

    if (!WEBHOOK_URL) {
      res.status(500).json({ error: "TIMETABLE_WEBHOOK_URL is not configured" });
      return;
    }

    const lastSeen = redis ? await redis.get(LAST_SEEN_KEY) : null;
    const isNew = current.url !== lastSeen;

    let posted = false;
    if (isNew && !dryRun) {
      const file = await toAttachment(await fetchBuffer(current.url), srcName);
      await postTimetable(current, file);
      await new Promise((r) => setTimeout(r, 400));
      await pingRoles();
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
