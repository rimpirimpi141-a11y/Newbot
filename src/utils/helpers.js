import config from '../config.js';

/**
 * Format integer paise into ₹ Indian Rupee string (e.g., 1500 paise -> "₹15.00", 20 paise -> "₹0.20")
 */
export function formatPaise(paise) {
  const num = Number(paise) || 0;
  const rupees = (num / 100).toFixed(2);
  return `₹${rupees}`;
}

/**
 * Parse a rupee input (string or number like "15" or "15.50") into integer paise
 */
export function parseRupeesToPaise(rupees) {
  const clean = String(rupees).replace(/[^0-9.]/g, '').trim();
  const num = parseFloat(clean);
  if (isNaN(num) || num < 0) return 0;
  return Math.round(num * 100);
}

/**
 * Escape text for HTML mode in Telegram
 */
export function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Get privacy-safe formatted name for leaderboard or public listings
 */
export function formatSafeName(user) {
  if (!user) return 'Anonymous';
  if (user.first_name) {
    const fn = user.first_name.trim();
    if (user.username) {
      const maskedUser = user.username.length > 4 
        ? user.username.slice(0, 3) + '***'
        : user.username + '***';
      return `${escapeHtml(fn)} (@${escapeHtml(maskedUser)})`;
    }
    return escapeHtml(fn);
  }
  if (user.username) {
    const maskedUser = user.username.length > 4 
      ? user.username.slice(0, 3) + '***'
      : user.username + '***';
    return `@${escapeHtml(maskedUser)}`;
  }
  const idStr = String(user.telegram_id || '');
  const maskedId = idStr.length > 4 ? idStr.slice(0, 3) + '***' : idStr;
  return `User ${maskedId}`;
}

/**
 * Generate referral deep link
 */
export function getReferralLink(botUsername, telegramId) {
  const safeBot = botUsername || 'TaskWorkBot';
  return `https://t.me/${safeBot}?start=ref_${telegramId}`;
}

/**
 * Format timestamp into readable date & time
 */
export function formatDateTime(isoString) {
  if (!isoString) return 'N/A';
  try {
    const d = new Date(isoString);
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return isoString;
  }
}
