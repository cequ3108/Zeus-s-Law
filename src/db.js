const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  mobile TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'org', 'founder')),
  merit INTEGER NOT NULL,
  quota INTEGER NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
  block_reason TEXT,
  password_hash TEXT,
  city TEXT,
  district TEXT,
  availability TEXT,
  created_at TEXT NOT NULL,
  CHECK (merit >= 0),
  CHECK (quota >= 0),
  CHECK (merit <= quota)
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY,
  mobile TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_otp_mobile ON otp_codes (mobile, created_at);

CREATE TABLE IF NOT EXISTS org_applications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  org_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('offer', 'need')),
  category TEXT NOT NULL CHECK (category IN ('food', 'transport', 'other')),
  description TEXT NOT NULL,
  title TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'matched', 'settled', 'cancelled')),
  accepter_id INTEGER REFERENCES users(id),
  host_id INTEGER REFERENCES users(id),
  seeker_id INTEGER REFERENCES users(id),
  host_value INTEGER CHECK (host_value IS NULL OR host_value >= 0),
  seeker_value INTEGER CHECK (seeker_value IS NULL OR seeker_value >= 0),
  settled_amount INTEGER CHECK (settled_amount IS NULL OR settled_amount >= 0),
  settled_on TEXT,
  created_at TEXT NOT NULL,
  matched_at TEXT,
  settled_at TEXT,
  city TEXT,
  district TEXT,
  expires_at TEXT,
  meeting_place TEXT,
  meeting_time TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_status ON posts (status, id);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts (author_id);
CREATE INDEX IF NOT EXISTS idx_posts_accepter ON posts (accepter_id);

CREATE TABLE IF NOT EXISTS daily_settlements (
  id INTEGER PRIMARY KEY,
  user_lo INTEGER NOT NULL REFERENCES users(id),
  user_hi INTEGER NOT NULL REFERENCES users(id),
  taipei_date TEXT NOT NULL,
  post_id INTEGER NOT NULL UNIQUE REFERENCES posts(id),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  UNIQUE (user_lo, user_hi, taipei_date)
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  rater_id INTEGER NOT NULL REFERENCES users(id),
  ratee_id INTEGER NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (post_id, rater_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_ratee ON ratings (ratee_id);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta_merit INTEGER NOT NULL,
  delta_quota INTEGER NOT NULL,
  merit_after INTEGER NOT NULL,
  quota_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  post_id INTEGER REFERENCES posts(id),
  counterparty_id INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger (user_id, id);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expire INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions (expire);

CREATE TRIGGER IF NOT EXISTS ledger_no_update
BEFORE UPDATE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS ledger_no_delete
BEFORE DELETE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only');
END;
`;

function resolveDbPath(env = process.env) {
  if (env.DB_PATH) return env.DB_PATH;
  const dir = env.DATA_DIR || path.join(__dirname, '..', 'data');
  return path.join(dir, 'zeus.db');
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumn(db, table, column, definition) {
  if (!columnNames(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrate(db) {
  addColumn(db, 'users', 'password_hash', 'TEXT');
  addColumn(db, 'users', 'city', 'TEXT');
  addColumn(db, 'users', 'district', 'TEXT');
  addColumn(db, 'users', 'availability', 'TEXT');
  addColumn(db, 'posts', 'city', 'TEXT');
  addColumn(db, 'posts', 'district', 'TEXT');
  addColumn(db, 'posts', 'title', 'TEXT');
  addColumn(db, 'posts', 'expires_at', 'TEXT');
  addColumn(db, 'posts', 'meeting_place', 'TEXT');
  addColumn(db, 'posts', 'meeting_time', 'TEXT');
}

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

module.exports = { openDatabase, resolveDbPath, migrate };
