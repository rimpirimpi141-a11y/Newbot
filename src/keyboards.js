import { Keyboard, InlineKeyboard } from 'grammy';
import config from './config.js';
import { isSuperAdmin } from './utils/admin.js';

/**
 * Main User Persistent Reply Keyboard
 */
export function getMainUserKeyboard(isAdminUser = false) {
  const keyboard = new Keyboard()
    .text('🎯 Get Review Task').text('📧 Get Gmail Task').row()
    .text('📋 All Tasks').text('👥 Invite & Earn').row()
    .text('💰 Wallet').text('💸 Withdraw').row()
    .text('🏆 Leaderboard').text('📊 My Stats').row()
    .text('💝 Support');

  if (isAdminUser) {
    keyboard.row().text('⚡ Admin Panel');
  }

  return keyboard.resized().persistent();
}

/**
 * Force Channel Subscription Keyboard
 */
export function getForceChannelKeyboard(channelIdentifier) {
  const keyboard = new InlineKeyboard();
  let channelUrl = '';

  if (channelIdentifier.startsWith('@')) {
    channelUrl = `https://t.me/${channelIdentifier.replace(/^@/, '')}`;
  } else if (channelIdentifier.startsWith('http')) {
    channelUrl = channelIdentifier;
  } else {
    channelUrl = `https://t.me/${channelIdentifier}`;
  }

  keyboard.url('📢 Join Official Channel', channelUrl).row();
  keyboard.text('✅ Check Joined', 'check_force_sub');
  return keyboard;
}

/**
 * Task Details Action Keyboard
 */
export function getTaskActionKeyboard(task, isClaimed = false, hasSubmitted = false, taskLink = null) {
  const keyboard = new InlineKeyboard();

  if (taskLink) {
    keyboard.url('🔗 Open Task Link', taskLink).row();
  }

  if (hasSubmitted) {
    keyboard.text('⏳ Submission Under Review', `noop`).row();
  } else if (isClaimed) {
    keyboard.text('📸 Submit Proof Screenshot', `submit_proof_${task.task_id}`).row();
    keyboard.text('❌ Cancel Claim', `cancel_claim_${task.task_id}`).row();
  } else {
    keyboard.text('🚀 Claim This Task', `claim_task_${task.task_id}`).row();
  }

  keyboard.text('🔙 Back to Tasks', 'menu_all_tasks');
  return keyboard;
}

/**
 * Task List Keyboard
 */
export function getTaskListKeyboard(tasks, page = 1, totalPages = 1, type = 'all') {
  const keyboard = new InlineKeyboard();

  tasks.forEach((t) => {
    const icon = t.type === 'review' ? '🎯' : t.type === 'gmail' ? '📧' : '📋';
    const rewardRupees = (t.reward_paise / 100).toFixed(2);
    keyboard.text(`${icon} ${t.title.slice(0, 24)} (₹${rewardRupees})`, `view_task_${t.task_id}`).row();
  });

  const navRow = [];
  if (page > 1) {
    navRow.push({ text: '⬅️ Prev', callback_data: `tasks_page_${type}_${page - 1}` });
  }
  if (page < totalPages) {
    navRow.push({ text: 'Next ➡️', callback_data: `tasks_page_${type}_${page + 1}` });
  }

  if (navRow.length > 0) {
    navRow.forEach((btn) => keyboard.text(btn.text, btn.callback_data));
    keyboard.row();
  }

  keyboard.text('🔄 Refresh List', `refresh_tasks_${type}`);
  return keyboard;
}

/**
 * Support Keyboard
 */
export function getSupportKeyboard() {
  const supportName = config.supportUsername || 'TaskWorkSupport';
  return new InlineKeyboard()
    .url('📩 Contact Support Directly', `https://t.me/${supportName}`).row()
    .text('🔄 Refresh Status', 'refresh_stats');
}

/**
 * Admin Panel Inline Keyboard
 */
export function getAdminPanelKeyboard(adminTelegramId, stats = {}) {
  const isSuper = isSuperAdmin(adminTelegramId);
  const keyboard = new InlineKeyboard();

  const pendingProofsCount = stats.pendingProofs || 0;
  const pendingWithdrawalsCount = stats.pendingWithdrawals || 0;

  keyboard
    .text('➕ Add Task', 'admin_add_task')
    .text('📋 Manage Tasks', 'admin_manage_tasks').row()
    .text(`📝 Pending Proofs (${pendingProofsCount})`, 'admin_pending_proofs')
    .text(`💸 Withdrawals (${pendingWithdrawalsCount})`, 'admin_withdrawals').row()
    .text('👥 Users', 'admin_users')
    .text('📊 Statistics', 'admin_stats').row();

  if (isSuper) {
    keyboard
      .text('💰 Referral Reward', 'admin_set_ref_reward')
      .text('💵 Min Withdrawal', 'admin_set_min_withdraw').row()
      .text('📢 Force Channel', 'admin_force_channel')
      .text('📣 Broadcast', 'admin_broadcast').row()
      .text('💳 Wallet Management', 'admin_wallet_mgr')
      .text('👑 Admin Roster', 'admin_roster').row()
      .text('⚙️ Bot Settings', 'admin_bot_settings')
      .text('📜 Audit Logs', 'admin_audit_logs').row();
  } else {
    keyboard
      .text('📣 Broadcast', 'admin_broadcast').row();
  }

  keyboard.text('🔙 Close Admin Panel', 'admin_close');
  return keyboard;
}

/**
 * Proof Review Keyboard for Admin
 */
export function getProofReviewKeyboard(submissionId) {
  return new InlineKeyboard()
    .text('✅ Approve (+Reward)', `adm_proof_approve_${submissionId}`)
    .text('❌ Reject', `adm_proof_reject_${submissionId}`).row()
    .text('⏩ Skip / Next', 'admin_pending_proofs');
}

/**
 * Withdrawal Action Keyboard for Admin
 */
export function getWithdrawalActionKeyboard(withdrawalId) {
  return new InlineKeyboard()
    .text('💰 MARK PAID', `adm_wd_paid_${withdrawalId}`)
    .text('❌ REJECT & REFUND', `adm_wd_reject_${withdrawalId}`).row()
    .text('⏩ Back to List', 'admin_withdrawals');
}
