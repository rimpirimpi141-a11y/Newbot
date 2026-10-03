import { InlineKeyboard } from 'grammy';
import { getDatabase } from '../database.js';
import { isSuperAdmin, isAdmin, logAdminAction } from '../utils/admin.js';
import { formatPaise, parseRupeesToPaise, escapeHtml, formatDateTime } from '../utils/helpers.js';
import { getAdminPanelKeyboard, getProofReviewKeyboard, getWithdrawalActionKeyboard, getMainUserKeyboard } from '../keyboards.js';
import { userStates } from './submissions.js';
import config from '../config.js';

/**
 * Render Admin Main Dashboard
 */
export async function showAdminPanel(ctx, isEdit = false) {
  const fromId = String(ctx.from.id);
  if (!isAdmin(fromId)) {
    return ctx.reply('🚫 Access denied. Administrator privileges required.');
  }

  const db = getDatabase();

  const pendingProofsRow = db.get("SELECT COUNT(*) as count FROM submissions WHERE status = 'pending'");
  const pendingWdRow = db.get("SELECT COUNT(*) as count FROM withdrawals WHERE status = 'pending'");
  const usersCountRow = db.get("SELECT COUNT(*) as count FROM users");
  const tasksCountRow = db.get("SELECT COUNT(*) as count FROM tasks WHERE status = 'active'");

  const stats = {
    pendingProofs: pendingProofsRow ? pendingProofsRow.count : 0,
    pendingWithdrawals: pendingWdRow ? pendingWdRow.count : 0,
  };

  const isSuper = isSuperAdmin(fromId);
  const roleLabel = isSuper ? '👑 Super Admin' : '🛡️ Admin';

  const text =
    `⚡ <b>TaskWork Admin Control Center</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>Operator:</b> ${escapeHtml(ctx.from.first_name || 'Admin')} (${roleLabel})\n` +
    `👥 <b>Total Users:</b> <code>${usersCountRow ? usersCountRow.count : 0}</code>\n` +
    `📋 <b>Active Tasks:</b> <code>${tasksCountRow ? tasksCountRow.count : 0}</code>\n` +
    `📝 <b>Pending Proofs:</b> <code>${stats.pendingProofs}</code>\n` +
    `💸 <b>Pending Payouts:</b> <code>${stats.pendingWithdrawals}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👇 <i>Select an administrative function below:</i>`;

  const keyboard = getAdminPanelKeyboard(fromId, stats);

  if (isEdit) {
    try {
      return await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch {}
  }

  return ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

/**
 * Handle Pending Proofs List
 */
export async function showPendingProofs(ctx) {
  const fromId = String(ctx.from.id);
  if (!isAdmin(fromId)) return;

  const db = getDatabase();
  const pending = db.all(
    `SELECT s.*, t.title as task_title, t.reward_paise, u.username, u.first_name 
     FROM submissions s 
     JOIN tasks t ON s.task_id = t.task_id 
     JOIN users u ON s.user_id = u.telegram_id 
     WHERE s.status = 'pending' 
     ORDER BY s.id ASC 
     LIMIT 5`
  );

  if (pending.length === 0) {
    return ctx.reply('✅ <b>No Pending Proofs</b>\n\nAll task proof submissions have been reviewed!', {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🔙 Back to Panel', 'admin_home'),
    });
  }

  const sub = pending[0];
  const caption =
    `📝 <b>Pending Proof Review (${pending.length} remaining)</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🆔 <b>Submission ID:</b> #${sub.id}\n` +
    `👤 <b>User:</b> ${escapeHtml(sub.first_name || 'User')} (@${escapeHtml(sub.username || 'none')}) [<code>${sub.user_id}</code>]\n` +
    `📋 <b>Task:</b> ${escapeHtml(sub.task_title)} (<code>${sub.task_id}</code>)\n` +
    `💰 <b>Reward:</b> <code>${formatPaise(sub.reward_paise)}</code>\n` +
    (sub.caption ? `💬 <b>User Note:</b> ${escapeHtml(sub.caption)}\n` : '') +
    `📅 <b>Submitted:</b> ${formatDateTime(sub.created_at)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👇 <i>Select an action:</i>`;

  try {
    return await ctx.replyWithPhoto(sub.file_id, {
      caption,
      parse_mode: 'HTML',
      reply_markup: getProofReviewKeyboard(sub.id),
    });
  } catch (err) {
    // If photo failed to load directly
    return ctx.reply(`${caption}\n\n⚠️ <i>(Photo preview unavailable: ${escapeHtml(err.message)})</i>`, {
      parse_mode: 'HTML',
      reply_markup: getProofReviewKeyboard(sub.id),
    });
  }
}

/**
 * Approve a proof submission
 */
export async function approveSubmission(ctx, submissionId) {
  const fromId = String(ctx.from.id);
  if (!isAdmin(fromId)) return;

  const db = getDatabase();
  const sub = db.get(
    'SELECT s.*, t.reward_paise, t.title as task_title FROM submissions s JOIN tasks t ON s.task_id = t.task_id WHERE s.id = ?',
    [submissionId]
  );

  if (!sub) {
    return ctx.answerCallbackQuery({ text: '❌ Submission not found.', show_alert: true });
  }

  if (sub.status !== 'pending') {
    return ctx.answerCallbackQuery({ text: `Already marked as ${sub.status}.`, show_alert: true });
  }

  const now = new Date().toISOString();
  const user = db.get('SELECT * FROM users WHERE telegram_id = ?', [sub.user_id]);
  if (!user) {
    return ctx.answerCallbackQuery({ text: '❌ User not found.', show_alert: true });
  }

  const rewardPaise = sub.reward_paise;
  const newBalance = user.balance_paise + rewardPaise;
  const newTotalEarned = user.total_earned_paise + rewardPaise;

  // 1. Update user balance & earnings
  db.runImmediate(
    'UPDATE users SET balance_paise = ?, total_earned_paise = ?, updated_at = ? WHERE telegram_id = ?',
    [newBalance, newTotalEarned, now, user.telegram_id]
  );

  // 2. Mark submission approved
  db.runImmediate(
    "UPDATE submissions SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ?",
    [now, fromId, submissionId]
  );

  // 3. Update task completions
  db.runImmediate(
    'UPDATE tasks SET current_completions = current_completions + 1 WHERE task_id = ?',
    [sub.task_id]
  );

  // 4. Record transaction
  db.runImmediate(
    `INSERT INTO transactions (user_id, type, amount_paise, balance_after_paise, reference_id, description, created_at)
     VALUES (?, 'TASK_REWARD', ?, ?, ?, ?, ?)`,
    [
      user.telegram_id,
      rewardPaise,
      newBalance,
      `SUB_${submissionId}`,
      `Reward for task: ${sub.task_title}`,
      now,
    ]
  );

  // 5. Check if first approved task and referrer exists
  if (user.referrer_id && !user.referral_rewarded) {
    const approvedCountRow = db.get(
      "SELECT COUNT(*) as count FROM submissions WHERE user_id = ? AND status = 'approved'",
      [user.telegram_id]
    );

    if (approvedCountRow && approvedCountRow.count === 1) {
      // First approved task! Pay referral bonus to referrer
      const refRewardPaise = parseInt(
        db.getSetting('referral_reward_paise', String(config.defaultReferralRewardPaise)),
        10
      );

      const referrer = db.get('SELECT * FROM users WHERE telegram_id = ?', [user.referrer_id]);
      if (referrer && !referrer.is_banned) {
        const refNewBalance = referrer.balance_paise + refRewardPaise;
        const refNewEarned = referrer.total_earned_paise + refRewardPaise;
        const refNewRefEarned = referrer.referral_earnings_paise + refRewardPaise;

        db.runImmediate(
          'UPDATE users SET balance_paise = ?, total_earned_paise = ?, referral_earnings_paise = ?, updated_at = ? WHERE telegram_id = ?',
          [refNewBalance, refNewEarned, refNewRefEarned, now, referrer.telegram_id]
        );

        db.runImmediate(
          'UPDATE users SET referral_rewarded = 1 WHERE telegram_id = ?',
          [user.telegram_id]
        );

        db.runImmediate(
          "UPDATE referrals SET status = 'rewarded', reward_paise = ?, rewarded_at = ? WHERE referrer_id = ? AND referred_id = ?",
          [refRewardPaise, now, referrer.telegram_id, user.telegram_id]
        );

        db.runImmediate(
          `INSERT INTO transactions (user_id, type, amount_paise, balance_after_paise, reference_id, description, created_at)
           VALUES (?, 'REFERRAL_REWARD', ?, ?, ?, ?, ?)`,
          [
            referrer.telegram_id,
            refRewardPaise,
            refNewBalance,
            `REF_${user.telegram_id}`,
            `Referral bonus for referred user ${user.first_name || user.telegram_id}`,
            now,
          ]
        );

        // Notify referrer
        try {
          await ctx.api.sendMessage(
            Number(referrer.telegram_id),
            `🎁 <b>Referral Bonus Received!</b>\n\n` +
            `Your referred friend <b>${escapeHtml(user.first_name || 'User')}</b> has completed their first approved task!\n\n` +
            `💰 <b>Credited:</b> <code>${formatPaise(refRewardPaise)}</code> to your wallet.`,
            { parse_mode: 'HTML' }
          );
        } catch (refErr) {
          console.warn('Failed to notify referrer:', refErr.message);
        }
      }
    }
  }

  logAdminAction(fromId, 'APPROVE_PROOF', String(submissionId), `Task: ${sub.task_title}, Amount: ${rewardPaise}`);

  await ctx.answerCallbackQuery({ text: `✅ Approved! Credited ${formatPaise(rewardPaise)}` });

  // Update message
  try {
    await ctx.editMessageReplyMarkup({
      reply_markup: new InlineKeyboard().text('✅ Approved & Credited', 'noop').row().text('⏩ Next Pending Proof', 'admin_pending_proofs'),
    });
  } catch {}

  // Notify user
  try {
    await ctx.api.sendMessage(
      Number(user.telegram_id),
      `🎉 <b>Proof Approved!</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Your proof for <b>${escapeHtml(sub.task_title)}</b> has been verified and approved by admin!\n\n` +
      `💰 <b>Amount Credited:</b> <code>${formatPaise(rewardPaise)}</code>\n` +
      `💵 <b>New Balance:</b> <code>${formatPaise(newBalance)}</code>\n\n` +
      `Keep completing tasks to earn more!`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.warn(`Failed to notify user ${user.telegram_id}:`, err.message);
  }
}

/**
 * Handle Reject Proof prompt
 */
export async function startRejectSubmission(ctx, submissionId) {
  const fromId = String(ctx.from.id);
  if (!isAdmin(fromId)) return;

  userStates.set(fromId, {
    action: 'ADMIN_REJECT_PROOF_REASON',
    submissionId: submissionId,
    timestamp: Date.now(),
  });

  await ctx.answerCallbackQuery();
  return ctx.reply(
    `❌ <b>Rejecting Submission #${submissionId}</b>\n\n` +
    `Please reply with the <b>reason for rejection</b> (e.g., <i>"Incomplete task"</i>, <i>"Invalid screenshot"</i>, <i>"Duplicate submission"</i>):\n\n` +
    `<i>Or send <code>/cancel</code> to abort.</i>`,
    { parse_mode: 'HTML' }
  );
}

/**
 * Process rejection reason and finalize proof rejection
 */
export async function finalizeRejectSubmission(ctx, reason) {
  const fromId = String(ctx.from.id);
  const state = userStates.get(fromId);
  if (!state || state.action !== 'ADMIN_REJECT_PROOF_REASON') return;

  const submissionId = state.submissionId;
  userStates.delete(fromId);

  const db = getDatabase();
  const sub = db.get(
    'SELECT s.*, t.title as task_title FROM submissions s JOIN tasks t ON s.task_id = t.task_id WHERE s.id = ?',
    [submissionId]
  );

  if (!sub || sub.status !== 'pending') {
    return ctx.reply('❌ Submission was already processed or does not exist.');
  }

  const now = new Date().toISOString();
  db.runImmediate(
    "UPDATE submissions SET status = 'rejected', rejection_reason = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?",
    [reason.trim(), now, fromId, submissionId]
  );

  logAdminAction(fromId, 'REJECT_PROOF', String(submissionId), `Reason: ${reason}`);

  await ctx.reply(`❌ <b>Submission #${submissionId} has been rejected.</b>\nReason: <i>${escapeHtml(reason)}</i>`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('⏩ Next Pending Proof', 'admin_pending_proofs').text('🔙 Admin Panel', 'admin_home'),
  });

  // Notify user
  try {
    await ctx.api.sendMessage(
      Number(sub.user_id),
      `❌ <b>Task Proof Rejected</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Your proof submission for <b>${escapeHtml(sub.task_title)}</b> was not approved.\n\n` +
      `📝 <b>Reason:</b> <i>${escapeHtml(reason)}</i>\n\n` +
      `💡 <i>Make sure to read the task instructions carefully before submitting again.</i>`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.warn(`Failed to notify user ${sub.user_id}:`, err.message);
  }
}

/**
 * Show Pending Withdrawals
 */
export async function showPendingWithdrawals(ctx) {
  const fromId = String(ctx.from.id);
  if (!isAdmin(fromId)) return;

  const db = getDatabase();
  const withdrawals = db.all(
    `SELECT w.*, u.username, u.first_name, u.balance_paise 
     FROM withdrawals w 
     JOIN users u ON w.user_id = u.telegram_id 
     WHERE w.status = 'pending' 
     ORDER BY w.id ASC 
     LIMIT 5`
  );

  if (withdrawals.length === 0) {
    return ctx.reply('✅ <b>No Pending Withdrawals</b>\n\nAll payout requests are up to date!', {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🔙 Back to Panel', 'admin_home'),
    });
  }

  const wd = withdrawals[0];
  const msg =
    `💸 <b>Pending Withdrawal Request (${withdrawals.length} in queue)</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🆔 <b>ID:</b> #WD_${wd.id}\n` +
    `👤 <b>User:</b> ${escapeHtml(wd.first_name || 'User')} (@${escapeHtml(wd.username || 'none')}) [<code>${wd.user_id}</code>]\n` +
    `💵 <b>Amount to Pay:</b> <code>${formatPaise(wd.amount_paise)}</code>\n` +
    `💳 <b>UPI ID:</b> <code>${escapeHtml(wd.upi_id)}</code>\n` +
    `📅 <b>Requested:</b> ${formatDateTime(wd.created_at)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👇 <i>Send payment via your UPI app, then click MARK PAID:</i>`;

  return ctx.reply(msg, {
    parse_mode: 'HTML',
    reply_markup: getWithdrawalActionKeyboard(wd.id),
  });
}

/**
 * Mark Withdrawal as Paid
 */
export async function markWithdrawalPaid(ctx, withdrawalId) {
  const fromId = String(ctx.from.id);
  if (!isAdmin(fromId)) return;

  const db = getDatabase();
  const wd = db.get('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId]);

  if (!wd) {
    return ctx.answerCallbackQuery({ text: '❌ Withdrawal not found.', show_alert: true });
  }

  if (wd.status !== 'pending') {
    return ctx.answerCallbackQuery({ text: `Already ${wd.status}.`, show_alert: true });
  }

  const now = new Date().toISOString();

  // Update withdrawal record
  db.runImmediate(
    "UPDATE withdrawals SET status = 'paid', processed_at = ?, processed_by = ? WHERE id = ?",
    [now, fromId, withdrawalId]
  );

  // Update user's total_withdrawn
  db.runImmediate(
    'UPDATE users SET total_withdrawn_paise = total_withdrawn_paise + ?, updated_at = ? WHERE telegram_id = ?',
    [wd.amount_paise, now, wd.user_id]
  );

  logAdminAction(fromId, 'WITHDRAWAL_PAID', String(withdrawalId), `Amount: ${wd.amount_paise}, UPI: ${wd.upi_id}`);

  await ctx.answerCallbackQuery({ text: '💰 Marked as Paid!' });

  try {
    await ctx.editMessageText(
      `✅ <b>Withdrawal #WD_${withdrawalId} Marked as PAID!</b>\n\n` +
      `Amount: <b>${formatPaise(wd.amount_paise)}</b>\n` +
      `UPI: <code>${escapeHtml(wd.upi_id)}</code>`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('⏩ Next Withdrawal', 'admin_withdrawals').text('🔙 Admin Panel', 'admin_home'),
      }
    );
  } catch {}

  // Notify user
  try {
    await ctx.api.sendMessage(
      Number(wd.user_id),
      `🎉 <b>Payment Successful!</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Your withdrawal request #WD_${withdrawalId} has been <b>PAID</b>!\n\n` +
      `💵 <b>Amount Transferred:</b> <code>${formatPaise(wd.amount_paise)}</code>\n` +
      `💳 <b>Transferred to UPI:</b> <code>${escapeHtml(wd.upi_id)}</code>\n\n` +
      `Thank you for working with TaskWork! Enjoy your earnings.`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.warn(`Failed to notify user ${wd.user_id}:`, err.message);
  }
}

/**
 * Start Reject & Refund Withdrawal prompt
 */
export async function startRejectWithdrawal(ctx, withdrawalId) {
  const fromId = String(ctx.from.id);
  if (!isAdmin(fromId)) return;

  userStates.set(fromId, {
    action: 'ADMIN_REJECT_WD_REASON',
    withdrawalId: withdrawalId,
    timestamp: Date.now(),
  });

  await ctx.answerCallbackQuery();
  return ctx.reply(
    `❌ <b>Reject & Refund Withdrawal #WD_${withdrawalId}</b>\n\n` +
    `Please reply with the <b>reason for rejection</b> (e.g., <i>"Invalid UPI ID"</i>, <i>"Account verification issue"</i>):\n\n` +
    `<i>The reserved funds will be returned to the user's wallet automatically. (Or send /cancel)</i>`,
    { parse_mode: 'HTML' }
  );
}

/**
 * Finalize Reject & Refund
 */
export async function finalizeRejectWithdrawal(ctx, reason) {
  const fromId = String(ctx.from.id);
  const state = userStates.get(fromId);
  if (!state || state.action !== 'ADMIN_REJECT_WD_REASON') return;

  const withdrawalId = state.withdrawalId;
  userStates.delete(fromId);

  const db = getDatabase();
  const wd = db.get('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId]);

  if (!wd || wd.status !== 'pending') {
    return ctx.reply('❌ Withdrawal was already processed or does not exist.');
  }

  const now = new Date().toISOString();
  const user = db.get('SELECT * FROM users WHERE telegram_id = ?', [wd.user_id]);

  if (!user) {
    return ctx.reply('❌ User not found.');
  }

  const newBalance = user.balance_paise + wd.amount_paise;

  // 1. Mark withdrawal rejected
  db.runImmediate(
    "UPDATE withdrawals SET status = 'rejected', rejection_reason = ?, processed_at = ?, processed_by = ? WHERE id = ?",
    [reason.trim(), now, fromId, withdrawalId]
  );

  // 2. Refund balance
  db.runImmediate(
    'UPDATE users SET balance_paise = ?, updated_at = ? WHERE telegram_id = ?',
    [newBalance, now, user.telegram_id]
  );

  // 3. Record refund transaction
  db.runImmediate(
    `INSERT INTO transactions (user_id, type, amount_paise, balance_after_paise, reference_id, description, created_at)
     VALUES (?, 'WITHDRAWAL_REFUND', ?, ?, ?, ?, ?)`,
    [
      user.telegram_id,
      wd.amount_paise,
      newBalance,
      `WD_REFUND_${withdrawalId}`,
      `Refund for rejected withdrawal #WD_${withdrawalId}: ${reason}`,
      now,
    ]
  );

  logAdminAction(fromId, 'WITHDRAWAL_REJECT_REFUND', String(withdrawalId), `Reason: ${reason}`);

  await ctx.reply(
    `❌ <b>Withdrawal #WD_${withdrawalId} rejected & ${formatPaise(wd.amount_paise)} refunded to user.</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('⏩ Next Withdrawal', 'admin_withdrawals').text('🔙 Admin Panel', 'admin_home'),
    }
  );

  // Notify user
  try {
    await ctx.api.sendMessage(
      Number(user.telegram_id),
      `⚠️ <b>Withdrawal Rejected & Refunded</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Your withdrawal request #WD_${withdrawalId} for <b>${formatPaise(wd.amount_paise)}</b> could not be processed.\n\n` +
      `📝 <b>Reason:</b> <i>${escapeHtml(reason)}</i>\n` +
      `💰 <b>Action:</b> The full amount of <b>${formatPaise(wd.amount_paise)}</b> has been refunded to your wallet balance.\n` +
      `💵 <b>Updated Balance:</b> <code>${formatPaise(newBalance)}</code>\n\n` +
      `Please check your details and try again if needed.`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.warn(`Failed to notify user ${user.telegram_id}:`, err.message);
  }
}

/**
 * Handle Add Task Interactive Multi-step flow
 */
export async function startAddTask(ctx) {
  const fromId = String(ctx.from.id);
  if (!isAdmin(fromId)) return;

  const keyboard = new InlineKeyboard()
    .text('🎯 Review Task', 'add_task_type_review')
    .text('📧 Gmail Task', 'add_task_type_gmail')
    .text('📋 Custom Task', 'add_task_type_custom').row()
    .text('❌ Cancel', 'admin_home');

  return ctx.reply('➕ <b>Create New Task</b>\n\nStep 1: Choose task category:', {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

/**
 * Handle Manage Tasks
 */
export async function showManageTasks(ctx) {
  const fromId = String(ctx.from.id);
  if (!isAdmin(fromId)) return;

  const db = getDatabase();
  const tasks = db.all("SELECT * FROM tasks WHERE status != 'deleted' ORDER BY id DESC LIMIT 15");

  if (tasks.length === 0) {
    return ctx.reply('📋 <b>No tasks created yet.</b>', {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('➕ Add Task', 'admin_add_task').text('🔙 Back', 'admin_home'),
    });
  }

  const keyboard = new InlineKeyboard();
  tasks.forEach((t) => {
    const statusIcon = t.status === 'active' ? '🟢' : '⏸️';
    keyboard.text(`${statusIcon} ${t.title.slice(0, 20)} (${formatPaise(t.reward_paise)})`, `adm_task_view_${t.task_id}`).row();
  });
  keyboard.text('➕ Add New Task', 'admin_add_task').row();
  keyboard.text('🔙 Admin Panel', 'admin_home');

  return ctx.reply('📋 <b>Select a task to manage:</b>', {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

/**
 * View Single Task in Admin
 */
export async function showAdminTaskDetail(ctx, taskId) {
  const fromId = String(ctx.from.id);
  if (!isAdmin(fromId)) return;

  const db = getDatabase();
  const task = db.get('SELECT * FROM tasks WHERE task_id = ?', [taskId]);
  if (!task) return ctx.reply('❌ Task not found.');

  const text =
    `📋 <b>Task Details:</b> <code>${task.task_id}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🏷️ <b>Title:</b> ${escapeHtml(task.title)}\n` +
    `📁 <b>Type:</b> ${task.type}\n` +
    `💰 <b>Reward:</b> <code>${formatPaise(task.reward_paise)}</code>\n` +
    `👥 <b>Completions:</b> ${task.current_completions} / ${task.max_completions}\n` +
    `🚦 <b>Status:</b> ${task.status}\n` +
    (task.link ? `🔗 <b>Link:</b> ${escapeHtml(task.link)}\n` : '') +
    `\n📝 <b>Description:</b>\n${escapeHtml(task.description || 'None')}\n\n` +
    `📌 <b>Instructions:</b>\n${escapeHtml(task.instructions || 'None')}`;

  const keyboard = new InlineKeyboard();
  if (task.status === 'active') {
    keyboard.text('⏸️ Pause Task', `adm_task_pause_${task.task_id}`);
  } else {
    keyboard.text('▶️ Activate Task', `adm_task_resume_${task.task_id}`);
  }
  keyboard.text('🗑️ Delete Task', `adm_task_delete_${task.task_id}`).row();
  keyboard.text('🔙 Back to Tasks', 'admin_manage_tasks');

  return ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

/**
 * Statistics overview
 */
export async function showAdminStats(ctx) {
  const fromId = String(ctx.from.id);
  if (!isAdmin(fromId)) return;

  const db = getDatabase();

  const totalUsers = db.get('SELECT COUNT(*) as count FROM users')?.count || 0;
  const bannedUsers = db.get('SELECT COUNT(*) as count FROM users WHERE is_banned = 1')?.count || 0;
  const totalEarnedPaise = db.get('SELECT COALESCE(SUM(total_earned_paise), 0) as sum FROM users')?.sum || 0;
  const totalWithdrawnPaise = db.get('SELECT COALESCE(SUM(total_withdrawn_paise), 0) as sum FROM users')?.sum || 0;
  const currentTotalBalancePaise = db.get('SELECT COALESCE(SUM(balance_paise), 0) as sum FROM users')?.sum || 0;

  const totalTasks = db.get('SELECT COUNT(*) as count FROM tasks')?.count || 0;
  const activeTasks = db.get("SELECT COUNT(*) as count FROM tasks WHERE status = 'active'")?.count || 0;

  const approvedProofs = db.get("SELECT COUNT(*) as count FROM submissions WHERE status = 'approved'")?.count || 0;
  const pendingProofs = db.get("SELECT COUNT(*) as count FROM submissions WHERE status = 'pending'")?.count || 0;
  const rejectedProofs = db.get("SELECT COUNT(*) as count FROM submissions WHERE status = 'rejected'")?.count || 0;

  const paidWithdrawals = db.get("SELECT COUNT(*) as count FROM withdrawals WHERE status = 'paid'")?.count || 0;
  const pendingWithdrawals = db.get("SELECT COUNT(*) as count FROM withdrawals WHERE status = 'pending'")?.count || 0;

  const text =
    `📊 <b>TaskWork Platform Statistics</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👥 <b>Users:</b>\n` +
    `• Total Registered: <code>${totalUsers}</code>\n` +
    `• Suspended / Banned: <code>${bannedUsers}</code>\n` +
    `• Active Users: <code>${totalUsers - bannedUsers}</code>\n\n` +
    `💰 <b>Financial Summary:</b>\n` +
    `• Total User Balances: <code>${formatPaise(currentTotalBalancePaise)}</code>\n` +
    `• Total Lifetime Earned: <code>${formatPaise(totalEarnedPaise)}</code>\n` +
    `• Total Successfully Paid Out: <code>${formatPaise(totalWithdrawnPaise)}</code>\n\n` +
    `📋 <b>Tasks & Submissions:</b>\n` +
    `• Total Tasks Created: <code>${totalTasks}</code> (${activeTasks} Active)\n` +
    `• Approved Proofs: <code>${approvedProofs}</code>\n` +
    `• Pending Proofs: <code>${pendingProofs}</code>\n` +
    `• Rejected Proofs: <code>${rejectedProofs}</code>\n\n` +
    `💸 <b>Withdrawals:</b>\n` +
    `• Paid Out Requests: <code>${paidWithdrawals}</code>\n` +
    `• Pending Requests: <code>${pendingWithdrawals}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━`;

  return ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('🔙 Admin Panel', 'admin_home'),
  });
}

/**
 * Super Admin: Force Channel Configuration
 */
export async function showForceChannelConfig(ctx) {
  const fromId = String(ctx.from.id);
  if (!isSuperAdmin(fromId)) {
    return ctx.reply('🚫 Only the Super Admin can configure Force Channel.');
  }

  const db = getDatabase();
  const current = db.getSetting('force_channel', '');

  const keyboard = new InlineKeyboard()
    .text('✏️ Set / Change Channel', 'adm_set_force_channel')
    .text('🗑️ Disable Force Channel', 'adm_disable_force_channel').row()
    .text('🔙 Admin Panel', 'admin_home');

  const text =
    `📢 <b>Force Channel Configuration</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Current Channel:</b> <code>${current ? escapeHtml(current) : 'Disabled (None)'}</code>\n\n` +
    `<i>When active, all new and existing users must be members of this channel before they can view tasks or withdraw.</i>\n\n` +
    `⚠️ <b>Note:</b> Make sure to add this bot as an <b>Administrator</b> in your Telegram channel with member viewing rights.`;

  return ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

/**
 * Super Admin: Admin Roster Management
 */
export async function showAdminRoster(ctx) {
  const fromId = String(ctx.from.id);
  if (!isSuperAdmin(fromId)) {
    return ctx.reply('🚫 Only the Super Admin can manage administrators.');
  }

  const db = getDatabase();
  const admins = db.all('SELECT * FROM admins ORDER BY role DESC, created_at ASC');

  let listText = '';
  const keyboard = new InlineKeyboard();

  admins.forEach((adm) => {
    const roleBadge = adm.role === 'superadmin' ? '👑 Super Admin' : '🛡️ Admin';
    listText += `• <code>${adm.telegram_id}</code> (${roleBadge}) - Added by ${adm.added_by}\n`;

    if (adm.role !== 'superadmin') {
      keyboard.text(`❌ Remove ${adm.telegram_id}`, `adm_remove_admin_${adm.telegram_id}`).row();
    }
  });

  keyboard.text('➕ Add New Admin', 'adm_add_admin_prompt').row();
  keyboard.text('🔙 Admin Panel', 'admin_home');

  const text =
    `👑 <b>Administrator Roster</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    listText +
    `\n━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Normal Admins can review proofs and process payouts, but cannot change Super Admin or bot financial rules.</i>`;

  return ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

/**
 * Safe Admin Broadcast execution with batching
 */
export async function executeBroadcast(ctx, broadcastText) {
  const fromId = String(ctx.from.id);
  if (!isAdmin(fromId)) return;

  const db = getDatabase();
  const users = db.all('SELECT telegram_id FROM users WHERE is_banned = 0');

  await ctx.reply(`📣 <b>Starting Broadcast to ${users.length} users...</b>\n\nPlease wait for the completion report.`, {
    parse_mode: 'HTML',
  });

  let successCount = 0;
  let failCount = 0;
  let blockedCount = 0;

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    try {
      await ctx.api.sendMessage(Number(u.telegram_id), broadcastText, {
        parse_mode: 'HTML',
      });
      successCount++;
    } catch (err) {
      failCount++;
      if (err.description && (err.description.includes('bot was blocked') || err.description.includes('user is deactivated'))) {
        blockedCount++;
      }
    }

    // Rate limiting: sleep 35ms between sends (max ~30 msg/sec limit for Telegram API)
    if (i % 25 === 0) {
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  logAdminAction(fromId, 'BROADCAST', null, `Success: ${successCount}, Failed: ${failCount}`);

  return ctx.reply(
    `📊 <b>Broadcast Completed!</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✅ <b>Delivered:</b> <code>${successCount}</code>\n` +
    `❌ <b>Failed / Blocked:</b> <code>${failCount}</code> (Blocked: ${blockedCount})\n` +
    `👥 <b>Total Attempted:</b> <code>${users.length}</code>`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🔙 Admin Panel', 'admin_home'),
    }
  );
}

/**
 * Setup All Admin handlers
 */
export function setupAdminHandlers(bot) {
  bot.hears('⚡ Admin Panel', (ctx) => showAdminPanel(ctx));
  bot.command('admin', (ctx) => showAdminPanel(ctx));

  bot.callbackQuery('admin_home', async (ctx) => {
    await ctx.answerCallbackQuery();
    return showAdminPanel(ctx, true);
  });

  bot.callbackQuery('admin_close', async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch {}
  });

  bot.callbackQuery('admin_pending_proofs', async (ctx) => {
    await ctx.answerCallbackQuery();
    return showPendingProofs(ctx);
  });

  bot.callbackQuery(/^adm_proof_approve_(\d+)$/, async (ctx) => {
    const subId = parseInt(ctx.match[1], 10);
    return approveSubmission(ctx, subId);
  });

  bot.callbackQuery(/^adm_proof_reject_(\d+)$/, async (ctx) => {
    const subId = parseInt(ctx.match[1], 10);
    return startRejectSubmission(ctx, subId);
  });

  bot.callbackQuery('admin_withdrawals', async (ctx) => {
    await ctx.answerCallbackQuery();
    return showPendingWithdrawals(ctx);
  });

  bot.callbackQuery(/^adm_wd_paid_(\d+)$/, async (ctx) => {
    const wdId = parseInt(ctx.match[1], 10);
    return markWithdrawalPaid(ctx, wdId);
  });

  bot.callbackQuery(/^adm_wd_reject_(\d+)$/, async (ctx) => {
    const wdId = parseInt(ctx.match[1], 10);
    return startRejectWithdrawal(ctx, wdId);
  });

  bot.callbackQuery('admin_stats', async (ctx) => {
    await ctx.answerCallbackQuery();
    return showAdminStats(ctx);
  });

  bot.callbackQuery('admin_manage_tasks', async (ctx) => {
    await ctx.answerCallbackQuery();
    return showManageTasks(ctx);
  });

  bot.callbackQuery('admin_add_task', async (ctx) => {
    await ctx.answerCallbackQuery();
    return startAddTask(ctx);
  });

  bot.callbackQuery(/^adm_task_view_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    return showAdminTaskDetail(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^adm_task_pause_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1];
    const db = getDatabase();
    db.runImmediate("UPDATE tasks SET status = 'paused' WHERE task_id = ?", [taskId]);
    await ctx.answerCallbackQuery({ text: 'Task Paused' });
    return showAdminTaskDetail(ctx, taskId);
  });

  bot.callbackQuery(/^adm_task_resume_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1];
    const db = getDatabase();
    db.runImmediate("UPDATE tasks SET status = 'active' WHERE task_id = ?", [taskId]);
    await ctx.answerCallbackQuery({ text: 'Task Activated' });
    return showAdminTaskDetail(ctx, taskId);
  });

  bot.callbackQuery(/^adm_task_delete_(.+)$/, async (ctx) => {
    const taskId = ctx.match[1];
    const db = getDatabase();
    db.runImmediate("UPDATE tasks SET status = 'deleted' WHERE task_id = ?", [taskId]);
    await ctx.answerCallbackQuery({ text: 'Task Deleted' });
    return showManageTasks(ctx);
  });

  bot.callbackQuery(/^add_task_type_(review|gmail|custom)$/, async (ctx) => {
    const type = ctx.match[1];
    const fromId = String(ctx.from.id);
    userStates.set(fromId, {
      action: 'ADMIN_ADD_TASK_STEP_TITLE',
      taskType: type,
      timestamp: Date.now(),
    });
    await ctx.answerCallbackQuery();
    return ctx.reply(
      `➕ <b>Creating ${type.toUpperCase()} Task</b>\n\n` +
      `Step 2: Please send the <b>Title</b> of the task (e.g. <i>"Install App & Write 5-Star Review"</i>):\n\n` +
      `<i>(Send /cancel to abort)</i>`,
      { parse_mode: 'HTML' }
    );
  });

  // Settings & Roster routes
  bot.callbackQuery('admin_force_channel', async (ctx) => {
    await ctx.answerCallbackQuery();
    return showForceChannelConfig(ctx);
  });

  bot.callbackQuery('adm_set_force_channel', async (ctx) => {
    const fromId = String(ctx.from.id);
    if (!isSuperAdmin(fromId)) return ctx.answerCallbackQuery({ text: 'Super Admin only', show_alert: true });
    userStates.set(fromId, { action: 'ADMIN_SET_FORCE_CHANNEL', timestamp: Date.now() });
    await ctx.answerCallbackQuery();
    return ctx.reply(
      '📢 <b>Enter Force Channel Username or ID:</b>\n\n' +
      'Example: <code>@TaskWorkOfficial</code> or <code>-1001234567890</code>\n\n' +
      '<i>Ensure the bot is added as an admin in this channel! (Or send /cancel)</i>',
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('adm_disable_force_channel', async (ctx) => {
    const fromId = String(ctx.from.id);
    if (!isSuperAdmin(fromId)) return ctx.answerCallbackQuery({ text: 'Super Admin only', show_alert: true });
    const db = getDatabase();
    db.setSetting('force_channel', '');
    logAdminAction(fromId, 'DISABLE_FORCE_CHANNEL');
    await ctx.answerCallbackQuery({ text: 'Force channel disabled.' });
    return showForceChannelConfig(ctx);
  });

  bot.callbackQuery('admin_set_ref_reward', async (ctx) => {
    const fromId = String(ctx.from.id);
    if (!isSuperAdmin(fromId)) return ctx.answerCallbackQuery({ text: 'Super Admin only', show_alert: true });
    const db = getDatabase();
    const current = db.getSetting('referral_reward_paise', '20');
    userStates.set(fromId, { action: 'ADMIN_SET_REF_REWARD', timestamp: Date.now() });
    await ctx.answerCallbackQuery();
    return ctx.reply(
      `💰 <b>Set Referral Reward</b>\n\n` +
      `Current: <b>${formatPaise(current)}</b>\n\n` +
      `Enter new referral reward amount in ₹ (e.g. <code>0.20</code> or <code>1.50</code>):\n\n` +
      `<i>(Or send /cancel to abort)</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('admin_set_min_withdraw', async (ctx) => {
    const fromId = String(ctx.from.id);
    if (!isSuperAdmin(fromId)) return ctx.answerCallbackQuery({ text: 'Super Admin only', show_alert: true });
    const db = getDatabase();
    const current = db.getSetting('min_withdrawal_paise', '1500');
    userStates.set(fromId, { action: 'ADMIN_SET_MIN_WITHDRAW', timestamp: Date.now() });
    await ctx.answerCallbackQuery();
    return ctx.reply(
      `💵 <b>Set Minimum Withdrawal</b>\n\n` +
      `Current: <b>${formatPaise(current)}</b>\n\n` +
      `Enter new minimum withdrawal in ₹ (e.g. <code>15</code> or <code>20</code>):\n\n` +
      `<i>(Or send /cancel to abort)</i>`,
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('admin_roster', async (ctx) => {
    await ctx.answerCallbackQuery();
    return showAdminRoster(ctx);
  });

  bot.callbackQuery('adm_add_admin_prompt', async (ctx) => {
    const fromId = String(ctx.from.id);
    if (!isSuperAdmin(fromId)) return ctx.answerCallbackQuery({ text: 'Super Admin only', show_alert: true });
    userStates.set(fromId, { action: 'ADMIN_ADD_ADMIN_ID', timestamp: Date.now() });
    await ctx.answerCallbackQuery();
    return ctx.reply(
      '👑 <b>Add Administrator</b>\n\nPlease enter the Telegram Numeric ID of the new admin (e.g. <code>987654321</code>):\n\n<i>(Or send /cancel)</i>',
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery(/^adm_remove_admin_(\d+)$/, async (ctx) => {
    const fromId = String(ctx.from.id);
    if (!isSuperAdmin(fromId)) return ctx.answerCallbackQuery({ text: 'Super Admin only', show_alert: true });
    const targetId = ctx.match[1];
    if (targetId === config.adminTelegramId) {
      return ctx.answerCallbackQuery({ text: 'Cannot remove permanent Super Admin!', show_alert: true });
    }
    const db = getDatabase();
    db.runImmediate('DELETE FROM admins WHERE telegram_id = ?', [targetId]);
    logAdminAction(fromId, 'REMOVE_ADMIN', targetId);
    await ctx.answerCallbackQuery({ text: 'Admin removed.' });
    return showAdminRoster(ctx);
  });

  bot.callbackQuery('admin_broadcast', async (ctx) => {
    const fromId = String(ctx.from.id);
    userStates.set(fromId, { action: 'ADMIN_BROADCAST_MSG', timestamp: Date.now() });
    await ctx.answerCallbackQuery();
    return ctx.reply(
      '📣 <b>Admin Broadcast Message</b>\n\n' +
      'Please send the text/HTML message you want to broadcast to all users:\n\n' +
      '<i>(Send /cancel to abort)</i>',
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('admin_users', async (ctx) => {
    const fromId = String(ctx.from.id);
    userStates.set(fromId, { action: 'ADMIN_SEARCH_USER', timestamp: Date.now() });
    await ctx.answerCallbackQuery();
    return ctx.reply(
      '👥 <b>User Management</b>\n\nPlease send a Telegram User ID or @Username to search:\n\n<i>(Or send /cancel)</i>',
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('admin_wallet_mgr', async (ctx) => {
    const fromId = String(ctx.from.id);
    if (!isSuperAdmin(fromId)) return ctx.answerCallbackQuery({ text: 'Super Admin only', show_alert: true });
    userStates.set(fromId, { action: 'ADMIN_WALLET_SEARCH_USER', timestamp: Date.now() });
    await ctx.answerCallbackQuery();
    return ctx.reply(
      '💳 <b>Wallet Adjustment</b>\n\nPlease send the Telegram User ID whose wallet you want to adjust:\n\n<i>(Or send /cancel)</i>',
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('admin_audit_logs', async (ctx) => {
    const fromId = String(ctx.from.id);
    if (!isSuperAdmin(fromId)) return ctx.answerCallbackQuery({ text: 'Super Admin only', show_alert: true });
    const db = getDatabase();
    const logs = db.all('SELECT * FROM admin_logs ORDER BY id DESC LIMIT 10');

    let logText = '';
    if (logs.length === 0) {
      logText = '<i>No audit logs recorded yet.</i>';
    } else {
      logText = logs
        .map((l) => `• <b>${l.action}</b> by <code>${l.admin_id}</code>\n   Target: ${l.target_id || 'N/A'} | ${l.details || ''}\n   <small>${formatDateTime(l.created_at)}</small>`)
        .join('\n\n');
    }

    return ctx.reply(
      `📜 <b>Recent Admin Audit Logs</b>\n━━━━━━━━━━━━━━━━━━━━\n\n${logText}`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🔙 Admin Panel', 'admin_home'),
      }
    );
  });
}
