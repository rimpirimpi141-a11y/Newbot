import { getDatabase } from '../database.js';
import { formatPaise, escapeHtml, formatDateTime } from '../utils/helpers.js';
import { getProofReviewKeyboard } from '../keyboards.js';
import { getOrCreateUser } from './start.js';

// In-memory user states for active multi-step operations (per telegram_id)
export const userStates = new Map();

/**
 * Prompt user to send photo proof
 */
export async function startProofSubmission(ctx, taskId) {
  const user = getOrCreateUser(ctx.from);
  const db = getDatabase();

  const task = db.get('SELECT * FROM tasks WHERE task_id = ?', [taskId]);
  if (!task) {
    return ctx.answerCallbackQuery({ text: '❌ Task not found.', show_alert: true });
  }

  // Set user state
  userStates.set(String(user.telegram_id), {
    action: 'AWAITING_PROOF_PHOTO',
    taskId: taskId,
    taskTitle: task.title,
    rewardPaise: task.reward_paise,
    timestamp: Date.now(),
  });

  await ctx.answerCallbackQuery();

  const msg =
    `📸 <b>Submit Task Proof for:</b> "${escapeHtml(task.title)}"\n` +
    `💰 <b>Reward:</b> <code>${formatPaise(task.reward_paise)}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Please upload a clear <b>screenshot / photo</b> showing that you have completed this task as instructed.\n\n` +
    `💡 <i>You can add an optional note/caption along with your photo.</i>\n\n` +
    `❌ <i>Send <code>/cancel</code> at any time to abort this submission.</i>`;

  return ctx.reply(msg, { parse_mode: 'HTML' });
}

/**
 * Handle incoming photo or image document for pending proof submission
 */
export async function handleProofUpload(ctx, state) {
  const user = getOrCreateUser(ctx.from);
  const db = getDatabase();
  const taskId = state.taskId;

  let fileId = null;
  let caption = ctx.message?.caption || ctx.message?.text || '';

  if (ctx.message?.photo && ctx.message.photo.length > 0) {
    // Get highest resolution photo
    const bestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
    fileId = bestPhoto.file_id;
  } else if (ctx.message?.document && ctx.message.document.mime_type?.startsWith('image/')) {
    fileId = ctx.message.document.file_id;
  }

  if (!fileId) {
    return ctx.reply('⚠️ Please upload an actual <b>screenshot or photo image</b> proof. (Or type /cancel to abort)', {
      parse_mode: 'HTML',
    });
  }

  // Clear state
  userStates.delete(String(user.telegram_id));

  // Verify task status
  const task = db.get('SELECT * FROM tasks WHERE task_id = ?', [taskId]);
  if (!task) {
    return ctx.reply('❌ This task no longer exists.');
  }

  // Check duplicate
  const existingPending = db.get(
    "SELECT * FROM submissions WHERE user_id = ? AND task_id = ? AND status = 'pending'",
    [user.telegram_id, taskId]
  );
  if (existingPending) {
    return ctx.reply('⏳ You already have a pending proof for this task waiting for admin review.');
  }

  const existingApproved = db.get(
    "SELECT * FROM submissions WHERE user_id = ? AND task_id = ? AND status = 'approved'",
    [user.telegram_id, taskId]
  );
  if (existingApproved) {
    return ctx.reply('✅ You have already received rewards for this task.');
  }

  // Insert submission
  const now = new Date().toISOString();
  db.runImmediate(
    `INSERT INTO submissions (user_id, task_id, file_id, caption, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
    [user.telegram_id, taskId, fileId, caption.trim() || null, now]
  );

  // Update claim status
  db.runImmediate(
    "UPDATE task_claims SET status = 'submitted' WHERE user_id = ? AND task_id = ?",
    [user.telegram_id, taskId]
  );

  const sub = db.get(
    'SELECT * FROM submissions WHERE user_id = ? AND task_id = ? ORDER BY id DESC LIMIT 1',
    [user.telegram_id, taskId]
  );

  const successMsg =
    `🎉 <b>Proof Submitted Successfully!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📋 <b>Task:</b> ${escapeHtml(task.title)}\n` +
    `💰 <b>Expected Reward:</b> <code>${formatPaise(task.reward_paise)}</code>\n` +
    `🆔 <b>Submission ID:</b> #${sub ? sub.id : 'N/A'}\n\n` +
    `⏳ Our admins will verify your proof shortly. Once approved, your wallet balance will be credited automatically!`;

  await ctx.reply(successMsg, { parse_mode: 'HTML' });

  // Notify Admins
  try {
    const admins = db.all('SELECT telegram_id FROM admins');
    const adminNotificationCaption =
      `📝 <b>New Task Proof Submitted!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🆔 <b>Submission ID:</b> #${sub.id}\n` +
      `👤 <b>User:</b> ${escapeHtml(ctx.from.first_name || 'User')} (@${escapeHtml(ctx.from.username || 'none')}) [<code>${user.telegram_id}</code>]\n` +
      `📋 <b>Task:</b> ${escapeHtml(task.title)} (<code>${task.task_id}</code>)\n` +
      `💰 <b>Reward:</b> <code>${formatPaise(task.reward_paise)}</code>\n` +
      (caption ? `💬 <b>User Note:</b> ${escapeHtml(caption)}\n` : '') +
      `📅 <b>Submitted:</b> ${formatDateTime(now)}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👇 <i>Review and select an action:</i>`;

    for (const adm of admins) {
      try {
        await ctx.api.sendPhoto(Number(adm.telegram_id), fileId, {
          caption: adminNotificationCaption,
          parse_mode: 'HTML',
          reply_markup: getProofReviewKeyboard(sub.id),
        });
      } catch (adminErr) {
        console.warn(`Failed to notify admin ${adm.telegram_id}:`, adminErr.message);
      }
    }
  } catch (err) {
    console.error('Error notifying admins of submission:', err);
  }
}

/**
 * Setup submission triggers
 */
export function setupSubmissionsHandlers(bot) {
  bot.callbackQuery(/^submit_proof_(.+)$/, (ctx) => {
    const taskId = ctx.match[1];
    return startProofSubmission(ctx, taskId);
  });
}
