const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const jobs = new Map();

function isValidPinterestBoardUrl(input) {
  try {
    const url = new URL(input);
    return url.hostname.includes("pinterest.");
  } catch {
    return false;
  }
}

function createJob() {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: "queued",
    message: "Queued",
    progress: 0,
    totalPins: 0,
    processedPins: 0,
    items: [],
    error: null,
    logs: []
  };
  jobs.set(id, job);
  return job;
}

function updateJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch);
}

function log(jobId, message) {
  console.log(message);

  const job = jobs.get(jobId);
  if (!job) return;

  job.logs.push({
    time: Date.now(),
    message
  });

  if (job.logs.length > 200) {
    job.logs.shift();
  }
}

function upgradeToOriginals(url) {
  if (!url || !url.includes("pinimg.com")) return url;
  return url
    .replace("/236x/", "/originals/")
    .replace("/474x/", "/originals/")
    .replace("/564x/", "/originals/")
    .replace("/736x/", "/originals/")
    .replace("/1200x/", "/originals/");
}

function normalizePinUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl;
  }
}

async function collectBoardPins(page, jobId) {
  const stopTexts = [
    "Encuentra algunas ideas para este tablero",
    "Find some ideas for this board",
    "Más ideas",
    "More ideas",
  ];

  // Read board pin count from the page header, e.g. "50 Pines" / "50 Pins"
  const targetPinCount = await page.evaluate(() => {
    const text = document.body.innerText || "";
    const match = text.match(/(\d+)\s*(Pins|Pines)\b/i);
    return match ? parseInt(match[1], 10) : null;
  });

  log(jobId, `Target board pin count: ${targetPinCount ?? "unknown"}`);

  const collected = new Set();
  let stableRounds = 0;
  let lastScrollY = -1;

  for (let i = 0; i < 80; i++) {
    const links = await page.evaluate((stopTexts) => {
      const anchors = Array.from(document.querySelectorAll("a[href*='/pin/']"));
      const seen = new Set();
      const results = [];

      for (const a of anchors) {
        const img = a.querySelector("img");
        if (!img) continue;

        const rect = a.getBoundingClientRect();
        if (rect.width < 100 || rect.height < 100) continue;
        if (rect.width === 0 || rect.height === 0) continue;

        // skip obvious recommendation blocks by nearby text
        const nearbyText =
          (a.closest("section, div, article")?.textContent || "").trim();

        if (stopTexts.some(t => nearbyText.includes(t))) continue;

        try {
          const url = new URL(a.href);
          const clean = url.origin + url.pathname;

          if (!seen.has(clean)) {
            seen.add(clean);
            results.push(clean);
          }
        } catch {
          // ignore malformed urls
        }
      }

      return results;
    }, stopTexts);

    let newCountThisRound = 0;
    for (const link of links) {
      // stop adding once we reach the declared board count
      if (targetPinCount && collected.size >= targetPinCount) break;

      if (!collected.has(link)) {
        collected.add(link);
        newCountThisRound += 1;
      }
    }

    const scrollInfo = await page.evaluate(() => {
      const before = window.scrollY;
      window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
      return {
        before,
        after: window.scrollY,
        innerHeight: window.innerHeight,
        docHeight: document.documentElement.scrollHeight
      };
    });

    const didScroll = scrollInfo.after !== scrollInfo.before;

    if (newCountThisRound === 0) stableRounds += 1;
    else stableRounds = 0;

    updateJob(jobId, {
      message: `Scanning board... ${collected.size}${targetPinCount ? "/" + targetPinCount : ""} pins`,
      progress: Math.min(28, 10 + Math.floor(i / 2)),
    });

    log(
      jobId,
      `Scanning round ${i + 1}: visible=${links.length}, new=${newCountThisRound}, total=${collected.size}${targetPinCount ? "/" + targetPinCount : ""}, scroll=${scrollInfo.before}->${scrollInfo.after}, stable=${stableRounds}`
    );

    // Hard stop once we hit the board's own declared count
    if (targetPinCount && collected.size >= targetPinCount) {
      log(jobId, `Reached declared board size: ${collected.size}/${targetPinCount}`);
      break;
    }

    // stop if nothing new appears for several rounds
    if (stableRounds >= 6) {
      log(jobId, `Board discovery stabilized at ${collected.size} pins`);
      break;
    }

    // stop if we are at bottom and no new pins are appearing
    if (
      scrollInfo.after === lastScrollY &&
      scrollInfo.after + scrollInfo.innerHeight >= scrollInfo.docHeight - 50 &&
      newCountThisRound === 0
    ) {
      log(jobId, `Reached page bottom at ${collected.size} pins`);
      break;
    }

    lastScrollY = scrollInfo.after;
    await page.waitForTimeout(400);
  }

  return Array.from(collected).slice(0, targetPinCount || undefined);
}

async function scrapePin(context, url, jobId) {
  const page = await context.newPage();

  try {
    // Block everything except HTML/JS — we only need meta tags
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "stylesheet", "font", "media", "websocket", "other"].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

    // Wait for meta tag to appear instead of fixed timeout
    await page.waitForFunction(() => {
      return document.querySelector("meta[property='og:image']") ||
             document.querySelector("meta[name='twitter:image']");
    }, { timeout: 5000 }).catch(() => {});

    const data = await page.evaluate(() => {
      const og = document.querySelector("meta[property='og:image']")?.content;
      const tw = document.querySelector("meta[name='twitter:image']")?.content;
      return { image: og || tw, title: document.title, link: location.href };
    });

    if (!data.image || !data.image.includes("pinimg.com")) return null;

    return {
      image: upgradeToOriginals(data.image),
      title: data.title,
      link: normalizePinUrl(data.link),
    };
  } catch (err) {
    log(jobId, `PIN SCRAPE FAILED: ${url} — ${err?.message}`);
    return null;
  } finally {
    await page.close();
  }
}

async function scrapeBoard(boardUrl, jobId) {
  let browser;

  try {
    log(jobId, "🚀 Launching browser...");

    updateJob(jobId, {
      status: "running",
      message: "Launching...",
      progress: 2,
    });

    browser = await chromium.launch({
      headless: true,
      executablePath: (() => {
        if (process.resourcesPath) {
          const fs = require("fs");
          const base = path.join(process.resourcesPath, "playwright-browsers");
          if (fs.existsSync(base)) {
            for (const dir of fs.readdirSync(base)) {
              const exe = path.join(base, dir, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
              if (fs.existsSync(exe)) return exe;
            }
          }
        }
        return undefined; // dev: let Playwright find it automatically
      })(),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--mute-audio",
      ]
    });

    log(jobId, "🧠 Browser launched");

    const page = await browser.newPage();

    log(jobId, `🌐 Opening board: ${boardUrl}`);
    await page.goto(boardUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    log(jobId, "📌 Board loaded");

    const pinLinks = await collectBoardPins(page, jobId);
    const uniquePinLinks = [...new Set(pinLinks)];
    log(jobId, `Final board link count after cap: ${uniquePinLinks.length}`);
    log(jobId, `📊 Found ${uniquePinLinks.length} unique pins`);

    if (!uniquePinLinks.length) throw new Error("No board pins found.");

    updateJob(jobId, {
      totalPins: uniquePinLinks.length,
      message: `Found ${uniquePinLinks.length} pins`,
      progress: 30,
    });

    await page.close();

    // Use multiple contexts for true parallelism
    const CONCURRENCY = 10;
    const results = [];
    let processed = 0;

    // Create a pool of contexts (each gets its own set of pages)
    const contexts = await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, uniquePinLinks.length) }, () =>
        browser.newContext()
      )
    );

    // Concurrency pool — as soon as one finishes, next starts
    const queue = [...uniquePinLinks];
    let contextIndex = 0;

    async function worker(ctx) {
      while (queue.length > 0) {
        const link = queue.shift();
        if (!link) break;
        const item = await scrapePin(ctx, link, jobId);
        if (item) results.push(item);
        processed++;
        log(jobId, `🔄 ${processed}/${uniquePinLinks.length} — ${link}`);
        updateJob(jobId, {
          processedPins: processed,
          items: [...results],
          progress: 30 + (processed / uniquePinLinks.length) * 70,
          message: `Processing ${processed}/${uniquePinLinks.length}`,
        });
      }
    }

    // Run all workers simultaneously
    await Promise.all(contexts.map(ctx => worker(ctx)));

    // Clean up contexts
    await Promise.all(contexts.map(ctx => ctx.close()));

    log(jobId, `✅ Done. ${results.length} images returned`);

    updateJob(jobId, {
      status: "done",
      items: results,
      progress: 100,
      message: `Done (${results.length})`,
    });

  } catch (err) {
    log(jobId, "❌ SCRAPE FAILED");
    log(jobId, err?.message || "Unknown error");
    log(jobId, err?.stack || "No stack");

    updateJob(jobId, {
      status: "error",
      message: err?.message || "Scrape failed.",
      error: err?.message || "Scrape failed.",
    });
  } finally {
    if (browser) await browser.close();
  }
}

app.post("/api/start-scrape", (req, res) => {
  const { url } = req.body;

  if (!isValidPinterestBoardUrl(url)) {
    return res.status(400).json({ error: "Invalid URL" });
  }

  const job = createJob();
  scrapeBoard(url, job.id);

  res.json({ jobId: job.id });
});

app.get("/api/scrape-status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json(job);
});

// When run directly with `node server.js`, start the server normally.
// When imported by Electron's main.js, just export the app.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log("Server running on http://localhost:" + PORT);
  });
} else {
  module.exports = app;
}