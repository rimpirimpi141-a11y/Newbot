import config from '../config.js';
import { getDatabase } from '../database.js';

/**
 * Check if a telegram ID is the permanent Super Admin
 */
export function isSuperAdmin(telegramId) {
  if (!telegramId) return false;
  const strId = String(telegramId).trim();
  if (config.adminTelegramId && strId === config.adminTelegramId) {
    return true;
  }
  const db = getDatabase();
  const admin = db.get('SELECT role FROM admins WHERE telegram_id = ?', [strId]);
  return admin && admin.role === 'superadmin';
}

/**
 * Check if a telegram ID is an admin (Super Admin or Normal Admin)
 */
export function isAdmin(telegramId) {
  if (!telegramId) return false;
  const strId = String(telegramId).trim();
  if (isSuperAdmin(strId)) return true;

  const db = getDatabase();
  const admin = db.get('SELECT role FROM admins WHERE telegram_id = ?', [strId]);
  return Boolean(admin);
}

/**
 * Log an administrative action to admin_logs table
 */
export function logAdminAction(adminId, action, targetId = null, details = null) {
  try {
    const db = getDatabase();
    db.run(
      'INSERT INTO admin_logs (admin_id, action, target_id, details, created_at) VALUES (?, ?, ?, ?, ?)',
      [String(adminId), String(action), targetId ? String(targetId) : null, details ? String(details) : null, new Date().toISOString()]
    );
  } catch (err) {
    console.error('Failed to log admin action:', err);
  }
}
