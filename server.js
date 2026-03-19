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

  let bestLinks = [];

  for (let i = 0; i < 8; i++) {
    const links = await page.evaluate((stopTexts) => {
      const anchors = Array.from(document.querySelectorAll("a[href*='/pin/']"));
      const seen = new Set();
      const results = [];

      for (const a of anchors) {
        const text = (a.textContent || "").trim();

        if (stopTexts.some(t => text.includes(t))) {
          break;
        }

        const img = a.querySelector("img");
        if (!img) continue;

        const rect = a.getBoundingClientRect();
        if (rect.width < 100 || rect.height < 100) continue;
        if (rect.width === 0 || rect.height === 0) continue;

        try {
          const url = new URL(a.href);
          const clean = url.origin + url.pathname;

          if (!seen.has(clean)) {
            seen.add(clean);
            results.push(clean);
          }
        } catch {
          // ignore bad urls
        }
      }

      return results;
    }, stopTexts);

    if (links.length > bestLinks.length) {
      bestLinks = links;
    }

    updateJob(jobId, {
      message: `Scanning board... ${bestLinks.length} pins`,
      progress: 10 + i * 3,
    });

    log(jobId, `Scanning... best so far: ${bestLinks.length}`);

    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(800);
  }

  return bestLinks;
}

async function scrapePin(context, url, jobId) {
  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForTimeout(1200);

    const data = await page.evaluate(() => {
      const og = document.querySelector("meta[property='og:image']")?.content;
      const tw = document.querySelector("meta[name='twitter:image']")?.content;

      return {
        image: og || tw,
        title: document.title,
        link: location.href,
      };
    });

    if (!data.image || !data.image.includes("pinimg.com")) {
      return null;
    }

    return {
      image: upgradeToOriginals(data.image),
      title: data.title,
      link: normalizePinUrl(data.link),
    };
  } catch (err) {
    log(jobId, `PIN SCRAPE FAILED: ${url}`);
    log(jobId, err?.message || "Unknown pin scrape error");
    return null;
  } finally {
    await page.close();
  }
}

async function scrapeBoard(boardUrl, jobId) {
  let browser;
  let context;

  try {
    log(jobId, "🚀 Launching browser...");

    updateJob(jobId, {
      status: "running",
      message: "Launching...",
      progress: 2,
    });

    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    log(jobId, "🧠 Browser launched");

    const page = await browser.newPage();

    log(jobId, `🌐 Opening board: ${boardUrl}`);
    await page.goto(boardUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(3000);
    log(jobId, "📌 Board loaded");

    const pinLinks = await collectBoardPins(page, jobId);
    const uniquePinLinks = [...new Set(pinLinks)];

    log(jobId, `📊 Found ${uniquePinLinks.length} unique pins`);

    if (!uniquePinLinks.length) {
      throw new Error("No board pins found.");
    }

    updateJob(jobId, {
      totalPins: uniquePinLinks.length,
      message: `Found ${uniquePinLinks.length} pins`,
      progress: 30,
    });

    context = await browser.newContext();
    const results = [];

    let processed = 0;

    for (const link of uniquePinLinks) {
      log(jobId, `🔄 Scraping ${processed + 1}/${uniquePinLinks.length}`);
      const item = await scrapePin(context, link, jobId);

      if (item) results.push(item);

      processed++;

      updateJob(jobId, {
        processedPins: processed,
        items: results,
        progress: 30 + (processed / uniquePinLinks.length) * 70,
        message: `Processing ${processed}/${uniquePinLinks.length}`,
      });
    }

    log(jobId, `✅ Done. ${results.length} images returned`);

    updateJob(jobId, {
      status: "done",
      items: results,
      progress: 100,
      message: `Done (${results.length})`,
    });

    await page.close();
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
    if (context) await context.close();
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

app.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});