import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH = path.resolve("cr2dep.db");

export type Pair = {
  id: number;
  target: string;     // 0x-prefixed 20-byte hex (no TRON 0x41 prefix)
  calldata: string;   // 0x-prefixed hex
  salt: string;       // 0x-prefixed 32-byte hex
  deployed: number;
  tx_hash: string | null;
  created_at: string;
};

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
  }
  return db;
}

export function initDb(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS pairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL,
      calldata TEXT NOT NULL,
      salt TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000000000000000000000000000',
      deployed INTEGER NOT NULL DEFAULT 0,
      tx_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function insertPair(target: string, calldata: string, salt: string): number {
  const stmt = getDb().prepare(
    "INSERT INTO pairs (target, calldata, salt) VALUES (?, ?, ?)",
  );
  return Number(stmt.run(target, calldata, salt).lastInsertRowid);
}

export function getPair(id: number): Pair | undefined {
  return getDb().prepare("SELECT * FROM pairs WHERE id = ?").get(id) as Pair | undefined;
}

export function listPairs(): Pair[] {
  return getDb().prepare("SELECT * FROM pairs ORDER BY id").all() as Pair[];
}

export function markDeployed(id: number, txHash: string): void {
  getDb().prepare("UPDATE pairs SET deployed = 1, tx_hash = ? WHERE id = ?").run(txHash, id);
}
