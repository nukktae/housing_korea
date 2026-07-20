import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const rootDir = path.resolve(new URL(".", import.meta.url).pathname, "..");
const config = JSON.parse(await fs.readFile(path.join(rootDir, "config.json"), "utf8"));

// Inline the bits we need from src/index.js to avoid running the whole bot.
process.env.ZIGBANG_MAX_CENTERS = process.env.ZIGBANG_MAX_CENTERS || "4";
process.env.HEADLESS = process.env.HEADLESS || "true";
const env = {
  headless: (process.env.HEADLESS || "true").toLowerCase() !== "false",
  zigbangMaxCenters: Number(process.env.ZIGBANG_MAX_CENTERS),
  zigbangDetailConcurrency: Number(process.env.ZIGBANG_DETAIL_CONCURRENCY || 6),
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 20000)
};

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.fetchTimeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
    return body;
  } finally { clearTimeout(timeout); }
}

function seoulGridCenters() {
  const { sw, ne } = config.location.bbox;
  const { stepLat, stepLng } = config.location.zigbangGrid;
  const centers = [];
  for (let lat = sw.lat + stepLat / 2; lat < ne.lat; lat += stepLat) {
    for (let lng = sw.lng + stepLng / 2; lng < ne.lng; lng += stepLng) {
      centers.push({ lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) });
    }
  }
  return centers;
}

function withZigbangMaxFilters(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set("depositMax", String(config.filters.depositMaxManwon));
  url.searchParams.set("rentMax", String(config.filters.monthlyRentMaxManwon));
  return url.toString();
}

async function collectIds(browser, service) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "ko-KR" });
  const ids = new Set();
  const pending = [];
  const seenUrls = new Set();
  const endpointPart = service === "officetel" ? "/items/officetels" : "/items/onerooms";

  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("apis.zigbang.com/house/property/v1") || !url.includes(endpointPart)) return;
    const filtered = withZigbangMaxFilters(url);
    if (seenUrls.has(filtered)) return;
    seenUrls.add(filtered);
    pending.push(
      fetchJson(filtered, {
        headers: {
          "accept": "application/json, text/plain, */*",
          "origin": "https://www.zigbang.com",
          "referer": `https://www.zigbang.com/home/${service}/map`,
          "user-agent": "Mozilla/5.0"
        }
      }).then((body) => {
        for (const item of body.items || []) {
          const id = item.id ?? item.item_id;
          const n = Number(id);
          if (Number.isFinite(n)) ids.add(n);
        }
      }).catch(() => {})
    );
  });

  const drain = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0, pending.length));
  };

  try {
    const homeUrl = service === "officetel"
      ? "https://www.zigbang.com/home/officetel/map"
      : "https://www.zigbang.com/home/oneroom/map";
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4500);
    await drain();

    const centers = seoulGridCenters().slice(0, env.zigbangMaxCenters);
    const { zoom, waitMsPerCenter } = config.location.zigbangGrid;
    for (const c of centers) {
      await page.evaluate(({ lat, lng, zoom }) => {
        const iframe = [...document.querySelectorAll("iframe")].find((f) => f.src.includes("map.zigbang.com"));
        if (!iframe) throw new Error("no iframe");
        iframe.src = `https://map.zigbang.com/?latitude=${lat}&longitude=${lng}&zoom=${zoom}&maxZoomLevel=19&minZoomLevel=7&rotateEnabled=false&pitchEnabled=false&showsUserLocation=false&domain=zigbang`;
      }, { lat: c.lat, lng: c.lng, zoom });
      await page.waitForTimeout(waitMsPerCenter);
      await drain();
    }
  } finally { await page.close(); }
  return [...ids];
}

async function fetchDetails(ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 15) chunks.push(ids.slice(i, i + 15));
  const all = [];
  for (const chunk of chunks) {
    try {
      const body = await fetchJson("https://apis.zigbang.com/house/property/v1/items/list", {
        method: "POST",
        headers: {
          "accept": "application/json, text/plain, */*",
          "content-type": "application/json",
          "origin": "https://www.zigbang.com",
          "referer": "https://www.zigbang.com/home/oneroom/map",
          "user-agent": "Mozilla/5.0"
        },
        body: JSON.stringify({ itemIds: chunk })
      });
      all.push(...(body.items || []));
    } catch (e) {
      console.error("chunk failed:", e.message);
    }
  }
  return all;
}

const browser = await chromium.launch({ headless: env.headless });
try {
  const [oneIds, officeIds] = await Promise.all([
    collectIds(browser, "oneroom"),
    collectIds(browser, "officetel")
  ]);
  const all = [...new Set([...oneIds, ...officeIds])];
  console.log(`collected ids: oneroom=${oneIds.length} officetel=${officeIds.length} unique=${all.length}`);
  const items = await fetchDetails(all);
  console.log(`fetched details: ${items.length}`);

  // Dump first raw item so we can see what fields exist
  if (items.length) {
    console.log("\n=== sample raw Zigbang item (first one) ===");
    console.log(JSON.stringify(items[0], null, 2));
  }

  const f = config.filters;
  const counters = {
    total: items.length,
    hasAddress: 0,
    seoulAddress: 0,
    roomTypeOk: 0,
    depositOk: 0,
    rentOk: 0,
    pyeongOk: 0,
    floorOk: 0,
    finalMatch: 0
  };

  const sampleCuts = { roomType: [], deposit: [], rent: [], pyeong: [], floor: [], address: [] };

  for (const item of items) {
    const type = item.service_type || "";
    const address = item.address || item.address1 || "";
    const text = [
      item.title, item.sales_type, item.service_type, item.floor_string,
      item.contract, ...(item.tags || []), ...(item.badges || [])
    ].filter(Boolean).join(" ");
    const deposit = Number(item.deposit || 0);
    const rent = Number(item.rent || 0);
    const pyeong = item["전용면적"]?.p ? Number(item["전용면적"].p) :
      (item.size_m2 ? Number((Number(item.size_m2) / 3.305785).toFixed(1)) : null);
    const floorText = item.floor_string || String(item.floor || "");

    if (address) counters.hasAddress++;
    const seoul = !address || address.includes("서울");
    if (seoul) counters.seoulAddress++; else if (sampleCuts.address.length < 3) sampleCuts.address.push({ address });

    const roomTypeOk = f.roomTypes.some((t) => String(type).includes(t));
    if (roomTypeOk) counters.roomTypeOk++; else if (sampleCuts.roomType.length < 3) sampleCuts.roomType.push({ type });

    const depositOk = deposit <= f.depositMaxManwon;
    if (depositOk) counters.depositOk++; else if (sampleCuts.deposit.length < 3) sampleCuts.deposit.push({ deposit });

    const rentOk = rent <= f.monthlyRentMaxManwon;
    if (rentOk) counters.rentOk++; else if (sampleCuts.rent.length < 3) sampleCuts.rent.push({ rent });

    const pyeongOk = pyeong === null || pyeong >= f.minimumPyeong;
    if (pyeongOk) counters.pyeongOk++; else if (sampleCuts.pyeong.length < 3) sampleCuts.pyeong.push({ pyeong });

    const floorOk = !f.excludedFloors.some((w) => floorText.includes(w) || text.includes(w));
    if (floorOk) counters.floorOk++; else if (sampleCuts.floor.length < 3) sampleCuts.floor.push({ floorText });

    if (seoul && roomTypeOk && depositOk && rentOk && pyeongOk && floorOk) counters.finalMatch++;
  }

  console.log("\n=== filter funnel ===");
  console.log(counters);
  console.log("\n=== sample cuts ===");
  console.log(JSON.stringify(sampleCuts, null, 2));
} finally {
  await browser.close();
}
