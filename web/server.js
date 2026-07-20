import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { openDb } from "../src/db.js";

const rootDir = path.resolve(new URL(".", import.meta.url).pathname, "..");
const dbPath = path.join(rootDir, "data", "listings.db");
const indexPath = path.join(rootDir, "web", "index.html");
const db = openDb(dbPath);
const port = Number(process.env.PORT || 3000);

const listStmt = db.prepare(`
  SELECT id, source, type, title, deposit, rent, pyeong, maintenance,
         address, lat, lng, url, image, images,
         removed_at, favorited_at, kept_at, viewed_at,
         first_seen_at, last_seen_at
  FROM listings
  WHERE lat IS NOT NULL AND lng IS NOT NULL AND removed_at IS NULL
`);

const favStmt = db.prepare(`
  SELECT id, source, type, title, deposit, rent, pyeong, maintenance,
         address, lat, lng, url, image, images,
         favorited_at, first_seen_at, last_seen_at
  FROM listings
  WHERE favorited_at IS NOT NULL
  ORDER BY favorited_at DESC
`);

const keptStmt = db.prepare(`
  SELECT id, source, type, title, deposit, rent, pyeong, maintenance,
         address, lat, lng, url, image, images,
         kept_at, first_seen_at, last_seen_at
  FROM listings
  WHERE kept_at IS NOT NULL AND removed_at IS NULL
  ORDER BY kept_at DESC
`);

const setRemovedStmt = db.prepare("UPDATE listings SET removed_at = ? WHERE id = ?");
const setFavoritedStmt = db.prepare("UPDATE listings SET favorited_at = ? WHERE id = ?");
const setKeptStmt = db.prepare("UPDATE listings SET kept_at = ? WHERE id = ?");
const setViewedStmt = db.prepare("UPDATE listings SET viewed_at = ? WHERE id = ?");
const findRawStmt = db.prepare("SELECT source, raw_id, url FROM listings WHERE id = ?");

async function fetchZigbangRich(rawId) {
  const headers = {
    "accept": "application/json, text/plain, */*",
    "origin": "https://www.zigbang.com",
    "referer": `https://www.zigbang.com/home/oneroom/items/${rawId}`,
    "user-agent": "Mozilla/5.0"
  };
  // v3 has the long description, options, manageCostDetail, moveinDate, etc.
  // items/list adds tags, badges, reg_date, addressOrigin.
  const [v3, list] = await Promise.allSettled([
    fetch(`https://apis.zigbang.com/v3/items/${rawId}`, { headers }).then((r) => r.ok ? r.json() : null),
    fetch("https://apis.zigbang.com/house/property/v1/items/list", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ itemIds: [Number(rawId)] })
    }).then((r) => r.ok ? r.json() : null)
  ]);
  const v3Data = v3.status === "fulfilled" ? v3.value : null;
  const v3Item = v3Data?.item || null;
  const listItem = list.status === "fulfilled" ? list.value?.items?.[0] : null;
  if (!v3Item && !listItem) return null;
  return {
    ...(listItem || {}),
    ...(v3Item || {}),
    _agent: v3Data?.agent || null,
    _realtor: v3Data?.realtor || null,
    _subways: v3Data?.subways || null
  };
}

function expandImages(r) {
  let imgs = [];
  if (r.images) { try { imgs = JSON.parse(r.images); } catch {} }
  if (!imgs.length && r.image) imgs = [r.image];
  return { ...r, images: imgs };
}

function rowsWithImages() {
  return listStmt.all().map(expandImages);
}

function favRowsWithImages() {
  return favStmt.all().map(expandImages);
}

function keptRowsWithImages() {
  return keptStmt.all().map(expandImages);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; if (data.length > 64_000) reject(new Error("body too large")); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function extend(b, lat, lng) {
  b.sw.lat = Math.min(b.sw.lat, lat); b.sw.lng = Math.min(b.sw.lng, lng);
  b.ne.lat = Math.max(b.ne.lat, lat); b.ne.lng = Math.max(b.ne.lng, lng);
}

// Static fallback for dongs that Zigbang doesn't carry in the current filter slice.
// Used only when the dynamic Zigbang-derived map is empty for that dong.
const SEOUL_DONG_TO_GU_FALLBACK = {
  "석관동": "성북구", "대치동": "강남구", "송정동": "강서구", "망우동": "중랑구",
  "연희동": "서대문구", "성수동": "성동구", "보광동": "용산구",
  "삼성동": "강남구", "역삼동": "강남구", "논현동": "강남구", "압구정동": "강남구", "청담동": "강남구", "도곡동": "강남구",
  "잠실동": "송파구", "방이동": "송파구", "가락동": "송파구", "문정동": "송파구",
  "한남동": "용산구", "이태원동": "용산구", "후암동": "용산구",
  "여의도동": "영등포구", "당산동": "영등포구",
  "마포동": "마포구", "공덕동": "마포구", "상암동": "마포구", "망원동": "마포구",
  "회기동": "동대문구", "전농동": "동대문구", "이문동": "동대문구",
  "노량진동": "동작구", "흑석동": "동작구", "사당동": "동작구",
  "혜화동": "종로구", "명륜동": "종로구",
  "정릉동": "성북구", "안암동": "성북구", "돈암동": "성북구",
  "을지로": "중구", "명동": "중구"
};

function aggregateAreas(rows) {
  // Build dong -> gu map from Zigbang addresses ("서울시 관악구 봉천동")
  const dongToGu = { ...SEOUL_DONG_TO_GU_FALLBACK };
  for (const r of rows) {
    if (r.source !== "zigbang" || !r.address) continue;
    const m = r.address.match(/(\S+구)\s+(\S+동)/);
    if (m) dongToGu[m[2]] = m[1];
  }
  const findGu = (r) => {
    if (r.source === "zigbang") {
      const m = r.address?.match(/(\S+구)/);
      return m ? m[1] : null;
    }
    if (!r.address) return null;
    if (dongToGu[r.address]) return dongToGu[r.address];
    const base = r.address.replace(/[0-9]가$/, "");
    return dongToGu[base] || null;
  };
  const findDong = (r) => {
    if (r.source === "zigbang") {
      const m = r.address?.match(/(\S+동)/);
      return m ? m[1] : null;
    }
    return r.address || null;
  };

  const gus = new Map();
  for (const r of rows) {
    const gu = findGu(r) || "(기타)";
    const dong = findDong(r) || "(기타)";
    if (!gus.has(gu)) gus.set(gu, { gu, count: 0, sw: { lat: 90, lng: 180 }, ne: { lat: -90, lng: -180 }, dongs: new Map() });
    const g = gus.get(gu);
    g.count++; extend(g, r.lat, r.lng);
    if (!g.dongs.has(dong)) g.dongs.set(dong, { dong, count: 0, sw: { lat: 90, lng: 180 }, ne: { lat: -90, lng: -180 } });
    const d = g.dongs.get(dong);
    d.count++; extend(d, r.lat, r.lng);
  }
  return [...gus.values()]
    .map((g) => ({ ...g, dongs: [...g.dongs.values()].sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.count - a.count);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/action") {
      const body = JSON.parse(await readBody(req) || "{}");
      const { id, action, value } = body;
      if (!id || !["remove", "favorite", "keep", "view"].includes(action)) {
        res.writeHead(400).end("bad request"); return;
      }
      const ts = value ? new Date().toISOString() : null;
      const stmt = action === "remove" ? setRemovedStmt
                 : action === "favorite" ? setFavoritedStmt
                 : action === "keep" ? setKeptStmt
                 : setViewedStmt;
      stmt.run(ts, id);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, ts }));
      return;
    }
    if (req.url === "/listings") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(rowsWithImages()));
      return;
    }
    if (req.url === "/favorites") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(favRowsWithImages()));
      return;
    }
    if (req.url === "/kept") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(keptRowsWithImages()));
      return;
    }
    if (req.url?.startsWith("/listing-source")) {
      const u = new URL(req.url, "http://x");
      const id = u.searchParams.get("id");
      if (!id) { res.writeHead(400).end("missing id"); return; }
      const row = findRawStmt.get(id);
      if (!row) { res.writeHead(404).end("not found"); return; }
      let data = null;
      if (row.source === "zigbang") {
        try { data = await fetchZigbangRich(row.raw_id); } catch (e) { console.error("zigbang detail fetch failed:", e.message); }
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ source: row.source, raw_id: row.raw_id, url: row.url, data }));
      return;
    }
    if (req.url === "/areas") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(aggregateAreas(rowsWithImages())));
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      const html = await fs.readFile(indexPath, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.url === "/favorites.html") {
      const html = await fs.readFile(path.join(rootDir, "web", "favorites.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.url === "/kept.html") {
      const html = await fs.readFile(path.join(rootDir, "web", "kept.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.url === "/shortlist.html") {
      const html = await fs.readFile(path.join(rootDir, "web", "shortlist.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.url?.startsWith("/detail.html")) {
      const html = await fs.readFile(path.join(rootDir, "web", "detail.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "text/plain" }).end("server error");
  }
});

server.listen(port, () => {
  console.log(`Seoul housing map → http://localhost:${port}`);
});
