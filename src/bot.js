import { Bot, InlineKeyboard } from 'grammy';
import config from './config.js';
import { initDatabase, getDatabase } from './database.js';
import { setupStartHandlers } from './handlers/start.js';
import { setupUserHandlers } from './handlers/user.js';
import { setupTasksHandlers } from './handlers/tasks.js';
import { setupSubmissionsHandlers, userStates, handleProofUpload } from './handlers/submissions.js';
import { setupWithdrawalsHandlers, handleWithdrawAmount, handleWithdrawUpi } from './handlers/withdrawals.js';
import {
  setupAdminHandlers,
  finalizeRejectSubmission,
  finalizeRejectWithdrawal,
  executeBroadcast,
} from './handlers/admin.js';
import { formatPaise, parseRupeesToPaise, escapeHtml, formatDateTime } from './utils/helpers.js';
import { isSuperAdmin, isAdmin, logAdminAction } from './utils/admin.js';

let botInstance = null;
let isPolling = false;

export async function createBot() {
  await initDatabase();

  const token = config.botToken || 'DUMMY_TOKEN_FOR_INITIALIZATION';
  const bot = new Bot(token);
  botInstance = bot;

  // 1. Global Error Handler
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`[Telegram Error] while handling update ${ctx?.update?.update_id}:`, err.error);
    if (err.error?.error_code === 409) {
      console.error('⚠️ Telegram 409 Conflict: Another bot instance is running with the same BOT_TOKEN.');
    }
  });

  // 2. Setup handlers
  setupStartHandlers(bot);
  setupUserHandlers(bot);
  setupTasksHandlers(bot);
  setupSubmissionsHandlers(bot);
  setupWithdrawalsHandlers(bot);
  setupAdminHandlers(bot);

  // 3. /cancel command to abort any active multi-step action
  bot.command('cancel', async (ctx) => {
    const fromId = String(ctx.from?.id);
    if (userStates.has(fromId)) {
      userStates.delete(fromId);
      return ctx.reply('🚫 Operation cancelled.');
    }
    return ctx.reply('ℹ️ No active operation to cancel.');
  });

  // 4. Handle incoming photos (proof screenshots)
  bot.on(['message:photo', 'message:document'], async (ctx) => {
    const fromId = String(ctx.from?.id);
    const state = userStates.get(fromId);
    if (state && state.action === 'AWAITING_PROOF_PHOTO') {
      return handleProofUpload(ctx, state);
    }
  });

  // 5. Handle generic text messages when user/admin is in an active state
  bot.on('message:text', async (ctx, next) => {
    const fromId = String(ctx.from?.id);
    const text = ctx.message.text.trim();

    // Check if user is in an active state
    const state = userStates.get(fromId);
    if (!state) {
      return next();
    }

    // User State: Proof upload prompt but sent text
    if (state.action === 'AWAITING_PROOF_PHOTO') {
      return ctx.reply('📸 Please send a <b>screenshot or photo</b> as proof of task completion. (Or send /cancel to abort)', {
        parse_mode: 'HTML',
      });
    }

    // User State: Withdrawal amount
    if (state.action === 'WITHDRAW_AWAITING_AMOUNT') {
      const paise = parseRupeesToPaise(text);
      if (!paise || paise <= 0) {
        return ctx.reply('⚠️ Please enter a valid numerical amount in ₹ (e.g. <code>15</code> or <code>20.50</code>), or send /cancel:', {
          parse_mode: 'HTML',
        });
      }
      return handleWithdrawAmount(ctx, paise);
    }

    // User State: Withdrawal UPI ID
    if (state.action === 'WITHDRAW_AWAITING_UPI') {
      return handleWithdrawUpi(ctx, text);
    }

    // Admin State: Reject proof reason
    if (state.action === 'ADMIN_REJECT_PROOF_REASON') {
      return finalizeRejectSubmission(ctx, text);
    }

    // Admin State: Reject withdrawal reason
    if (state.action === 'ADMIN_REJECT_WD_REASON') {
      return finalizeRejectWithdrawal(ctx, text);
    }

    // Admin State: Add Task Steps
    if (state.action === 'ADMIN_ADD_TASK_STEP_TITLE') {
      state.title = text;
      state.action = 'ADMIN_ADD_TASK_STEP_DESC';
      userStates.set(fromId, state);
      return ctx.reply('Step 3: Please send a short <b>Description</b> for this task (or type "none"):', {
        parse_mode: 'HTML',
      });
    }

    if (state.action === 'ADMIN_ADD_TASK_STEP_DESC') {
      state.description = text.toLowerCase() === 'none' ? '' : text;
      state.action = 'ADMIN_ADD_TASK_STEP_INST';
      userStates.set(fromId, state);
      return ctx.reply('Step 4: Please send step-by-step <b>Instructions</b> for the user to follow:', {
        parse_mode: 'HTML',
      });
    }

    if (state.action === 'ADMIN_ADD_TASK_STEP_INST') {
      state.instructions = text;
      state.action = 'ADMIN_ADD_TASK_STEP_REWARD';
      userStates.set(fromId, state);
      return ctx.reply('Step 5: Please enter the <b>Reward amount in ₹</b> (e.g. <code>2.50</code>, <code>5</code>, <code>10</code>):', {
        parse_mode: 'HTML',
      });
    }

    if (state.action === 'ADMIN_ADD_TASK_STEP_REWARD') {
      const rewardPaise = parseRupeesToPaise(text);
      if (rewardPaise <= 0) {
        return ctx.reply('⚠️ Please enter a valid reward amount (e.g. <code>5</code> or <code>2.50</code>):', {
          parse_mode: 'HTML',
        });
      }
      state.rewardPaise = rewardPaise;
      state.action = 'ADMIN_ADD_TASK_STEP_LINK';
      userStates.set(fromId, state);
      return ctx.reply('Step 6: Send the target <b>Link / URL</b> for this task (or type "none"):', {
        parse_mode: 'HTML',
      });
    }

    if (state.action === 'ADMIN_ADD_TASK_STEP_LINK') {
      state.link = text.toLowerCase() === 'none' ? null : text;
      state.action = 'ADMIN_ADD_TASK_STEP_MAX';
      userStates.set(fromId, state);
      return ctx.reply('Step 7: Enter <b>Maximum completions limit</b> (e.g. <code>100</code>):', {
        parse_mode: 'HTML',
      });
    }

    if (state.action === 'ADMIN_ADD_TASK_STEP_MAX') {
      const maxComp = parseInt(text, 10) || 100;
      userStates.delete(fromId);

      const db = getDatabase();
      const taskId = `task_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const now = new Date().toISOString();

      db.runImmediate(
        `INSERT INTO tasks (
          task_id, type, title, description, instructions,
          reward_paise, link, max_completions, current_completions,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?)`,
        [
          taskId,
          state.taskType,
          state.title,
          state.description,
          state.instructions,
          state.rewardPaise,
          state.link,
          maxComp,
          now,
        ]
      );

      logAdminAction(fromId, 'CREATE_TASK', taskId, `Title: ${state.title}, Reward: ${state.rewardPaise}`);

      return ctx.reply(
        `🎉 <b>Task Created Successfully!</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🆔 <b>ID:</b> <code>${taskId}</code>\n` +
        `🏷️ <b>Title:</b> ${escapeHtml(state.title)}\n` +
        `📁 <b>Category:</b> ${state.taskType}\n` +
        `💰 <b>Reward:</b> <code>${formatPaise(state.rewardPaise)}</code>\n` +
        `👥 <b>Max Completions:</b> ${maxComp}\n` +
        `🚦 <b>Status:</b> 🟢 Active\n\n` +
        `Users can now view and claim this task!`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('📋 Manage Tasks', 'admin_manage_tasks').text('🔙 Admin Panel', 'admin_home'),
        }
      );
    }

    // Admin State: Set Force Channel
    if (state.action === 'ADMIN_SET_FORCE_CHANNEL') {
      userStates.delete(fromId);
      const db = getDatabase();
      db.setSetting('force_channel', text);
      logAdminAction(fromId, 'SET_FORCE_CHANNEL', null, text);
      return ctx.reply(`✅ <b>Force channel updated to:</b> <code>${escapeHtml(text)}</code>`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔙 Admin Panel', 'admin_home'),
      });
    }

    // Admin State: Set Referral Reward
    if (state.action === 'ADMIN_SET_REF_REWARD') {
      const paise = parseRupeesToPaise(text);
      if (paise <= 0) {
        return ctx.reply('⚠️ Invalid amount. Please enter a valid number (e.g. 0.20 or 1.00):');
      }
      userStates.delete(fromId);
      const db = getDatabase();
      db.setSetting('referral_reward_paise', String(paise));
      logAdminAction(fromId, 'SET_REF_REWARD', null, String(paise));
      return ctx.reply(`✅ <b>Referral reward updated to:</b> <code>${formatPaise(paise)}</code>`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔙 Admin Panel', 'admin_home'),
      });
    }

    // Admin State: Set Min Withdrawal
    if (state.action === 'ADMIN_SET_MIN_WITHDRAW') {
      const paise = parseRupeesToPaise(text);
      if (paise <= 0) {
        return ctx.reply('⚠️ Invalid amount. Please enter a valid number (e.g. 15 or 25):');
      }
      userStates.delete(fromId);
      const db = getDatabase();
      db.setSetting('min_withdrawal_paise', String(paise));
      logAdminAction(fromId, 'SET_MIN_WITHDRAW', null, String(paise));
      return ctx.reply(`✅ <b>Minimum withdrawal updated to:</b> <code>${formatPaise(paise)}</code>`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔙 Admin Panel', 'admin_home'),
      });
    }

    // Admin State: Add Admin ID
    if (state.action === 'ADMIN_ADD_ADMIN_ID') {
      const targetId = text.replace(/[^0-9]/g, '');
      if (!targetId) return ctx.reply('⚠️ Invalid Telegram ID.');
      userStates.delete(fromId);

      const db = getDatabase();
      db.runImmediate(
        'INSERT OR REPLACE INTO admins (telegram_id, role, added_by, created_at) VALUES (?, ?, ?, ?)',
        [targetId, 'admin', fromId, new Date().toISOString()]
      );
      logAdminAction(fromId, 'ADD_ADMIN', targetId);

      return ctx.reply(`✅ <b>Admin <code>${targetId}</code> added successfully!</b>`, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('👑 Admin Roster', 'admin_roster').text('🔙 Admin Panel', 'admin_home'),
      });
    }

    // Admin State: Broadcast
    if (state.action === 'ADMIN_BROADCAST_MSG') {
      userStates.delete(fromId);
      return executeBroadcast(ctx, text);
    }

    // Admin State: Search User
    if (state.action === 'ADMIN_SEARCH_USER') {
      userStates.delete(fromId);
      const db = getDatabase();
      const cleanSearch = text.replace(/^@/, '').trim();
      const targetUser = db.get(
        'SELECT * FROM users WHERE telegram_id = ? OR username = ?',
        [cleanSearch, cleanSearch]
      );

      if (!targetUser) {
        return ctx.reply(`❌ No user found matching "${escapeHtml(text)}".`, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('🔍 Search Again', 'admin_users').text('🔙 Admin Panel', 'admin_home'),
        });
      }

      const completed = db.get("SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND status = 'approved'", [targetUser.telegram_id])?.c || 0;
      const pending = db.get("SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND status = 'pending'", [targetUser.telegram_id])?.c || 0;

      const userDetailMsg =
        `👤 <b>User Profile:</b> ${escapeHtml(targetUser.first_name || 'User')}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🆔 <b>Telegram ID:</b> <code>${targetUser.telegram_id}</code>\n` +
        `🔗 <b>Username:</b> @${escapeHtml(targetUser.username || 'none')}\n` +
        `💵 <b>Balance:</b> <code>${formatPaise(targetUser.balance_paise)}</code>\n` +
        `📈 <b>Total Earned:</b> <code>${formatPaise(targetUser.total_earned_paise)}</code>\n` +
        `💸 <b>Total Withdrawn:</b> <code>${formatPaise(targetUser.total_withdrawn_paise)}</code>\n` +
        `🤝 <b>Referrals:</b> <code>${formatPaise(targetUser.referral_earnings_paise)}</code>\n` +
        `✅ <b>Completed:</b> ${completed} | ⏳ <b>Pending:</b> ${pending}\n` +
        `🚦 <b>Status:</b> ${targetUser.is_banned ? '🔴 Banned' : '🟢 Active'}\n` +
        `📅 <b>Joined:</b> ${formatDateTime(targetUser.created_at)}`;

      const keyboard = new InlineKeyboard();
      if (targetUser.is_banned) {
        keyboard.text('🟢 Unban User', `adm_unban_${targetUser.telegram_id}`);
      } else {
        keyboard.text('🚫 Ban User', `adm_ban_${targetUser.telegram_id}`);
      }
      keyboard.row().text('🔍 Search Another', 'admin_users').text('🔙 Admin Panel', 'admin_home');

      return ctx.reply(userDetailMsg, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    }

    return next();
  });

  // Ban/Unban callback routes
  bot.callbackQuery(/^adm_ban_(\d+)$/, async (ctx) => {
    const fromId = String(ctx.from.id);
    if (!isAdmin(fromId)) return;
    const targetId = ctx.match[1];
    const db = getDatabase();
    db.runImmediate('UPDATE users SET is_banned = 1 WHERE telegram_id = ?', [targetId]);
    logAdminAction(fromId, 'BAN_USER', targetId);
    await ctx.answerCallbackQuery({ text: 'User Banned' });
    return ctx.reply(`🚫 <b>User <code>${targetId}</code> has been banned.</b>`, { parse_mode: 'HTML' });
  });

  bot.callbackQuery(/^adm_unban_(\d+)$/, async (ctx) => {
    const fromId = String(ctx.from.id);
    if (!isAdmin(fromId)) return;
    const targetId = ctx.match[1];
    const db = getDatabase();
    db.runImmediate('UPDATE users SET is_banned = 0 WHERE telegram_id = ?', [targetId]);
    logAdminAction(fromId, 'UNBAN_USER', targetId);
    await ctx.answerCallbackQuery({ text: 'User Unbanned' });
    return ctx.reply(`🟢 <b>User <code>${targetId}</code> has been unbanned.</b>`, { parse_mode: 'HTML' });
  });

  return bot;
}

/**
 * Register commands with Telegram API
 */
export async function registerBotCommands(bot) {
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Start TaskWork Bot and open Main Menu' },
      { command: 'tasks', description: 'Browse and claim available earning tasks' },
      { command: 'balance', description: 'Check wallet balance and earnings' },
      { command: 'withdraw', description: 'Request UPI cashout' },
      { command: 'stats', description: 'View your performance statistics' },
      { command: 'leaderboard', description: 'View top earners' },
      { command: 'help', description: 'Get support and FAQ' },
      { command: 'cancel', description: 'Cancel current ongoing operation' },
      { command: 'admin', description: 'Open Administrator Control Center' },
    ]);
    console.log('✅ Telegram bot commands registered successfully.');
  } catch (err) {
    console.warn('Could not register bot commands with Telegram API:', err.message);
  }
}

/**
 * Start production long polling runner with auto-retry and resilience
 */
export async function startBotPolling() {
  if (isPolling) {
    console.log('Bot is already running long polling.');
    return;
  }

  if (!config.botToken || config.botToken.startsWith('123456789:ABCdef') || config.botToken.trim() === '') {
    console.warn('⚠️ BOT_TOKEN is not configured or using placeholder. Polling will wait for a valid token in environment variables.');
    return;
  }

  let retryDelay = 2000;
  const maxDelay = 30000;

  async function pollLoop() {
    try {
      const bot = await createBot();
      await registerBotCommands(bot);

      console.log('🚀 Starting TaskWork grammY Long Polling process...');
      isPolling = true;
      retryDelay = 2000; // reset retry delay on success

      await bot.start({
        onStart: (info) => {
          console.log(`🤖 Telegram Bot @${info.username} (ID: ${info.id}) started successfully with long polling!`);
        },
        drop_pending_updates: true,
      });
    } catch (err) {
      isPolling = false;
      console.error(`[Polling Error] ${err.message || err}. Reconnecting in ${retryDelay / 1000}s...`);
      
      // Handle 409 Conflict specifically
      if (err.error_code === 409 || (err.message && err.message.includes('409'))) {
        console.error('⚠️ Telegram 409 Conflict: Make sure only ONE bot instance is running for this BOT_TOKEN.');
      }

      setTimeout(pollLoop, retryDelay);
      retryDelay = Math.min(retryDelay * 1.5, maxDelay);
    }
  }

  pollLoop();
}

export async function stopBotPolling() {
  if (botInstance && isPolling) {
    try {
      await botInstance.stop();
      isPolling = false;
      console.log('Bot long polling stopped gracefully.');
    } catch (err) {
      console.error('Error stopping bot polling:', err.message);
    }
  }
}
