import config from '../config.js';
import { getDatabase } from '../database.js';
import { formatPaise, formatSafeName, getReferralLink, escapeHtml, formatDateTime } from '../utils/helpers.js';
import { getMainUserKeyboard, getMinimizedMenuKeyboard, getSupportKeyboard } from '../keyboards.js';
import { isAdmin } from '../utils/admin.js';
import { getOrCreateUser } from './start.js';

/**
 * Handle Wallet / Balance view
 */
export async function showWallet(ctx) {
  const user = getOrCreateUser(ctx.from);
  if (user.is_banned) {
    return ctx.reply('🚫 Your account is suspended.');
  }

  const db = getDatabase();

  const completedStats = db.get(
    "SELECT COUNT(*) as count FROM submissions WHERE user_id = ? AND status = 'approved'",
    [user.telegram_id]
  );
  const completedCount = completedStats ? completedStats.count : 0;

  const pendingStats = db.get(
    "SELECT COUNT(*) as count FROM submissions WHERE user_id = ? AND status = 'pending'",
    [user.telegram_id]
  );
  const pendingCount = pendingStats ? pendingStats.count : 0;

  const txs = db.all(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 5',
    [user.telegram_id]
  );

  let txText = '';
  if (txs.length === 0) {
    txText = '<i>No recent transactions. Complete tasks or refer friends to earn!</i>';
  } else {
    txText = txs
      .map((t) => {
        const sign = t.amount_paise > 0 ? '+' : '';
        const icon = t.amount_paise > 0 ? '🟢' : '🔴';
        const typeLabel = t.type.replace(/_/g, ' ');
        return `${icon} <b>${formatPaise(t.amount_paise)}</b> • ${typeLabel}\n   <small>📅 ${formatDateTime(t.created_at)}</small>`;
      })
      .join('\n\n');
  }

  const walletMsg =
    `🟡 <b>TaskWork Wallet & Balance</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💵 <b>Available Balance:</b> <code>${formatPaise(user.balance_paise)}</code>\n` +
    `📈 <b>Total Earned:</b> <code>${formatPaise(user.total_earned_paise)}</code>\n` +
    `💸 <b>Total Withdrawn:</b> <code>${formatPaise(user.total_withdrawn_paise)}</code>\n` +
    `🤝 <b>Referral Earnings:</b> <code>${formatPaise(user.referral_earnings_paise)}</code>\n\n` +
    `📋 <b>Completed Tasks:</b> <code>${completedCount}</code>\n` +
    `⏳ <b>Pending Proofs:</b> <code>${pendingCount}</code>\n\n` +
    `📜 <b>Recent Transactions:</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    txText +
    `\n━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 <i>To request a payout to your UPI, tap <b>💳 Withdraw</b>.</i>`;

  return ctx.reply(walletMsg, {
    parse_mode: 'HTML',
    reply_markup: getMainUserKeyboard(isAdmin(user.telegram_id)),
  });
}

/**
 * Handle My Stats view
 */
export async function showMyStats(ctx) {
  const user = getOrCreateUser(ctx.from);
  if (user.is_banned) {
    return ctx.reply('🚫 Your account is suspended.');
  }

  const db = getDatabase();

  const completed = db.get(
    "SELECT COUNT(*) as count, COALESCE(SUM(t.reward_paise), 0) as total FROM submissions s JOIN tasks t ON s.task_id = t.task_id WHERE s.user_id = ? AND s.status = 'approved'",
    [user.telegram_id]
  );

  const pending = db.get(
    "SELECT COUNT(*) as count FROM submissions WHERE user_id = ? AND status = 'pending'",
    [user.telegram_id]
  );

  const rejected = db.get(
    "SELECT COUNT(*) as count FROM submissions WHERE user_id = ? AND status = 'rejected'",
    [user.telegram_id]
  );

  const refs = db.get(
    'SELECT COUNT(*) as total_invites, SUM(CASE WHEN status = "rewarded" THEN 1 ELSE 0 END) as rewarded_invites FROM referrals WHERE referrer_id = ?',
    [user.telegram_id]
  );

  const rankRow = db.get(
    'SELECT COUNT(*) + 1 as rank FROM users WHERE total_earned_paise > ? AND is_banned = 0',
    [user.total_earned_paise]
  );

  const statsMsg =
    `🟣 <b>Your TaskWork Performance Profile</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 <b>User:</b> ${escapeHtml(user.first_name || 'User')} (ID: <code>${user.telegram_id}</code>)\n` +
    `🏆 <b>Global Rank:</b> #${rankRow ? rankRow.rank : 'N/A'}\n\n` +
    `💰 <b>Current Balance:</b> <code>${formatPaise(user.balance_paise)}</code>\n` +
    `📈 <b>Lifetime Earnings:</b> <code>${formatPaise(user.total_earned_paise)}</code>\n` +
    `💸 <b>Total Payouts:</b> <code>${formatPaise(user.total_withdrawn_paise)}</code>\n\n` +
    `✅ <b>Approved Tasks:</b> <code>${completed ? completed.count : 0}</code>\n` +
    `⏳ <b>Pending Proofs:</b> <code>${pending ? pending.count : 0}</code>\n` +
    `❌ <b>Rejected Proofs:</b> <code>${rejected ? rejected.count : 0}</code>\n\n` +
    `👥 <b>Total Invited:</b> <code>${refs ? refs.total_invites : 0}</code> friends\n` +
    `🎁 <b>Active Referred:</b> <code>${refs ? refs.rewarded_invites || 0 : 0}</code> verified\n` +
    `🤝 <b>Referral Rewards:</b> <code>${formatPaise(user.referral_earnings_paise)}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 <i>Member since ${formatDateTime(user.created_at)}</i>`;

  return ctx.reply(statsMsg, {
    parse_mode: 'HTML',
    reply_markup: getMainUserKeyboard(isAdmin(user.telegram_id)),
  });
}

/**
 * Handle Leaderboard view
 */
export async function showLeaderboard(ctx) {
  const db = getDatabase();

  const topEarners = db.all(
    `SELECT telegram_id, username, first_name, total_earned_paise, balance_paise 
     FROM users 
     WHERE is_banned = 0 
     ORDER BY total_earned_paise DESC 
     LIMIT 10`
  );

  let listText = '';
  if (topEarners.length === 0) {
    listText = '<i>No users on the leaderboard yet. Be the first!</i>';
  } else {
    listText = topEarners
      .map((u, idx) => {
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `<b>#${idx + 1}</b>`;
        const name = formatSafeName(u);
        return `${medal} ${name} — <b>${formatPaise(u.total_earned_paise)}</b>`;
      })
      .join('\n');
  }

  const msg =
    `🏆 <b>Top TaskWork Earners Leaderboard</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    listText +
    `\n\n━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 <i>Complete more tasks and invite friends to climb up the rankings!</i>`;

  return ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: getMainUserKeyboard(isAdmin(ctx.from?.id)),
  });
}

/**
 * Handle Refer & Earn view
 */
export async function showInviteAndEarn(ctx) {
  const user = getOrCreateUser(ctx.from);
  if (user.is_banned) {
    return ctx.reply('🚫 Your account is suspended.');
  }

  const db = getDatabase();
  const refRewardPaise = parseInt(db.getSetting('referral_reward_paise', String(config.defaultReferralRewardPaise)), 10);
  const botInfo = await ctx.api.getMe();
  const inviteLink = getReferralLink(botInfo.username, user.telegram_id);

  const refs = db.get(
    'SELECT COUNT(*) as total_invites, SUM(CASE WHEN status = "rewarded" THEN 1 ELSE 0 END) as rewarded_invites FROM referrals WHERE referrer_id = ?',
    [user.telegram_id]
  );

  const inviteMsg =
    `🔵 <b>Refer & Earn Program</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Earn <b>${formatPaise(refRewardPaise)}</b> for every friend you invite once they complete their <b>first approved task</b>!\n\n` +
    `🔗 <b>Your Exclusive Invite Link:</b>\n` +
    `<code>${inviteLink}</code>\n\n` +
    `📊 <b>Your Referral Performance:</b>\n` +
    `• Total Friends Joined: <b>${refs ? refs.total_invites : 0}</b>\n` +
    `• Friends with Approved Tasks: <b>${refs ? refs.rewarded_invites || 0 : 0}</b>\n` +
    `• Total Referral Earnings: <b>${formatPaise(user.referral_earnings_paise)}</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📌 <i>Tap and hold your link above to copy and share on WhatsApp, Telegram, and Social Media!</i>`;

  return ctx.reply(inviteMsg, {
    parse_mode: 'HTML',
    reply_markup: getMainUserKeyboard(isAdmin(user.telegram_id)),
  });
}

/**
 * Handle Support view
 */
export async function showSupport(ctx) {
  const supportName = config.supportUsername || 'TaskWorkSupport';
  const helpMsg =
    `⚙️ <b>TaskWork Support & Helpdesk</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Need help, have a question regarding tasks, or facing any payment issue?\n\n` +
    `📩 <b>Official Support:</b> @${supportName}\n` +
    `⏱️ <b>Response Time:</b> Within 12-24 hours\n\n` +
    `📌 <b>Important Tips:</b>\n` +
    `• Always follow task instructions accurately\n` +
    `• Submit clear, uncropped proof screenshots\n` +
    `• Double-check your UPI ID before requesting withdrawal\n\n` +
    `👇 <i>Tap the button below to message our support team directly:</i>`;

  return ctx.reply(helpMsg, {
    parse_mode: 'HTML',
    reply_markup: getSupportKeyboard(),
  });
}

/**
 * Collapse/Hide Menu
 */
export async function hideMenu(ctx) {
  return ctx.reply(
    `🔻 <b>Menu Minimized</b>\n\nTap <b>🔼 Show Menu</b> below or send <code>/menu</code> anytime to restore your full dashboard.`,
    {
      parse_mode: 'HTML',
      reply_markup: getMinimizedMenuKeyboard(),
    }
  );
}

/**
 * Expand/Show Full Menu
 */
export async function showMenu(ctx) {
  const isUserAdmin = isAdmin(ctx.from?.id);
  return ctx.reply(
    `🔼 <b>Main Action Menu Restored</b>\n\nSelect an option below:`,
    {
      parse_mode: 'HTML',
      reply_markup: getMainUserKeyboard(isUserAdmin),
    }
  );
}

/**
 * Setup user commands and menu handlers
 */
export function setupUserHandlers(bot) {
  bot.hears(['💰 Wallet / Balance', '💰 Wallet'], showWallet);
  bot.command('balance', showWallet);

  bot.hears('📊 My Stats', showMyStats);
  bot.command('stats', showMyStats);

  bot.hears('🏆 Leaderboard', showLeaderboard);
  bot.command('leaderboard', showLeaderboard);

  bot.hears(['👥 Refer & Earn', '👥 Invite & Earn'], showInviteAndEarn);

  bot.hears(['🆘 Support', '💝 Support'], showSupport);
  bot.command('help', showSupport);

  // Toggle Controls
  bot.hears('🔽 Hide Menu', hideMenu);
  bot.command('hidemenu', hideMenu);

  bot.hears('🔼 Show Menu', showMenu);
  bot.command('menu', showMenu);

  bot.callbackQuery('refresh_stats', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Refreshed!' });
    return showMyStats(ctx);
  });
}
