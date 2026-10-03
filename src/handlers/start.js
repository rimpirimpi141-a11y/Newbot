import { getDatabase } from '../database.js';
import { getMainUserKeyboard, getForceChannelKeyboard } from '../keyboards.js';
import { isAdmin } from '../utils/admin.js';
import { escapeHtml } from '../utils/helpers.js';

/**
 * Check if the user is a member of the required force channel
 */
export async function checkForceChannelMembership(ctx, userId) {
  const db = getDatabase();
  const forceChannel = db.getSetting('force_channel', '');
  if (!forceChannel || forceChannel.trim() === '') {
    return { required: false, isMember: true, channel: '' };
  }

  const channelId = forceChannel.trim();

  try {
    const member = await ctx.api.getChatMember(channelId, Number(userId));
    const validStatuses = ['creator', 'administrator', 'member', 'restricted'];
    const isMember = validStatuses.includes(member.status);
    return { required: true, isMember, channel: channelId };
  } catch (err) {
    console.error(`Force channel check failed for channel "${channelId}" user "${userId}":`, err.message);
    // If bot is not admin in channel or error occurs, don't hard-block users permanently if error is bot permission
    if (err.description && err.description.includes('chat not found')) {
      console.warn('Force channel not found or bot lacks access. Skipping check.');
      return { required: false, isMember: true, channel: channelId };
    }
    return { required: true, isMember: false, channel: channelId };
  }
}

/**
 * Ensure user exists in database and handle referral tracking
 */
export function getOrCreateUser(fromUser, referrerId = null) {
  const db = getDatabase();
  const strId = String(fromUser.id);
  const now = new Date().toISOString();

  let user = db.get('SELECT * FROM users WHERE telegram_id = ?', [strId]);

  if (!user) {
    let validReferrer = null;
    if (referrerId && String(referrerId) !== strId) {
      const refUser = db.get('SELECT * FROM users WHERE telegram_id = ?', [String(referrerId)]);
      if (refUser && !refUser.is_banned) {
        validReferrer = String(referrerId);
      }
    }

    db.runImmediate(
      `INSERT INTO users (
        telegram_id, username, first_name, last_name,
        balance_paise, total_earned_paise, total_withdrawn_paise,
        referral_earnings_paise, referrer_id, referral_rewarded,
        is_banned, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, 0, 0, ?, ?)`,
      [
        strId,
        fromUser.username || null,
        fromUser.first_name || null,
        fromUser.last_name || null,
        validReferrer,
        now,
        now,
      ]
    );

    if (validReferrer) {
      db.runImmediate(
        'INSERT OR IGNORE INTO referrals (referrer_id, referred_id, status, reward_paise, created_at) VALUES (?, ?, ?, 0, ?)',
        [validReferrer, strId, 'registered', now]
      );
    }

    user = db.get('SELECT * FROM users WHERE telegram_id = ?', [strId]);
  } else {
    // Update profile info if changed
    db.run(
      'UPDATE users SET username = ?, first_name = ?, last_name = ?, updated_at = ? WHERE telegram_id = ?',
      [fromUser.username || null, fromUser.first_name || null, fromUser.last_name || null, now, strId]
    );
  }

  return user;
}

/**
 * Register Start and Force Sub handlers
 */
export function setupStartHandlers(bot) {
  bot.command('start', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    let referrerId = null;
    const text = ctx.message?.text || '';
    const match = text.match(/^\/start ref_(\d+)/i);
    if (match) {
      referrerId = match[1];
    }

    const user = getOrCreateUser(from, referrerId);

    if (user.is_banned) {
      return ctx.reply('🚫 <b>Account Suspended</b>\n\nYour account has been restricted by an administrator.', {
        parse_mode: 'HTML',
      });
    }

    // Check force channel requirement
    const forceCheck = await checkForceChannelMembership(ctx, user.telegram_id);
    if (forceCheck.required && !forceCheck.isMember) {
      return ctx.reply(
        `👋 <b>Welcome to TaskWork Bot!</b>\n\n` +
        `⚠️ <b>Channel Subscription Required</b>\n\n` +
        `To access tasks, earn money, and withdraw payments, you must first join our official Telegram channel.\n\n` +
        `👇 Click the button below to join, then tap <b>Check Joined</b>:`,
        {
          parse_mode: 'HTML',
          reply_markup: getForceChannelKeyboard(forceCheck.channel),
        }
      );
    }

    const isUserAdmin = isAdmin(user.telegram_id);
    const welcomeMsg =
      `👋 <b>Welcome to TaskWork Bot, ${escapeHtml(from.first_name || 'User')}!</b> 🚀\n\n` +
      `Complete legitimate online tasks, submit proof, and earn real money directly to your UPI!\n\n` +
      `📌 <b>How it works:</b>\n` +
      `1️⃣ Choose a task from <b>🎯 Get Review Task</b>, <b>📧 Get Gmail Task</b>, or <b>📋 All Tasks</b>\n` +
      `2️⃣ Complete the instructions carefully\n` +
      `3️⃣ Submit a screenshot proof\n` +
      `4️⃣ Get paid once approved!\n` +
      `5️⃣ Withdraw your earnings via UPI in <b>💸 Withdraw</b>\n\n` +
      `💡 Invite friends using <b>👥 Invite & Earn</b> for bonus rewards on their first approved task!\n\n` +
      `👇 <i>Select an option from the menu below to get started:</i>`;

    return ctx.reply(welcomeMsg, {
      parse_mode: 'HTML',
      reply_markup: getMainUserKeyboard(isUserAdmin),
    });
  });

  // Callback to verify force channel subscription
  bot.callbackQuery('check_force_sub', async (ctx) => {
    const from = ctx.from;
    const forceCheck = await checkForceChannelMembership(ctx, from.id);

    if (forceCheck.required && !forceCheck.isMember) {
      return ctx.answerCallbackQuery({
        text: '❌ You have not joined the channel yet! Please join first.',
        show_alert: true,
      });
    }

    await ctx.answerCallbackQuery({ text: '✅ Channel membership verified! Welcome!' });
    
    try {
      await ctx.deleteMessage();
    } catch {}

    const isUserAdmin = isAdmin(from.id);
    return ctx.reply(
      `🎉 <b>Verification Successful!</b>\n\n` +
      `You now have full access to TaskWork tasks, earnings, and UPI withdrawals.\n\n` +
      `👇 Choose an option below to begin:`,
      {
        parse_mode: 'HTML',
        reply_markup: getMainUserKeyboard(isUserAdmin),
      }
    );
  });
}
