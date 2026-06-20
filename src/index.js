import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = path.resolve(new URL(".", import.meta.url).pathname, "..");
const dataDir = path.join(rootDir, "data");
const seenPath = path.join(dataDir, "seen.json");
const configPath = path.join(rootDir, "config.json");

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const dryRun = args.has("--dry-run");
const initSeen = args.has("--init-seen");

await loadDotEnv(path.join(rootDir, ".env"));
const config = JSON.parse(await fs.readFile(configPath, "utf8"));

const env = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  intervalMinutes: Number(process.env.CHECK_INTERVAL_MINUTES || 20),
  headless: (process.env.HEADLESS || "true").toLowerCase() !== "false",
  sendExistingOnFirstRun: (process.env.SEND_EXISTING_ON_FIRST_RUN || "false").toLowerCase() === "true",
  dabangEnabled: (process.env.DABANG_ENABLED || "true").toLowerCase() !== "false",
  zigbangEnabled: (process.env.ZIGBANG_ENABLED || "true").toLowerCase() !== "false",
  dabangMaxPages: Number(process.env.DABANG_MAX_PAGES || 8),
  zigbangMaxCenters: Number(process.env.ZIGBANG_MAX_CENTERS || 0),
  zigbangDetailConcurrency: Number(process.env.ZIGBANG_DETAIL_CONCURRENCY || 6),
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 20000)
};

if (!dryRun && !initSeen && (!env.telegramToken || !env.telegramChatId)) {
  throw new Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env, or run with --dry-run.");
}

async function loadDotEnv(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.fetchTimeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    return body;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Timed out after ${env.fetchTimeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return search.toString();
}

function dabangHeaders(referer) {
  return {
    "accept": "application/json, text/plain, */*",
    "cache-control": "no-cache",
    "d-api-version": "5.0.0",
    "d-app-version": "1",
    "d-call-type": "web",
    "pragma": "no-cache",
    "referer": referer,
    "user-agent": "Mozilla/5.0"
  };
}

function dabangOneRoomFilters() {
  const f = config.filters;
  return {
    sellingTypeList: ["MONTHLY_RENT"],
    depositRange: { min: 0, max: f.depositMaxManwon },
    priceRange: { min: 0, max: f.monthlyRentMaxManwon },
    isIncludeMaintenance: false,
    pyeongRange: { min: f.minimumPyeong, max: 999999 },
    useApprovalDateRange: { min: 0, max: 999999 },
    roomFloorList: ["GROUND_FIRST", "GROUND_SECOND_OVER"],
    roomTypeList: ["ONE_ROOM"],
    dealTypeList: ["AGENT"],
    canParking: false,
    isShortLease: false,
    hasElevator: false,
    hasPano: false,
    isDivision: false,
    isDuplex: false
  };
}

function dabangOfficetelFilters() {
  const f = config.filters;
  return {
    sellingTypeList: ["MONTHLY_RENT"],
    tradeRange: { min: 0, max: 999999 },
    depositRange: { min: 0, max: f.depositMaxManwon },
    priceRange: { min: 0, max: f.monthlyRentMaxManwon },
    isIncludeMaintenance: false,
    pyeongRange: { min: f.minimumPyeong, max: 999999 },
    useApprovalDateRange: { min: 0, max: 999999 },
    dealTypeList: ["AGENT"],
    parkingNumRange: { min: 0, max: 999999 },
    canParking: false,
    isShortLease: false,
    hasElevator: false,
    hasPano: false,
    roomCountList: []
  };
}

async function fetchDabangCategory(category, filters, typeLabel) {
  const listings = [];
  const referer = `https://www.dabangapp.com/map/${category}`;
  for (let page = 1; page <= env.dabangMaxPages; page += 1) {
    const url = `https://www.dabangapp.com/api/v5/room-list/category/${category}/bbox?${buildQuery({
      filters,
      bbox: config.location.bbox,
      zoom: 11,
      useMap: "naver",
      page
    })}`;
    const body = await fetchJson(url, { headers: dabangHeaders(referer) });
    const result = body.result || {};
    const roomList = result.roomList || [];
    for (const item of roomList) {
      listings.push(normalizeDabang(item, category, typeLabel));
    }
    const limit = Number(result.limit || roomList.length || 24);
    const total = Number(result.total || roomList.length);
    if (!roomList.length || page * limit >= total) break;
    await sleep(350);
  }
  return listings;
}

async function fetchDabangListings() {
  const [oneRooms, officetels] = await Promise.all([
    fetchDabangCategory("one-two", dabangOneRoomFilters(), "원룸"),
    fetchDabangCategory("officetel", dabangOfficetelFilters(), "오피스텔")
  ]);
  return [...oneRooms, ...officetels];
}

function normalizeDabang(item, category, typeLabel) {
  const text = [item.roomTitle, item.roomDesc, item.roomTypeName, item.priceTitle].filter(Boolean).join(" ");
  const [deposit, rent] = parseDabangPrice(item.priceTitle);
  const pyeong = parseDabangPyeong(item.roomDesc);
  return {
    source: "dabang",
    id: `dabang:${item.id}`,
    rawId: item.id,
    listingNo: item.seq || null,
    regionCode: Number(item.gid || 0),
    type: item.roomTypeName || typeLabel,
    title: item.roomTitle || "(no title)",
    text,
    deposit,
    rent,
    pyeong,
    maintenance: parseMaintenance(item.roomDesc),
    floorText: item.roomDesc || "",
    address: item.dongName || "",
    lat: item.randomLocation?.lat ?? null,
    lng: item.randomLocation?.lng ?? null,
    image: item.imgUrlList?.[0],
    url: buildDabangRoomUrl(category, item),
    createdAt: null
  };
}

function buildDabangRoomUrl(category, item) {
  const routeCategory = category === "one-two" ? "onetwo" : category;
  const url = new URL(`https://www.dabangapp.com/map/${routeCategory}`);
  const lat = item.randomLocation?.lat;
  const lng = item.randomLocation?.lng;
  if (lat && lng) {
    url.searchParams.set("m_lat", String(lat));
    url.searchParams.set("m_lng", String(lng));
  }
  url.searchParams.set("m_zoom", "16");
  url.searchParams.set("detail_type", "room");
  url.searchParams.set("detail_id", item.id);
  return url.toString();
}

function parseDabangPrice(priceTitle = "") {
  const parts = String(priceTitle).replaceAll(",", "").split("/");
  return [Number(parts[0] || 0), Number(parts[1] || 0)];
}

function parseDabangPyeong(desc = "") {
  const m2 = String(desc).match(/([\d.]+)\s*m²/);
  return m2 ? Number((Number(m2[1]) / 3.305785).toFixed(1)) : null;
}

function parseMaintenance(text = "") {
  const none = /관리비\s*없음/.test(text);
  if (none) return 0;
  const match = String(text).match(/관리비\s*([\d.]+)\s*만/);
  return match ? Number(match[1]) : null;
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

async function collectZigbangIdsForService(browser, service) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "ko-KR" });
  const ids = new Set();
  const pendingSearches = [];
  const seenSearchUrls = new Set();
  const endpointPart = service === "officetel" ? "/items/officetels" : "/items/onerooms";

  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("apis.zigbang.com/house/property/v1") || !url.includes(endpointPart)) return;
    const filteredUrl = withZigbangMaxFilters(url);
    if (seenSearchUrls.has(filteredUrl)) return;
    seenSearchUrls.add(filteredUrl);
    pendingSearches.push(
      fetchZigbangItemIds(filteredUrl, service)
        .then((itemIds) => {
          for (const id of itemIds) ids.add(id);
        })
        .catch((error) => {
          console.error(`[zigbang:${service}] search failed:`, error.message);
        })
    );
  });

  async function drainPendingSearches() {
    while (pendingSearches.length) {
      const batch = pendingSearches.splice(0, pendingSearches.length);
      await Promise.allSettled(batch);
    }
  }

  try {
    const homeUrl = service === "officetel"
      ? "https://www.zigbang.com/home/officetel/map"
      : "https://www.zigbang.com/home/oneroom/map";
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4500);
    await drainPendingSearches();

    const centers = env.zigbangMaxCenters > 0
      ? seoulGridCenters().slice(0, env.zigbangMaxCenters)
      : seoulGridCenters();
    const { zoom, waitMsPerCenter } = config.location.zigbangGrid;
    for (const center of centers) {
      await page.evaluate(({ lat, lng, zoom }) => {
        const iframe = [...document.querySelectorAll("iframe")]
          .find((frame) => frame.src.includes("map.zigbang.com"));
        if (!iframe) throw new Error("Zigbang map iframe not found");
        iframe.src = `https://map.zigbang.com/?latitude=${lat}&longitude=${lng}&zoom=${zoom}&maxZoomLevel=19&minZoomLevel=7&rotateEnabled=false&pitchEnabled=false&showsUserLocation=false&domain=zigbang`;
      }, { lat: center.lat, lng: center.lng, zoom });
      await page.waitForTimeout(waitMsPerCenter);
      await drainPendingSearches();
    }
  } finally {
    await page.close();
  }

  return [...ids];
}

function withZigbangMaxFilters(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set("depositMax", String(config.filters.depositMaxManwon));
  url.searchParams.set("rentMax", String(config.filters.monthlyRentMaxManwon));
  return url.toString();
}

async function fetchZigbangItemIds(url, service) {
  const body = await fetchJson(url, {
    headers: {
      "accept": "application/json, text/plain, */*",
      "origin": "https://www.zigbang.com",
      "referer": `https://www.zigbang.com/home/${service}/map`,
      "user-agent": "Mozilla/5.0"
    }
  });
  const ids = [];
  for (const item of body.items || []) {
    const id = item.id ?? item.item_id;
    if (!id) continue;
    const numericId = Number(id);
    if (Number.isFinite(numericId)) ids.push(numericId);
  }
  return ids;
}

async function fetchZigbangDetails(itemIds) {
  const all = [];
  const itemChunks = chunks([...new Set(itemIds)], 15);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < itemChunks.length) {
      const chunk = itemChunks[nextIndex];
      nextIndex += 1;
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
      } catch (error) {
        console.error("[zigbang] detail chunk failed:", error.message);
      }
    }
  }

  const workerCount = Math.min(env.zigbangDetailConcurrency, itemChunks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return all;
}

async function fetchZigbangListings() {
  const browser = await chromium.launch({ headless: env.headless });
  try {
    const [oneRoomIds, officetelIds] = await Promise.all([
      collectZigbangIdsForService(browser, "oneroom"),
      collectZigbangIdsForService(browser, "officetel")
    ]);
    console.log(`[zigbang] collected ids: oneroom=${oneRoomIds.length} officetel=${officetelIds.length} total=${new Set([...oneRoomIds, ...officetelIds]).size}`);
    const details = await fetchZigbangDetails([...oneRoomIds, ...officetelIds]);
    console.log(`[zigbang] fetched details: ${details.length}`);
    return details.map(normalizeZigbang);
  } finally {
    await browser.close();
  }
}

function normalizeZigbang(item) {
  const pyeong = item["전용면적"]?.p ? Number(item["전용면적"].p) : (
    item.size_m2 ? Number((Number(item.size_m2) / 3.305785).toFixed(1)) : null
  );
  const service = item.service_type || "";
  const routeType = service.includes("오피스텔") ? "officetel" : "oneroom";
  const text = [
    item.title,
    item.sales_type,
    item.service_type,
    item.floor_string,
    item.contract,
    ...(item.tags || []),
    ...(item.badges || [])
  ].filter(Boolean).join(" ");
  return {
    source: "zigbang",
    id: `zigbang:${item.item_id}`,
    rawId: item.item_id,
    listingNo: item.item_id,
    type: service,
    title: item.title || "(no title)",
    text,
    deposit: Number(item.deposit || 0),
    rent: Number(item.rent || 0),
    pyeong,
    maintenance: item.manage_cost ? Math.round(Number(item.manage_cost) / 10000) : null,
    floorText: item.floor_string || String(item.floor || ""),
    address: item.address || item.address1 || "",
    lat: item.location?.lat ?? item.random_location?.lat ?? null,
    lng: item.location?.lng ?? item.random_location?.lng ?? null,
    image: item.images_thumbnail,
    url: `https://www.zigbang.com/home/${routeType}/items/${item.item_id}?share=true`,
    createdAt: item.reg_date || null
  };
}

function isMatching(listing) {
  const f = config.filters;
  if (!isInsideConfiguredArea(listing)) return false;
  if (listing.source === "dabang" && !isDabangSeoulRegion(listing.regionCode)) return false;
  if (listing.source === "zigbang" && listing.address && !listing.address.includes("서울")) return false;
  if (!f.roomTypes.some((type) => String(listing.type).includes(type))) return false;
  if (listing.deposit > f.depositMaxManwon) return false;
  if (listing.rent > f.monthlyRentMaxManwon) return false;
  if (listing.pyeong !== null && listing.pyeong < f.minimumPyeong) return false;
  if (f.excludedFloors.some((word) => listing.floorText.includes(word) || listing.text.includes(word))) return false;
  if (f.requireMoveInRegistrationText && !hasRegistrationSignal(listing.text)) return false;
  return true;
}

function isDabangSeoulRegion(regionCode) {
  return Number.isFinite(regionCode) && regionCode >= 10000 && regionCode < 11000;
}

function hasRegistrationSignal(text) {
  const lower = text.toLowerCase();
  const compact = lower.replace(/\s+/g, "");
  const positive = config.filters.registrationPositiveWords.some((word) => {
    const w = word.toLowerCase();
    return lower.includes(w) || compact.includes(w.replace(/\s+/g, ""));
  });
  const negative = config.filters.registrationNegativeWords.some((word) => {
    const w = word.toLowerCase();
    return lower.includes(w) || compact.includes(w.replace(/\s+/g, ""));
  });
  return positive && !negative;
}

function isInsideConfiguredArea(listing) {
  const polygon = config.location.polygon;
  if (!polygon?.length || listing.lat === null || listing.lng === null) return true;
  return pointInPolygon(Number(listing.lat), Number(listing.lng), polygon);
}

function pointInPolygon(lat, lng, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;
    const intersects = ((yi > lat) !== (yj > lat))
      && (lng < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

async function loadSeen() {
  try {
    return JSON.parse(await fs.readFile(seenPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { ids: [], firstRunCompleted: false, updatedAt: null };
  }
}

async function saveSeen(state) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(seenPath, `${JSON.stringify(state, null, 2)}\n`);
}

async function sendTelegram(listing) {
  const message = formatListing(listing);
  if (dryRun || initSeen) {
    console.log(message);
    console.log("---");
    return;
  }
  await fetchJson(`https://api.telegram.org/bot${env.telegramToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.telegramChatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: config.telegram.disableWebPreview
    })
  });
}

function formatListing(listing) {
  const lines = [
    `🏠 <b>${escapeHtml(listing.source.toUpperCase())} ${escapeHtml(listing.type)}</b>`,
    escapeHtml(listing.title),
    `가격: 보증금 ${listing.deposit} / 월세 ${listing.rent}만원`,
    `면적: ${listing.pyeong ?? "?"}평`,
    `관리비: ${listing.maintenance === null ? "별도/확인필요" : `${listing.maintenance}만원`}`,
    listing.listingNo ? `매물번호: ${escapeHtml(listing.listingNo)}` : null,
    listing.address ? `지역: ${escapeHtml(listing.address)}` : null,
    listing.floorText ? `층/설명: ${escapeHtml(listing.floorText)}` : null,
    listing.createdAt ? `등록: ${escapeHtml(listing.createdAt)}` : null,
    `<a href="${escapeHtml(listing.url)}">열기</a>`
  ].filter(Boolean);
  return lines.join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function checkOnce() {
  const seen = await loadSeen();
  const seenIds = new Set(seen.ids);
  const sourceResults = [];

  if (env.dabangEnabled) {
    try {
      sourceResults.push(...await fetchDabangListings());
    } catch (error) {
      console.error("[dabang] failed:", error.message);
    }
  }

  if (env.zigbangEnabled) {
    try {
      sourceResults.push(...await fetchZigbangListings());
    } catch (error) {
      console.error("[zigbang] failed:", error.message);
    }
  }

  const unique = new Map();
  for (const listing of sourceResults) {
    if (!unique.has(listing.id)) unique.set(listing.id, listing);
  }

  const matches = [...unique.values()].filter(isMatching);
  const newMatches = matches.filter((listing) => !seenIds.has(listing.id));
  const shouldAlert = seen.firstRunCompleted || env.sendExistingOnFirstRun || initSeen || dryRun;
  const toSend = shouldAlert ? newMatches : [];

  console.log(`[${new Date().toISOString()}] scanned=${sourceResults.length} unique=${unique.size} matches=${matches.length} new=${newMatches.length} sending=${toSend.length}`);

  for (const listing of toSend) {
    await sendTelegram(listing);
    await sleep(250);
  }

  for (const listing of matches) seenIds.add(listing.id);
  if (!dryRun) {
    await saveSeen({
      ids: [...seenIds].slice(-10000),
      firstRunCompleted: true,
      updatedAt: new Date().toISOString()
    });
  }
}

function chunks(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  do {
    await checkOnce();
    if (once) break;
    await sleep(env.intervalMinutes * 60 * 1000);
  } while (true);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
