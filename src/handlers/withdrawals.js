import { InlineKeyboard } from 'grammy';
import { getDatabase } from '../database.js';
import { formatPaise, parseRupeesToPaise, escapeHtml, formatDateTime } from '../utils/helpers.js';
import { getWithdrawalActionKeyboard } from '../keyboards.js';
import { getOrCreateUser, checkForceChannelMembership } from './start.js';
import { userStates } from './submissions.js';

/**
 * Start withdrawal flow
 */
export async function startWithdrawal(ctx) {
  const user = getOrCreateUser(ctx.from);
  const db = getDatabase();

  if (user.is_banned) {
    return ctx.reply('🚫 Your account is suspended.');
  }

  const forceCheck = await checkForceChannelMembership(ctx, user.telegram_id);
  if (forceCheck.required && !forceCheck.isMember) {
    return ctx.reply('⚠️ You must join our official channel before requesting a withdrawal.');
  }

  const minWithdrawalPaise = parseInt(
    db.getSetting('min_withdrawal_paise', '1500'),
    10
  );

  // Check existing pending withdrawal
  const existingPending = db.get(
    "SELECT * FROM withdrawals WHERE user_id = ? AND status = 'pending'",
    [user.telegram_id]
  );
  if (existingPending) {
    return ctx.reply(
      `⏳ <b>Pending Withdrawal In Progress</b>\n\n` +
      `You already have a pending withdrawal request of <b>${formatPaise(existingPending.amount_paise)}</b> to UPI: <code>${escapeHtml(existingPending.upi_id)}</code>.\n\n` +
      `Please wait for our admins to process your previous request before initiating a new one.`,
      { parse_mode: 'HTML' }
    );
  }

  if (user.balance_paise < minWithdrawalPaise) {
    return ctx.reply(
      `💸 <b>Withdrawal Request</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `💵 <b>Available Balance:</b> <code>${formatPaise(user.balance_paise)}</code>\n` +
      `🔒 <b>Minimum Withdrawal:</b> <code>${formatPaise(minWithdrawalPaise)}</code>\n\n` +
      `❌ You need at least <b>${formatPaise(minWithdrawalPaise)}</b> to request a payout.\n` +
      `Complete more tasks from <b>📋 All Tasks</b> or invite friends via <b>👥 Invite & Earn</b>!`,
      { parse_mode: 'HTML' }
    );
  }

  // Set state: Awaiting amount
  userStates.set(String(user.telegram_id), {
    action: 'WITHDRAW_AWAITING_AMOUNT',
    minWithdrawalPaise,
    availableBalancePaise: user.balance_paise,
    timestamp: Date.now(),
  });

  const keyboard = new InlineKeyboard()
    .text(`⚡ Withdraw All (${formatPaise(user.balance_paise)})`, `wd_amount_max`)
    .text(`Minimum (${formatPaise(minWithdrawalPaise)})`, `wd_amount_min`).row()
    .text('❌ Cancel', 'wd_cancel');

  const promptMsg =
    `💸 <b>UPI Withdrawal Request</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💵 <b>Available Balance:</b> <code>${formatPaise(user.balance_paise)}</code>\n` +
    `🔒 <b>Minimum Amount:</b> <code>${formatPaise(minWithdrawalPaise)}</code>\n\n` +
    `💬 <b>Please reply with the amount in ₹ you wish to withdraw</b> (e.g. <code>${(minWithdrawalPaise / 100).toFixed(0)}</code> or <code>${(user.balance_paise / 100).toFixed(2)}</code>):\n\n` +
    `<i>Or tap one of the quick buttons below:</i>`;

  return ctx.reply(promptMsg, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

/**
 * Handle amount input from message or callback
 */
export async function handleWithdrawAmount(ctx, amountPaise) {
  const user = getOrCreateUser(ctx.from);
  const db = getDatabase();
  const minWithdrawalPaise = parseInt(
    db.getSetting('min_withdrawal_paise', '1500'),
    10
  );

  if (amountPaise < minWithdrawalPaise) {
    return ctx.reply(
      `❌ Amount is below the minimum threshold of <b>${formatPaise(minWithdrawalPaise)}</b>. Please enter a valid amount (or send /cancel):`,
      { parse_mode: 'HTML' }
    );
  }

  if (amountPaise > user.balance_paise) {
    return ctx.reply(
      `❌ Insufficient balance! Your available balance is <b>${formatPaise(user.balance_paise)}</b>. Please enter a lower amount (or send /cancel):`,
      { parse_mode: 'HTML' }
    );
  }

  // Next step: Ask for UPI ID
  userStates.set(String(user.telegram_id), {
    action: 'WITHDRAW_AWAITING_UPI',
    amountPaise,
    timestamp: Date.now(),
  });

  const promptUpi =
    `💳 <b>Enter your UPI ID / VPA</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💵 <b>Withdrawal Amount:</b> <code>${formatPaise(amountPaise)}</code>\n\n` +
    `Please type your correct UPI ID (e.g., <code>username@okhdfcbank</code>, <code>9876543210@paytm</code>, <code>name@ybl</code>):\n\n` +
    `⚠️ <i>Ensure the UPI ID is accurate. Payouts sent to wrong IDs cannot be reversed.</i>`;

  return ctx.reply(promptUpi, { parse_mode: 'HTML' });
}

/**
 * Handle UPI ID input and display confirmation
 */
export async function handleWithdrawUpi(ctx, upiIdText) {
  const user = getOrCreateUser(ctx.from);
  const state = userStates.get(String(user.telegram_id));
  if (!state || state.action !== 'WITHDRAW_AWAITING_UPI') return;

  const cleanUpi = upiIdText.trim();
  if (!cleanUpi.includes('@') || cleanUpi.length < 5) {
    return ctx.reply(
      '⚠️ Invalid UPI ID format! A valid UPI ID usually contains an "@" symbol (e.g. <code>user@upi</code>). Please re-enter or send /cancel:',
      { parse_mode: 'HTML' }
    );
  }

  state.upiId = cleanUpi;
  state.action = 'WITHDRAW_CONFIRMATION';
  userStates.set(String(user.telegram_id), state);

  const confirmKeyboard = new InlineKeyboard()
    .text('✅ Confirm & Submit Withdrawal', 'wd_confirm_final')
    .text('❌ Cancel', 'wd_cancel');

  const confirmMsg =
    `📋 <b>Confirm UPI Withdrawal</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💵 <b>Amount to Withdraw:</b> <code>${formatPaise(state.amountPaise)}</code>\n` +
    `💳 <b>Target UPI ID:</b> <code>${escapeHtml(cleanUpi)}</code>\n` +
    `💰 <b>Balance After Payout:</b> <code>${formatPaise(user.balance_paise - state.amountPaise)}</code>\n\n` +
    `⚠️ <b>Notice:</b> The amount will be reserved immediately while our payment team processes the transfer.\n\n` +
    `👇 <i>Tap confirm below to finalize:</i>`;

  return ctx.reply(confirmMsg, {
    parse_mode: 'HTML',
    reply_markup: confirmKeyboard,
  });
}

/**
 * Execute final atomic withdrawal reservation
 */
export async function executeWithdrawalConfirmation(ctx) {
  const user = getOrCreateUser(ctx.from);
  const state = userStates.get(String(user.telegram_id));
  if (!state || state.action !== 'WITHDRAW_CONFIRMATION') {
    return ctx.answerCallbackQuery({ text: 'Session expired. Please restart withdrawal.', show_alert: true });
  }

  const db = getDatabase();
  const amountPaise = state.amountPaise;
  const upiId = state.upiId;

  // Clear state
  userStates.delete(String(user.telegram_id));
  await ctx.answerCallbackQuery();

  // Re-verify balance atomically
  const latestUser = db.get('SELECT * FROM users WHERE telegram_id = ?', [user.telegram_id]);
  if (!latestUser || latestUser.balance_paise < amountPaise) {
    return ctx.reply('❌ Insufficient balance for this transaction.');
  }

  const now = new Date().toISOString();
  const newBalance = latestUser.balance_paise - amountPaise;

  // Atomic reservation
  db.runImmediate(
    'UPDATE users SET balance_paise = ?, updated_at = ? WHERE telegram_id = ?',
    [newBalance, now, user.telegram_id]
  );

  db.runImmediate(
    'INSERT INTO withdrawals (user_id, amount_paise, upi_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
    [user.telegram_id, amountPaise, upiId, 'pending', now]
  );

  const wdRow = db.get(
    'SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [user.telegram_id]
  );

  // Record transaction
  db.runImmediate(
    `INSERT INTO transactions (user_id, type, amount_paise, balance_after_paise, reference_id, description, created_at)
     VALUES (?, 'WITHDRAWAL_HOLD', ?, ?, ?, ?, ?)`,
    [
      user.telegram_id,
      -amountPaise,
      newBalance,
      `WD_${wdRow ? wdRow.id : 'N/A'}`,
      `Withdrawal reserved for UPI: ${upiId}`,
      now,
    ]
  );

  try {
    await ctx.editMessageText(
      `🎉 <b>Withdrawal Request Submitted!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🆔 <b>Request ID:</b> #WD_${wdRow ? wdRow.id : 'N/A'}\n` +
      `💵 <b>Amount:</b> <code>${formatPaise(amountPaise)}</code>\n` +
      `💳 <b>UPI ID:</b> <code>${escapeHtml(upiId)}</code>\n` +
      `💰 <b>Remaining Balance:</b> <code>${formatPaise(newBalance)}</code>\n\n` +
      `⏱️ <i>Your payment will be processed to your UPI account within 24 hours. You will receive a notification once paid!</i>`,
      { parse_mode: 'HTML' }
    );
  } catch {}

  // Notify Admins
  try {
    const admins = db.all('SELECT telegram_id FROM admins');
    const adminMsg =
      `💸 <b>New Withdrawal Request!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🆔 <b>ID:</b> #WD_${wdRow ? wdRow.id : 'N/A'}\n` +
      `👤 <b>User:</b> ${escapeHtml(ctx.from.first_name || 'User')} (@${escapeHtml(ctx.from.username || 'none')}) [<code>${user.telegram_id}</code>]\n` +
      `💵 <b>Amount:</b> <code>${formatPaise(amountPaise)}</code>\n` +
      `💳 <b>UPI ID:</b> <code>${escapeHtml(upiId)}</code>\n` +
      `📅 <b>Requested:</b> ${formatDateTime(now)}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👇 <i>Process payment and update status:</i>`;

    for (const adm of admins) {
      try {
        await ctx.api.sendMessage(Number(adm.telegram_id), adminMsg, {
          parse_mode: 'HTML',
          reply_markup: getWithdrawalActionKeyboard(wdRow.id),
        });
      } catch (err) {
        console.warn(`Admin notification error for ${adm.telegram_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Error notifying admins of withdrawal:', err);
  }
}

/**
 * Setup withdrawal routes
 */
export function setupWithdrawalsHandlers(bot) {
  bot.hears('💸 Withdraw', startWithdrawal);
  bot.command('withdraw', startWithdrawal);

  bot.callbackQuery('wd_amount_max', async (ctx) => {
    const user = getOrCreateUser(ctx.from);
    await ctx.answerCallbackQuery();
    return handleWithdrawAmount(ctx, user.balance_paise);
  });

  bot.callbackQuery('wd_amount_min', async (ctx) => {
    const db = getDatabase();
    const minPaise = parseInt(db.getSetting('min_withdrawal_paise', '1500'), 10);
    await ctx.answerCallbackQuery();
    return handleWithdrawAmount(ctx, minPaise);
  });

  bot.callbackQuery('wd_confirm_final', executeWithdrawalConfirmation);

  bot.callbackQuery('wd_cancel', async (ctx) => {
    userStates.delete(String(ctx.from.id));
    await ctx.answerCallbackQuery({ text: 'Withdrawal cancelled.' });
    try {
      await ctx.deleteMessage();
    } catch {}
    return ctx.reply('❌ Withdrawal request cancelled.');
  });
}
