import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  raw_id TEXT,
  listing_no TEXT,
  type TEXT,
  title TEXT,
  deposit INTEGER,
  rent INTEGER,
  pyeong REAL,
  maintenance INTEGER,
  floor_text TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  image TEXT,
  images TEXT,
  url TEXT,
  created_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS listings_source_last_seen_idx
  ON listings(source, last_seen_at);
`;

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  for (const col of ["images TEXT", "removed_at TEXT", "favorited_at TEXT", "kept_at TEXT"]) {
    try { db.exec(`ALTER TABLE listings ADD COLUMN ${col}`); } catch { /* exists */ }
  }
  return db;
}

export function upsertListings(db, listings, now = new Date().toISOString()) {
  const stmt = db.prepare(`
    INSERT INTO listings (
      id, source, raw_id, listing_no, type, title,
      deposit, rent, pyeong, maintenance,
      floor_text, address, lat, lng, image, images, url,
      created_at, first_seen_at, last_seen_at
    ) VALUES (
      @id, @source, @raw_id, @listing_no, @type, @title,
      @deposit, @rent, @pyeong, @maintenance,
      @floor_text, @address, @lat, @lng, @image, @images, @url,
      @created_at, @now, @now
    )
    ON CONFLICT(id) DO UPDATE SET
      listing_no = excluded.listing_no,
      type = excluded.type,
      title = excluded.title,
      deposit = excluded.deposit,
      rent = excluded.rent,
      pyeong = excluded.pyeong,
      maintenance = excluded.maintenance,
      floor_text = excluded.floor_text,
      address = excluded.address,
      lat = excluded.lat,
      lng = excluded.lng,
      image = excluded.image,
      images = excluded.images,
      url = excluded.url,
      created_at = COALESCE(excluded.created_at, listings.created_at),
      last_seen_at = @now
  `);

  const tx = db.transaction((rows) => {
    for (const l of rows) {
      stmt.run({
        id: l.id,
        source: l.source,
        raw_id: l.rawId == null ? null : String(l.rawId),
        listing_no: l.listingNo == null ? null : String(l.listingNo),
        type: l.type ?? null,
        title: l.title ?? null,
        deposit: l.deposit ?? null,
        rent: l.rent ?? null,
        pyeong: l.pyeong ?? null,
        maintenance: l.maintenance ?? null,
        floor_text: l.floorText ?? null,
        address: l.address ?? null,
        lat: l.lat ?? null,
        lng: l.lng ?? null,
        image: l.image ?? null,
        images: Array.isArray(l.images) && l.images.length ? JSON.stringify(l.images) : null,
        url: l.url ?? null,
        created_at: l.createdAt ?? null,
        now
      });
    }
  });

  tx(listings);
}
