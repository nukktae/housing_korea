import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const rootDir = path.resolve(new URL(".", import.meta.url).pathname, "..");
const config = JSON.parse(await fs.readFile(path.join(rootDir, "config.json"), "utf8"));

const DEPOSIT_MAX = 500;     // 만원
const RENT_MAX = 68;         // 만원, excludes 관리비

const WIDE = {
  depositRange: { min: 0, max: DEPOSIT_MAX },
  priceRange: { min: 0, max: RENT_MAX },
  tradeRange: { min: 0, max: 999999 },
  pyeongRange: { min: 0, max: 999999 },
  useApprovalDateRange: { min: 0, max: 999999 },
  parkingNumRange: { min: 0, max: 999999 }
};

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

function buildQuery(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) s.set(k, typeof v === "string" ? v : JSON.stringify(v));
  return s.toString();
}

function dabangHeaders(referer) {
  return {
    "accept": "application/json, text/plain, */*",
    "d-api-version": "5.0.0",
    "d-app-version": "1",
    "d-call-type": "web",
    "referer": referer,
    "user-agent": "Mozilla/5.0"
  };
}

function dabangOneTwoFilters() {
  return {
    sellingTypeList: ["MONTHLY_RENT"],
    depositRange: WIDE.depositRange,
    priceRange: WIDE.priceRange,
    isIncludeMaintenance: false,
    pyeongRange: WIDE.pyeongRange,
    useApprovalDateRange: WIDE.useApprovalDateRange,
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
  return {
    sellingTypeList: ["MONTHLY_RENT"],
    tradeRange: WIDE.tradeRange,
    depositRange: WIDE.depositRange,
    priceRange: WIDE.priceRange,
    isIncludeMaintenance: false,
    pyeongRange: WIDE.pyeongRange,
    useApprovalDateRange: WIDE.useApprovalDateRange,
    dealTypeList: ["AGENT"],
    parkingNumRange: WIDE.parkingNumRange,
    canParking: false,
    isShortLease: false,
    hasElevator: false,
    hasPano: false,
    roomCountList: []
  };
}

function isDabangSeoul(gid) {
  const n = Number(gid || 0);
  return Number.isFinite(n) && n >= 10000 && n < 11000;
}

async function dabangCategoryTotal(category, filters) {
  const referer = `https://www.dabangapp.com/map/${category}`;
  let bboxTotal = 0;
  let seoulCount = 0;
  let page = 1;
  while (true) {
    const url = `https://www.dabangapp.com/api/v5/room-list/category/${category}/bbox?${buildQuery({
      filters,
      bbox: config.location.bbox,
      zoom: 11,
      useMap: "naver",
      page
    })}`;
    const body = await fetchJson(url, { headers: dabangHeaders(referer) });
    const result = body?.result || {};
    const list = result.roomList || [];
    if (page === 1) bboxTotal = Number(result.total || list.length || 0);
    for (const item of list) if (isDabangSeoul(item.gid)) seoulCount++;
    const limit = Number(result.limit || list.length || 24);
    const total = Number(result.total || list.length);
    if (!list.length || page * limit >= total) break;
    page++;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { bboxTotal, seoulCount };
}

function seoulGridCenters() {
  const { sw, ne } = config.location.bbox;
  const { stepLat, stepLng } = config.location.zigbangGrid;
  const out = [];
  for (let lat = sw.lat + stepLat / 2; lat < ne.lat; lat += stepLat) {
    for (let lng = sw.lng + stepLng / 2; lng < ne.lng; lng += stepLng) {
      out.push({ lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) });
    }
  }
  return out;
}

async function zigbangIdsForService(browser, service) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "ko-KR" });
  const ids = new Set();
  const pending = [];
  const seenUrls = new Set();
  const endpointPart = service === "officetel" ? "/items/officetels" : "/items/onerooms";

  page.on("request", (req) => {
    const u = req.url();
    if (!u.includes("apis.zigbang.com/house/property/v1") || !u.includes(endpointPart)) return;
    const wide = new URL(u);
    wide.searchParams.set("depositMax", String(DEPOSIT_MAX));
    wide.searchParams.set("rentMax", String(RENT_MAX));
    const key = wide.toString();
    if (seenUrls.has(key)) return;
    seenUrls.add(key);
    pending.push(
      fetchJson(key, {
        headers: {
          "accept": "application/json, text/plain, */*",
          "origin": "https://www.zigbang.com",
          "referer": `https://www.zigbang.com/home/${service}/map`,
          "user-agent": "Mozilla/5.0"
        }
      }).then((body) => {
        for (const item of body.items || []) {
          const n = Number(item.id ?? item.item_id);
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
    const centers = seoulGridCenters();
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

  return ids;
}

console.log(`== Dabang (월세 ≤${RENT_MAX}만, 보증금 ≤${DEPOSIT_MAX}만, above-ground) ==`);
const [dOneTwo, dOfficetel] = await Promise.all([
  dabangCategoryTotal("one-two", dabangOneTwoFilters()),
  dabangCategoryTotal("officetel", dabangOfficetelFilters())
]);
console.log(`  원룸 (one-two ONE_ROOM): bbox=${dOneTwo.bboxTotal} | strict Seoul=${dOneTwo.seoulCount}`);
console.log(`  오피스텔:                bbox=${dOfficetel.bboxTotal} | strict Seoul=${dOfficetel.seoulCount}`);
console.log(`  TOTAL strict Seoul:      ${dOneTwo.seoulCount + dOfficetel.seoulCount}`);

async function fetchZigbangDetails(ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 15) chunks.push(ids.slice(i, i + 15));
  const out = [];
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < chunks.length) {
      const chunk = chunks[nextIdx++];
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
        out.push(...(body.items || []));
      } catch (e) { /* skip chunk */ }
    }
  }
  const workers = Math.min(8, chunks.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

function classifyFloor(item) {
  const s = (item.floor_string || String(item.floor || "")).trim();
  if (!s) return "unknown";
  if (s.includes("반지")) return "반지하";
  if (s.includes("지하")) return "지하";
  if (s.includes("옥탑")) return "옥탑";
  return "above_ground";
}

console.log(`\n== Zigbang (Seoul, 월세 ≤${RENT_MAX}만, 보증금 ≤${DEPOSIT_MAX}만) ==`);
const browser = await chromium.launch({ headless: true });
try {
  const [oneSet, officeSet] = await Promise.all([
    zigbangIdsForService(browser, "oneroom"),
    zigbangIdsForService(browser, "officetel")
  ]);
  const union = [...new Set([...oneSet, ...officeSet])];
  console.log(`  ids collected: 원룸=${oneSet.size}, 오피스텔=${officeSet.size}, unique=${union.length}`);
  console.log(`  fetching details for ${union.length} items...`);
  const items = await fetchZigbangDetails(union);
  console.log(`  fetched details: ${items.length}`);

  const isSeoul = (it) => {
    const addr = it.address1 || it.addressOrigin?.fullText || it.address || "";
    return addr.includes("서울");
  };
  const seoulItems = items.filter(isSeoul);
  const nonSeoul = items.length - seoulItems.length;
  console.log(`  strict Seoul (address contains '서울'): ${seoulItems.length}  (bbox-only excluded: ${nonSeoul})`);

  const buckets = { above_ground: 0, "반지하": 0, "지하": 0, "옥탑": 0, unknown: 0 };
  const byService = {};
  for (const it of seoulItems) {
    const floor = classifyFloor(it);
    buckets[floor] = (buckets[floor] || 0) + 1;
    const svc = it.service_type || "?";
    byService[svc] = byService[svc] || { above_ground: 0, "반지하": 0, "지하": 0, "옥탑": 0, unknown: 0 };
    byService[svc][floor]++;
  }
  console.log("\n  Floor breakdown (strict Seoul):");
  for (const [k, v] of Object.entries(buckets)) console.log(`    ${k.padEnd(14)}: ${v}`);

  console.log("\n  By service_type (strict Seoul):");
  for (const [svc, b] of Object.entries(byService)) {
    const total = Object.values(b).reduce((a, c) => a + c, 0);
    console.log(`    ${svc} (${total}): above=${b.above_ground}, 반지하=${b["반지하"]}, 지하=${b["지하"]}, 옥탑=${b["옥탑"]}, unknown=${b.unknown}`);
  }

  const aboveGround = buckets.above_ground + buckets.unknown;
  console.log(`\n  ABOVE-GROUND strict Seoul — apples-to-apples vs Dabang: ${aboveGround}`);
} finally { await browser.close(); }
