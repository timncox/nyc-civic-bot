import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "civic-bot.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;

  const dir = path.dirname(DB_PATH);
  mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_districts (
      mmp_user_id TEXT NOT NULL,
      mmp_handle TEXT NOT NULL,
      address TEXT NOT NULL,
      council_district INTEGER,
      assembly_district INTEGER,
      election_district INTEGER,
      borough TEXT,
      lat REAL,
      lng REAL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (mmp_user_id)
    );

    CREATE TABLE IF NOT EXISTS district_groups (
      district_key TEXT NOT NULL,
      tier TEXT NOT NULL,
      mmp_thread_id TEXT NOT NULL,
      district_number INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (district_key)
    );

    CREATE TABLE IF NOT EXISTS broadcast_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      district_key TEXT NOT NULL,
      broadcast_type TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      sent_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return db;
}

// --- Bot state ---

export function getState(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM bot_state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setState(key: string, value: string): void {
  getDb().prepare("INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)").run(key, value);
}

// --- User districts ---

export interface UserDistrict {
  mmp_user_id: string;
  mmp_handle: string;
  address: string;
  council_district: number | null;
  assembly_district: number | null;
  election_district: number | null;
  borough: string | null;
  lat: number | null;
  lng: number | null;
  joined_at: number;
}

export function upsertUserDistrict(u: UserDistrict): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO user_districts
    (mmp_user_id, mmp_handle, address, council_district, assembly_district, election_district, borough, lat, lng, joined_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(u.mmp_user_id, u.mmp_handle, u.address, u.council_district, u.assembly_district, u.election_district, u.borough, u.lat, u.lng, u.joined_at);
}

export function getUserDistrict(mmpUserId: string): UserDistrict | null {
  return getDb().prepare("SELECT * FROM user_districts WHERE mmp_user_id = ?").get(mmpUserId) as UserDistrict | null;
}

// --- District groups ---

export interface DistrictGroup {
  district_key: string;
  tier: string;
  mmp_thread_id: string;
  district_number: number | null;
  created_at: number;
}

export function getDistrictGroup(key: string): DistrictGroup | null {
  return getDb().prepare("SELECT * FROM district_groups WHERE district_key = ?").get(key) as DistrictGroup | null;
}

export function upsertDistrictGroup(g: DistrictGroup): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO district_groups
    (district_key, tier, mmp_thread_id, district_number, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(g.district_key, g.tier, g.mmp_thread_id, g.district_number, g.created_at);
}

export function getGroupsByTier(tier: string): DistrictGroup[] {
  return getDb().prepare("SELECT * FROM district_groups WHERE tier = ?").all(tier) as DistrictGroup[];
}

// --- Broadcast log ---

export function hasBroadcast(districtKey: string, contentHash: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM broadcast_log WHERE district_key = ? AND content_hash = ?").get(districtKey, contentHash);
  return !!row;
}

export function logBroadcast(districtKey: string, broadcastType: string, contentHash: string): void {
  getDb().prepare("INSERT INTO broadcast_log (district_key, broadcast_type, content_hash, sent_at) VALUES (?, ?, ?, ?)").run(districtKey, broadcastType, contentHash, Math.floor(Date.now() / 1000));
}
