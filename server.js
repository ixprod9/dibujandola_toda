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
  };
  jobs.set(id, job);
  return job;
}

function updateJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch);
}

function upgradeToOriginals(url) {
  if (!url || !url.includes("pinimg.com")) return url;
  return url
    .replace("/236x/", "/originals/")
    .replace("/474x/", "/originals/")
    .replace("/564x/", "/originals/")
    .replace("/736x/", "/originals/");
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

      let cutoffReached = false;

      for (const a of anchors) {
        const text = (a.textContent || "").trim();

        if (stopTexts.some(t => text.includes(t))) {
          cutoffReached = true;
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
        } catch {}
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

    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(800);
  }

  return bestLinks;
}

async function scrapePin(context, url) {
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
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

async function scrapeBoard(boardUrl, jobId) {
  let browser;

  try {
    updateJob(jobId, {
      status: "running",
      message: "Launching...",
      progress: 2,
    });

    browser = await chromium.launch({ headless: true });

    const page = await browser.newPage();

    await page.goto(boardUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const pinLinks = await collectBoardPins(page, jobId);
    const uniquePinLinks = [...new Set(pinLinks)];

    console.log("FINAL BOARD PINS:", uniquePinLinks.length);
    console.log(uniquePinLinks);

    updateJob(jobId, {
      totalPins: uniquePinLinks.length,
      message: `Found ${uniquePinLinks.length} pins`,
      progress: 30,
    });

    const context = await browser.newContext();
    const results = [];

    let processed = 0;

    for (const link of uniquePinLinks) {
      const item = await scrapePin(context, link);

      if (item) results.push(item);

      processed++;

      updateJob(jobId, {
        processedPins: processed,
        items: results,
        progress: 30 + (processed / uniquePinLinks.length) * 70,
        message: `Processing ${processed}/${uniquePinLinks.length}`,
      });
    }

    updateJob(jobId, {
      status: "done",
      items: results,
      progress: 100,
      message: `Done (${results.length})`,
    });
  } catch (err) {
    updateJob(jobId, {
      status: "error",
      message: err.message,
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
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

app.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});