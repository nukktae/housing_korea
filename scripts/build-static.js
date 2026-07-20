import fs from "node:fs/promises";
import path from "node:path";
import { openDb } from "../src/db.js";

const rootDir = path.resolve(new URL(".", import.meta.url).pathname, "..");
const dbPath = path.join(rootDir, "data", "listings.db");
const publicDir = path.join(rootDir, "public");
const dataOutDir = path.join(publicDir, "data");
const detailsOutDir = path.join(dataOutDir, "details");

const db = openDb(dbPath);

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function expandImages(r) {
  let imgs = [];
  if (r.images) { try { imgs = JSON.parse(r.images); } catch {} }
  if (!imgs.length && r.image) imgs = [r.image];
  return { ...r, images: imgs };
}

async function fetchZigbangRich(rawId) {
  const headers = {
    "accept": "application/json, text/plain, */*",
    "origin": "https://www.zigbang.com",
    "referer": `https://www.zigbang.com/home/oneroom/items/${rawId}`,
    "user-agent": "Mozilla/5.0"
  };
  const [v3Res, listRes] = await Promise.allSettled([
    fetch(`https://apis.zigbang.com/v3/items/${rawId}`, { headers }),
    fetch("https://apis.zigbang.com/house/property/v1/items/list", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ itemIds: [Number(rawId)] })
    })
  ]);
  const v3 = v3Res.status === "fulfilled" && v3Res.value.ok ? await v3Res.value.json() : null;
  const list = listRes.status === "fulfilled" && listRes.value.ok ? await listRes.value.json() : null;
  const v3Item = v3?.item || null;
  const listItem = list?.items?.[0] || null;
  if (!v3Item && !listItem) return null;
  return {
    ...(listItem || {}),
    ...(v3Item || {}),
    _agent: v3?.agent || null,
    _realtor: v3?.realtor || null,
    _subways: v3?.subways || null
  };
}

const safeId = (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

const SUPABASE_URL = "https://ngpewoyrzhpvjmvlaqka.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5ncGV3b3lyemhwdmptdmxhcWthIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5NjAzNjMsImV4cCI6MjA5NzUzNjM2M30.fDNo04yBRP9LYLdlXizUMAI_2YEtSz9tHdX5vuy4dBk";

const SUPABASE_INIT = `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.0/dist/umd/supabase.min.js"></script>
<script>
  (function() {
    try {
      window.SB = window.supabase.createClient(
        ${JSON.stringify(SUPABASE_URL)},
        ${JSON.stringify(SUPABASE_ANON_KEY)}
      );
    } catch (e) { console.warn("Supabase init failed:", e); }
  })();
</script>`;

const PIN_GATE = `<style>
  .pin-gate { position: fixed; inset: 0; z-index: 100000; background: #fff;
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
  .pin-card { background: #fafafa; border-radius: 18px; padding: 40px 44px 32px;
    text-align: center; max-width: 360px; width: 90%; }
  .pin-card h1 { font-size: 20px; font-weight: 700; margin: 0 0 6px; color: #111; letter-spacing: -0.01em; }
  .pin-card p { font-size: 13px; color: #8e8e93; margin: 0 0 28px; }
  .pin-inputs { display: flex; gap: 10px; justify-content: center; margin-bottom: 14px; }
  .pin-inputs input {
    width: 50px; height: 60px; text-align: center; font-size: 24px; font-weight: 600;
    border: 0; background: #fff; border-radius: 12px; outline: 2px solid transparent;
    color: #111; caret-color: #2563eb; font-family: inherit;
    transition: outline-color 0.15s, transform 0.1s;
  }
  .pin-inputs input:focus { outline-color: #2563eb; }
  .pin-inputs.shake { animation: pinShake 0.35s; }
  @keyframes pinShake { 0%,100% { transform: translateX(0) } 25% { transform: translateX(-6px) } 75% { transform: translateX(6px) } }
  .pin-card .err { color: #ef4444; font-size: 12px; min-height: 16px; }
</style>
<div class="pin-gate" id="pin-gate">
  <div class="pin-card">
    <h1>비밀번호</h1>
    <p>4자리 코드를 입력하세요</p>
    <div class="pin-inputs" id="pin-inputs">
      <input maxlength="1" inputmode="numeric" pattern="[0-9]*" autocomplete="off">
      <input maxlength="1" inputmode="numeric" pattern="[0-9]*" autocomplete="off">
      <input maxlength="1" inputmode="numeric" pattern="[0-9]*" autocomplete="off">
      <input maxlength="1" inputmode="numeric" pattern="[0-9]*" autocomplete="off">
    </div>
    <div class="err" id="pin-err"></div>
  </div>
</div>
<script>
(function() {
  var KEY = "housing_pin_v1";
  var PIN = "0111";
  function unlock() {
    var g = document.getElementById("pin-gate");
    if (!g) return;
    g.style.transition = "opacity 0.25s";
    g.style.opacity = "0";
    setTimeout(function() { g.remove(); }, 260);
  }
  if (localStorage.getItem(KEY) === "ok") {
    // Already verified — remove gate as soon as it's parsed
    document.addEventListener("DOMContentLoaded", unlock);
    return;
  }
  document.addEventListener("DOMContentLoaded", function() {
    var gate = document.getElementById("pin-gate");
    if (!gate) return;
    var inputs = gate.querySelectorAll(".pin-inputs input");
    var err = document.getElementById("pin-err");
    var box = document.getElementById("pin-inputs");
    inputs[0].focus();
    function check() {
      var v = Array.prototype.map.call(inputs, function(i) { return i.value; }).join("");
      if (v.length !== 4) return;
      if (v === PIN) {
        localStorage.setItem(KEY, "ok");
        unlock();
      } else {
        err.textContent = "코드가 일치하지 않습니다";
        box.classList.add("shake");
        setTimeout(function() {
          box.classList.remove("shake");
          for (var i = 0; i < inputs.length; i++) inputs[i].value = "";
          inputs[0].focus();
        }, 360);
      }
    }
    inputs.forEach(function(input, idx) {
      input.addEventListener("input", function() {
        input.value = (input.value || "").replace(/[^0-9]/g, "");
        if (input.value && idx < 3) inputs[idx + 1].focus();
        check();
      });
      input.addEventListener("keydown", function(e) {
        if (e.key === "Backspace" && !input.value && idx > 0) inputs[idx - 1].focus();
      });
      input.addEventListener("paste", function(e) {
        e.preventDefault();
        var data = ((e.clipboardData || window.clipboardData).getData("text") || "").replace(/[^0-9]/g, "").slice(0, 4);
        if (!data) return;
        for (var i = 0; i < 4; i++) inputs[i].value = data[i] || "";
        if (data.length === 4) check();
        else inputs[data.length].focus();
      });
    });
  });
})();
</script>`;

async function transformHtml(srcPath, destPath, replacements) {
  let html = await fs.readFile(srcPath, "utf8");
  for (const [find, replace] of replacements) {
    html = html.replaceAll(find, replace);
  }
  // Inject PIN gate right after <body>, Supabase SDK before </head>
  html = html.replace("</head>", SUPABASE_INIT + "\n</head>");
  html = html.replace("<body>", "<body>\n" + PIN_GATE);
  await fs.writeFile(destPath, html);
}

async function main() {
  console.log("Building static export…");
  await ensureDir(publicDir);
  await ensureDir(dataOutDir);
  await ensureDir(detailsOutDir);

  // 1. Export listings
  const rows = db.prepare(`
    SELECT id, source, type, title, deposit, rent, pyeong, maintenance,
           address, lat, lng, url, image, images,
           favorited_at, kept_at, viewed_at,
           first_seen_at, last_seen_at
    FROM listings
    WHERE removed_at IS NULL AND lat IS NOT NULL AND lng IS NOT NULL
    ORDER BY rent ASC, deposit ASC
  `).all().map(expandImages);

  console.log(`Exporting ${rows.length} listings → data/listings.json`);
  await fs.writeFile(path.join(dataOutDir, "listings.json"), JSON.stringify(rows));

  // 2. Pre-fetch rich details for each Zigbang listing
  console.log("Pre-fetching Zigbang v3 details…");
  let ok = 0, fail = 0;
  for (const r of rows) {
    if (r.source !== "zigbang") continue;
    try {
      const data = await fetchZigbangRich(r.raw_id || r.id.split(":")[1]);
      const out = { source: r.source, raw_id: r.raw_id, url: r.url, data };
      await fs.writeFile(path.join(detailsOutDir, `${safeId(r.id)}.json`), JSON.stringify(out));
      ok++;
    } catch (e) {
      console.warn(`  failed ${r.id}:`, e.message);
      fail++;
    }
    process.stdout.write(`  ${ok}/${rows.length}\r`);
  }
  console.log(`\nFetched ${ok} details, ${fail} failed`);

  // 3. Transform HTML files (rewrite paths + hide unwanted UI)
  const webDir = path.join(rootDir, "web");

  const sharedReplacements = [
    // Fetch endpoints → static JSON
    [`fetch("/listings")`, `fetch("/data/listings.json")`],
    [`fetch("/areas")`, `fetch("/data/areas.json")`],
    [`fetch("/favorites")`, `fetch("/data/listings.json")`],
    [`fetch("/kept")`, `fetch("/data/listings.json")`]
  ];

  // index.html ← shortlist.html
  await transformHtml(path.join(webDir, "shortlist.html"), path.join(publicDir, "index.html"), [
    ...sharedReplacements,
    // detail link unchanged (still /detail.html?id=…)
    // Hide nav links to other pages (keep tags, just hide via style)
    [`<a href="/">Map</a>`, `<a href="/" style="display:none">Map</a>`],
    [`<a href="/favorites.html">Favorites</a>`, `<a href="/favorites.html" style="display:none">Favorites</a>`],
    [`<a href="/kept.html">Keep</a>`, `<a href="/kept.html" style="display:none">Keep</a>`],
    // Hide the delete button overlay on cards (visitors are read-only)
    [`<button class="del-btn" type="button" aria-label="Remove from shortlist">✕</button>`, ""]
  ]);

  // detail.html
  await transformHtml(path.join(webDir, "detail.html"), path.join(publicDir, "detail.html"), [
    ...sharedReplacements,
    // Rewrite source fetch to per-id static file (URL params)
    [`fetch(\`/listing-source?id=\${encodeURIComponent(r.id)}\`)`,
     `fetch(\`/data/details/\${r.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json\`)`],
    // On the public build, the shortlist lives at "/" — rewrite all references
    [`href="/shortlist.html"`, `href="/"`],
    [`location.href = "/shortlist.html"`, `location.href = "/"`],
    // Hide nav links
    [`<a href="/">Map</a>`, `<a href="/" style="display:none">Map</a>`],
    [`<a href="/favorites.html">Favorites</a>`, `<a href="/favorites.html" style="display:none">Favorites</a>`],
    [`<a href="/kept.html">Keep</a>`, `<a href="/kept.html" style="display:none">Keep</a>`],
    // Hide actions overlay (read-only visitors)
    [`<div class="actions-overlay">`, `<div class="actions-overlay" style="display:none">`]
  ]);

  // 4. vercel.json for clean routing
  await fs.writeFile(path.join(publicDir, "vercel.json"), JSON.stringify({
    cleanUrls: false,
    headers: [
      { source: "/data/(.*)", headers: [{ key: "cache-control", value: "public, max-age=300" }] }
    ]
  }, null, 2));

  console.log(`\nDone. public/ contains:`);
  console.log(`  index.html, detail.html`);
  console.log(`  data/listings.json (${rows.length} rows)`);
  console.log(`  data/details/ (${ok} files)`);
  console.log(`  vercel.json`);
}

await main();
