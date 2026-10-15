// Validation of a database unpacked from a backup, before it may replace the live index.
import { DatabaseSync } from "node:sqlite";
import { badRequest } from "./errors.mjs";

/**
 * The unpacked database must open, pass SQLite's check, have the index's tables, and hold only plain
 * thumbnail names (a crafted backup must not make the engine touch files outside its thumbs folder).
 */
export function checkIndexDb(file) {
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch { throw badRequest("The backup's index is damaged"); }
  try {
    let ok;
    try { ok = db.prepare("PRAGMA quick_check").get()?.quick_check === "ok"; } catch { ok = false; }
    if (!ok) throw badRequest("The backup's index is damaged");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    if (!["folders", "files", "vectors", "prefs"].every((t) => tables.has(t))) throw badRequest("The backup's index is damaged (tables missing)");
    // only names the indexer itself generates: 20 hex digits + .jpg (they end up in file paths and in the page)
    const unsafe = db.prepare(`SELECT 1 FROM (SELECT thumb FROM files UNION ALL SELECT thumb FROM vectors)
      WHERE thumb IS NOT NULL AND (length(thumb) <> 24 OR substr(thumb, 21) <> '.jpg' OR substr(thumb, 1, 20) GLOB '*[^0-9a-f]*')
      LIMIT 1`).get();
    if (unsafe) throw badRequest("The backup's index contains invalid entries");
  } finally {
    db.close();
  }
}

