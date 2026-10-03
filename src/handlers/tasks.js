import { getDatabase } from '../database.js';
import { formatPaise, escapeHtml, formatDateTime } from '../utils/helpers.js';
import { getTaskListKeyboard, getTaskActionKeyboard } from '../keyboards.js';
import { checkForceChannelMembership, getOrCreateUser } from './start.js';

const PAGE_SIZE = 6;

/**
 * Fetch paginated tasks based on filter
 */
export function getAvailableTasks(type = 'all', page = 1) {
  const db = getDatabase();
  let countQuery = "SELECT COUNT(*) as count FROM tasks WHERE status = 'active' AND current_completions < max_completions";
  let listQuery = "SELECT * FROM tasks WHERE status = 'active' AND current_completions < max_completions";
  const params = [];

  if (type !== 'all') {
    countQuery += ' AND type = ?';
    listQuery += ' AND type = ?';
    params.push(type);
  }

  listQuery += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  const offset = (page - 1) * PAGE_SIZE;

  const totalRow = db.get(countQuery, type !== 'all' ? [type] : []);
  const totalCount = totalRow ? totalRow.count : 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const tasks = db.all(listQuery, [...params, PAGE_SIZE, offset]);

  return { tasks, totalCount, totalPages, page };
}

/**
 * Display Task Browser list to user
 */
export async function renderTaskBrowser(ctx, type = 'all', page = 1, isEdit = false) {
  const user = getOrCreateUser(ctx.from);
  if (user.is_banned) {
    return ctx.reply('🚫 Your account is suspended.');
  }

  const forceCheck = await checkForceChannelMembership(ctx, user.telegram_id);
  if (forceCheck.required && !forceCheck.isMember) {
    return ctx.reply(
      '⚠️ <b>Channel Subscription Required</b>\n\nYou must join our official channel before accessing tasks.',
      { parse_mode: 'HTML' }
    );
  }

  const { tasks, totalPages } = getAvailableTasks(type, page);

  const typeName = type === 'review' ? '🎯 Review Tasks' : type === 'gmail' ? '📧 Gmail Tasks' : '📋 All Available Tasks';

  if (tasks.length === 0) {
    const emptyMsg =
      `<b>${typeName}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<i>No tasks available in this category right now. New tasks are added regularly! Check back soon or try another category.</i>`;

    if (isEdit) {
      try {
        return await ctx.editMessageText(emptyMsg, {
          parse_mode: 'HTML',
          reply_markup: getTaskListKeyboard([], 1, 1, type),
        });
      } catch {}
    }
    return ctx.reply(emptyMsg, {
      parse_mode: 'HTML',
      reply_markup: getTaskListKeyboard([], 1, 1, type),
    });
  }

  const text =
    `<b>${typeName}</b> (Page ${page}/${totalPages})\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👇 <i>Select a task from the list below to view instructions and claim reward:</i>`;

  const keyboard = getTaskListKeyboard(tasks, page, totalPages, type);

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
 * Show detailed view of a specific task
 */
export async function showTaskDetails(ctx, taskId, isEdit = true) {
  const user = getOrCreateUser(ctx.from);
  const db = getDatabase();

  const task = db.get('SELECT * FROM tasks WHERE task_id = ?', [taskId]);
  if (!task || task.status === 'deleted') {
    return ctx.reply('❌ Task not found or has been removed.');
  }

  // Check if user already has an approved completion
  const approvedSubmission = db.get(
    "SELECT * FROM submissions WHERE user_id = ? AND task_id = ? AND status = 'approved'",
    [user.telegram_id, taskId]
  );

  // Check if user has a pending submission
  const pendingSubmission = db.get(
    "SELECT * FROM submissions WHERE user_id = ? AND task_id = ? AND status = 'pending'",
    [user.telegram_id, taskId]
  );

  // Check if user has an active claim
  const claim = db.get(
    "SELECT * FROM task_claims WHERE user_id = ? AND task_id = ? AND status = 'claimed'",
    [user.telegram_id, taskId]
  );

  const typeIcon = task.type === 'review' ? '🎯' : task.type === 'gmail' ? '📧' : '📋';
  const typeLabel = task.type === 'review' ? 'Review Task' : task.type === 'gmail' ? 'Gmail Task' : 'Custom Task';

  let statusBadge = '🟢 Available';
  if (task.status === 'paused') statusBadge = '⏸️ Paused';
  if (task.current_completions >= task.max_completions) statusBadge = '🔴 Limit Reached';
  if (approvedSubmission) statusBadge = '✅ Completed & Rewarded';
  else if (pendingSubmission) statusBadge = '⏳ Under Review';
  else if (claim) statusBadge = '🚀 In Progress (Claimed)';

  const remaining = Math.max(0, task.max_completions - task.current_completions);

  const taskMsg =
    `${typeIcon} <b>${escapeHtml(task.title)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🏷️ <b>Category:</b> ${typeLabel}\n` +
    `💰 <b>Reward:</b> <code>${formatPaise(task.reward_paise)}</code>\n` +
    `📊 <b>Status:</b> ${statusBadge}\n` +
    `👥 <b>Remaining Slots:</b> ${remaining} of ${task.max_completions}\n\n` +
    `📝 <b>Description:</b>\n${escapeHtml(task.description || 'No description provided.')}\n\n` +
    `📌 <b>Step-by-Step Instructions:</b>\n` +
    `${escapeHtml(task.instructions || 'Follow all guidelines carefully and take a screenshot when done.')}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ <i>Make sure to complete the legitimate task accurately before uploading proof!</i>`;

  const keyboard = getTaskActionKeyboard(
    task,
    Boolean(claim),
    Boolean(pendingSubmission),
    task.link
  );

  if (isEdit) {
    try {
      return await ctx.editMessageText(taskMsg, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch {}
  }

  return ctx.reply(taskMsg, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

/**
 * Handle claiming a task
 */
export async function claimTask(ctx, taskId) {
  const user = getOrCreateUser(ctx.from);
  const db = getDatabase();

  if (user.is_banned) {
    return ctx.answerCallbackQuery({ text: '🚫 Your account is suspended.', show_alert: true });
  }

  const forceCheck = await checkForceChannelMembership(ctx, user.telegram_id);
  if (forceCheck.required && !forceCheck.isMember) {
    return ctx.answerCallbackQuery({
      text: '⚠️ You must join our official channel first!',
      show_alert: true,
    });
  }

  const task = db.get('SELECT * FROM tasks WHERE task_id = ?', [taskId]);
  if (!task || task.status !== 'active') {
    return ctx.answerCallbackQuery({ text: '❌ This task is no longer active.', show_alert: true });
  }

  if (task.current_completions >= task.max_completions) {
    return ctx.answerCallbackQuery({ text: '❌ This task has reached its maximum completions.', show_alert: true });
  }

  const approved = db.get(
    "SELECT * FROM submissions WHERE user_id = ? AND task_id = ? AND status = 'approved'",
    [user.telegram_id, taskId]
  );
  if (approved) {
    return ctx.answerCallbackQuery({ text: '✅ You have already completed and been rewarded for this task!', show_alert: true });
  }

  const pending = db.get(
    "SELECT * FROM submissions WHERE user_id = ? AND task_id = ? AND status = 'pending'",
    [user.telegram_id, taskId]
  );
  if (pending) {
    return ctx.answerCallbackQuery({ text: '⏳ You have a proof submission currently under review for this task.', show_alert: true });
  }

  // Create or refresh claim
  const now = new Date().toISOString();
  db.runImmediate(
    'INSERT INTO task_claims (user_id, task_id, status, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, task_id) DO UPDATE SET status = ?, created_at = ?',
    [user.telegram_id, taskId, 'claimed', now, 'claimed', now]
  );

  await ctx.answerCallbackQuery({ text: '🚀 Task claimed successfully!' });
  return showTaskDetails(ctx, taskId, true);
}

/**
 * Handle canceling a claim
 */
export async function cancelClaim(ctx, taskId) {
  const user = getOrCreateUser(ctx.from);
  const db = getDatabase();

  db.runImmediate(
    "UPDATE task_claims SET status = 'cancelled' WHERE user_id = ? AND task_id = ?",
    [user.telegram_id, taskId]
  );

  await ctx.answerCallbackQuery({ text: 'Claim cancelled.' });
  return showTaskDetails(ctx, taskId, true);
}

/**
 * Setup task navigation handlers
 */
export function setupTasksHandlers(bot) {
  bot.hears('🎯 Get Review Task', (ctx) => renderTaskBrowser(ctx, 'review', 1));
  bot.hears('📧 Get Gmail Task', (ctx) => renderTaskBrowser(ctx, 'gmail', 1));
  bot.hears('📋 All Tasks', (ctx) => renderTaskBrowser(ctx, 'all', 1));
  bot.command('tasks', (ctx) => renderTaskBrowser(ctx, 'all', 1));

  bot.callbackQuery('menu_all_tasks', (ctx) => {
    ctx.answerCallbackQuery();
    return renderTaskBrowser(ctx, 'all', 1, true);
  });

  bot.callbackQuery(/^tasks_page_(all|review|gmail)_(\d+)$/, (ctx) => {
    ctx.answerCallbackQuery();
    const type = ctx.match[1];
    const page = parseInt(ctx.match[2], 10) || 1;
    return renderTaskBrowser(ctx, type, page, true);
  });

  bot.callbackQuery(/^refresh_tasks_(all|review|gmail)$/, (ctx) => {
    ctx.answerCallbackQuery({ text: 'Refreshed!' });
    const type = ctx.match[1];
    return renderTaskBrowser(ctx, type, 1, true);
  });

  bot.callbackQuery(/^view_task_(.+)$/, (ctx) => {
    ctx.answerCallbackQuery();
    const taskId = ctx.match[1];
    return showTaskDetails(ctx, taskId, true);
  });

  bot.callbackQuery(/^claim_task_(.+)$/, (ctx) => {
    const taskId = ctx.match[1];
    return claimTask(ctx, taskId);
  });

  bot.callbackQuery(/^cancel_claim_(.+)$/, (ctx) => {
    const taskId = ctx.match[1];
    return cancelClaim(ctx, taskId);
  });
}
