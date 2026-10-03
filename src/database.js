import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import config from './config.js';

let dbInstance = null;
let SQL = null;

export async function initDatabase(customPath = null) {
  if (dbInstance) return dbInstance;

  SQL = await initSqlJs();
  const dbFile = customPath || config.dbPath;
  const dbDir = path.dirname(path.resolve(dbFile));

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  let db;
  if (fs.existsSync(dbFile)) {
    const fileBuffer = fs.readFileSync(dbFile);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  dbInstance = wrapDatabase(db, dbFile);
  dbInstance.bootstrap();
  return dbInstance;
}

export function getDatabase() {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return dbInstance;
}

function wrapDatabase(rawDb, filePath) {
  let saveTimeout = null;

  function persist() {
    try {
      const data = rawDb.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(filePath, buffer);
    } catch (err) {
      console.error('Failed to persist SQLite database:', err);
    }
  }

  function scheduleSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(persist, 200);
  }

  function run(sql, params = []) {
    const stmt = rawDb.prepare(sql);
    try {
      stmt.bind(params);
      stmt.step();
    } finally {
      stmt.free();
    }
    scheduleSave();
  }

  function runImmediate(sql, params = []) {
    const stmt = rawDb.prepare(sql);
    try {
      stmt.bind(params);
      stmt.step();
    } finally {
      stmt.free();
    }
    persist();
  }

  function get(sql, params = []) {
    const stmt = rawDb.prepare(sql);
    try {
      stmt.bind(params);
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  function all(sql, params = []) {
    const stmt = rawDb.prepare(sql);
    const results = [];
    try {
      stmt.bind(params);
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      return results;
    } finally {
      stmt.free();
    }
  }

  function exec(sql) {
    rawDb.exec(sql);
    persist();
  }

  function bootstrap() {
    exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE NOT NULL,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        balance_paise INTEGER DEFAULT 0,
        total_earned_paise INTEGER DEFAULT 0,
        total_withdrawn_paise INTEGER DEFAULT 0,
        referral_earnings_paise INTEGER DEFAULT 0,
        referrer_id TEXT,
        referral_rewarded INTEGER DEFAULT 0,
        is_banned INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
      CREATE INDEX IF NOT EXISTS idx_users_referrer_id ON users(referrer_id);

      CREATE TABLE IF NOT EXISTS admins (
        telegram_id TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'admin', -- 'superadmin', 'admin'
        added_by TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL, -- 'review', 'gmail', 'custom'
        title TEXT NOT NULL,
        description TEXT,
        instructions TEXT,
        reward_paise INTEGER NOT NULL,
        link TEXT,
        max_completions INTEGER DEFAULT 100,
        current_completions INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active', -- 'active', 'paused', 'completed', 'deleted'
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);

      CREATE TABLE IF NOT EXISTS task_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'claimed', -- 'claimed', 'submitted', 'cancelled'
        created_at TEXT NOT NULL,
        UNIQUE(user_id, task_id)
      );

      CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        caption TEXT,
        status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
        rejection_reason TEXT,
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        reviewed_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
      CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id);
      CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions(task_id);

      CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        upi_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'paid', 'rejected'
        rejection_reason TEXT,
        created_at TEXT NOT NULL,
        processed_at TEXT,
        processed_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
      CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);

      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL, -- 'TASK_REWARD', 'REFERRAL_REWARD', 'WITHDRAWAL_HOLD', 'WITHDRAWAL_REFUND', 'ADMIN_ADJUSTMENT'
        amount_paise INTEGER NOT NULL,
        balance_after_paise INTEGER NOT NULL,
        reference_id TEXT,
        description TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);

      CREATE TABLE IF NOT EXISTS referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_id TEXT NOT NULL,
        referred_id TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'registered', -- 'registered', 'rewarded'
        reward_paise INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        rewarded_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_id TEXT,
        details TEXT,
        created_at TEXT NOT NULL
      );
    `);

    // Ensure super admin is initialized if configured
    if (config.adminTelegramId) {
      const existing = get('SELECT * FROM admins WHERE telegram_id = ?', [config.adminTelegramId]);
      if (!existing) {
        runImmediate(
          'INSERT INTO admins (telegram_id, role, added_by, created_at) VALUES (?, ?, ?, ?)',
          [config.adminTelegramId, 'superadmin', 'SYSTEM_CONFIG', new Date().toISOString()]
        );
      } else if (existing.role !== 'superadmin') {
        runImmediate(
          'UPDATE admins SET role = ? WHERE telegram_id = ?',
          ['superadmin', config.adminTelegramId]
        );
      }
    }

    // Default settings
    ensureSetting('min_withdrawal_paise', String(config.defaultMinimumWithdrawalPaise));
    ensureSetting('referral_reward_paise', String(config.defaultReferralRewardPaise));
    ensureSetting('force_channel', '');
  }

  function ensureSetting(key, defaultValue) {
    const existing = get('SELECT * FROM settings WHERE key = ?', [key]);
    if (!existing) {
      runImmediate(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
        [key, defaultValue, new Date().toISOString()]
      );
    }
  }

  function getSetting(key, defaultValue = null) {
    const row = get('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : defaultValue;
  }

  function setSetting(key, value) {
    const now = new Date().toISOString();
    const existing = get('SELECT value FROM settings WHERE key = ?', [key]);
    if (existing) {
      runImmediate('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?', [String(value), now, key]);
    } else {
      runImmediate('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [key, String(value), now]);
    }
  }

  return {
    rawDb,
    persist,
    run,
    runImmediate,
    get,
    all,
    exec,
    bootstrap,
    getSetting,
    setSetting,
  };
}
