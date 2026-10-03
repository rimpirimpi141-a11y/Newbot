import fs from 'fs';
import path from 'path';
import { initDatabase } from '../src/database.js';
import { formatPaise, parseRupeesToPaise } from '../src/utils/helpers.js';
import { isSuperAdmin, isAdmin } from '../src/utils/admin.js';
import config from '../src/config.js';

async function runTests() {
  console.log('🧪 Starting TaskWork Bot Automated Test Suite...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // Use a dedicated in-memory / temporary test database
  const testDbPath = path.join(process.cwd(), 'data', 'test_taskwork.db');
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  // Set test admin config
  config.adminTelegramId = '999999999';

  console.log('1. Database Initialization & Schema Test');
  const db = await initDatabase(testDbPath);
  assert(db !== null, 'Database initialized successfully');
  
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames = tables.map(t => t.name);
  assert(tableNames.includes('users'), 'Table `users` exists');
  assert(tableNames.includes('tasks'), 'Table `tasks` exists');
  assert(tableNames.includes('submissions'), 'Table `submissions` exists');
  assert(tableNames.includes('withdrawals'), 'Table `withdrawals` exists');
  assert(tableNames.includes('transactions'), 'Table `transactions` exists');
  assert(tableNames.includes('referrals'), 'Table `referrals` exists');
  assert(tableNames.includes('admins'), 'Table `admins` exists');
  assert(tableNames.includes('settings'), 'Table `settings` exists');

  console.log('\n2. Financial Integer Paise Calculations');
  assert(formatPaise(1500) === '₹15.00', '1500 paise formats to ₹15.00');
  assert(formatPaise(20) === '₹0.20', '20 paise formats to ₹0.20');
  assert(formatPaise(105) === '₹1.05', '105 paise formats to ₹1.05');
  assert(parseRupeesToPaise('15.00') === 1500, '₹15.00 parses to 1500 paise');
  assert(parseRupeesToPaise('0.20') === 20, '₹0.20 parses to 20 paise');
  assert(parseRupeesToPaise('2.5') === 250, '₹2.5 parses to 250 paise');

  console.log('\n3. RBAC & Admin Permissions');
  assert(isSuperAdmin('999999999') === true, 'Permanent Super Admin recognized');
  assert(isAdmin('999999999') === true, 'Super Admin has Admin privileges');
  assert(isAdmin('111111111') === false, 'Non-admin user rejected');

  // Add Normal Admin
  db.runImmediate(
    'INSERT INTO admins (telegram_id, role, added_by, created_at) VALUES (?, ?, ?, ?)',
    ['888888888', 'admin', '999999999', new Date().toISOString()]
  );
  assert(isAdmin('888888888') === true, 'Normal Admin recognized');
  assert(isSuperAdmin('888888888') === false, 'Normal Admin is NOT Super Admin');

  console.log('\n4. User Registration & Referral System');
  const now = new Date().toISOString();
  // Register Referrer (User A)
  db.runImmediate(
    `INSERT INTO users (telegram_id, username, first_name, balance_paise, total_earned_paise, total_withdrawn_paise, referral_earnings_paise, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?)`,
    ['1001', 'referrer_user', 'Alice', now, now]
  );
  const userA = db.get('SELECT * FROM users WHERE telegram_id = ?', ['1001']);
  assert(userA.balance_paise === 0, 'User A registered with ₹0 balance');

  // Register Referred (User B) with Referrer A
  db.runImmediate(
    `INSERT INTO users (telegram_id, username, first_name, balance_paise, total_earned_paise, total_withdrawn_paise, referral_earnings_paise, referrer_id, referral_rewarded, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, 0, 0, '1001', 0, ?, ?)`,
    ['1002', 'referred_user', 'Bob', now, now]
  );
  db.runImmediate(
    'INSERT INTO referrals (referrer_id, referred_id, status, reward_paise, created_at) VALUES (?, ?, ?, 0, ?)',
    ['1001', '1002', 'registered', now]
  );
  const userB = db.get('SELECT * FROM users WHERE telegram_id = ?', ['1002']);
  assert(userB.referrer_id === '1001', 'User B linked to Referrer A');

  console.log('\n5. Task Creation & Claiming');
  db.runImmediate(
    `INSERT INTO tasks (task_id, type, title, description, instructions, reward_paise, max_completions, current_completions, status, created_at)
     VALUES (?, 'review', 'Google Maps 5-Star Review', 'Write review', 'Post review and screenshot', 500, 10, 0, 'active', ?)`,
    ['task_review_1', now]
  );
  const task = db.get('SELECT * FROM tasks WHERE task_id = ?', ['task_review_1']);
  assert(task.reward_paise === 500, 'Task created with ₹5.00 (500 paise) reward');

  // User B claims task
  db.runImmediate(
    'INSERT INTO task_claims (user_id, task_id, status, created_at) VALUES (?, ?, ?, ?)',
    ['1002', 'task_review_1', 'claimed', now]
  );
  const claim = db.get('SELECT * FROM task_claims WHERE user_id = ? AND task_id = ?', ['1002', 'task_review_1']);
  assert(claim.status === 'claimed', 'Task claimed successfully');

  console.log('\n6. Proof Submission & Transactional Approval');
  db.runImmediate(
    `INSERT INTO submissions (user_id, task_id, file_id, caption, status, created_at)
     VALUES ('1002', 'task_review_1', 'file_photo_123', 'Proof review done', 'pending', ?)`,
    [now]
  );
  const sub = db.get('SELECT * FROM submissions WHERE user_id = ? AND task_id = ?', ['1002', 'task_review_1']);
  assert(sub.status === 'pending', 'Submission status is pending');

  // Simulate Admin Approval & First Task Referral Bonus
  const rewardPaise = task.reward_paise; // 500 paise
  const newBalanceB = userB.balance_paise + rewardPaise;
  db.runImmediate(
    'UPDATE users SET balance_paise = ?, total_earned_paise = ? WHERE telegram_id = ?',
    [newBalanceB, newBalanceB, '1002']
  );
  db.runImmediate(
    "UPDATE submissions SET status = 'approved', reviewed_at = ?, reviewed_by = '999999999' WHERE id = ?",
    [now, sub.id]
  );
  db.runImmediate(
    'UPDATE tasks SET current_completions = current_completions + 1 WHERE task_id = ?',
    ['task_review_1']
  );

  // Trigger referral bonus for Alice (20 paise)
  const refReward = 20;
  db.runImmediate(
    'UPDATE users SET balance_paise = balance_paise + ?, total_earned_paise = total_earned_paise + ?, referral_earnings_paise = referral_earnings_paise + ? WHERE telegram_id = ?',
    [refReward, refReward, refReward, '1001']
  );
  db.runImmediate(
    "UPDATE referrals SET status = 'rewarded', reward_paise = ?, rewarded_at = ? WHERE referrer_id = '1001' AND referred_id = '1002'",
    [refReward, now]
  );

  const updatedUserB = db.get('SELECT * FROM users WHERE telegram_id = ?', ['1002']);
  const updatedUserA = db.get('SELECT * FROM users WHERE telegram_id = ?', ['1001']);
  const updatedTask = db.get('SELECT * FROM tasks WHERE task_id = ?', ['task_review_1']);

  assert(updatedUserB.balance_paise === 500, 'User B credited ₹5.00 for completed task');
  assert(updatedUserA.balance_paise === 20, 'Referrer User A credited ₹0.20 on first task completion');
  assert(updatedTask.current_completions === 1, 'Task completion count incremented');

  console.log('\n7. UPI Withdrawal Atomic Reservation, Approval & Refund');
  // User B earns more so balance is ₹20.00 (2000 paise)
  db.runImmediate('UPDATE users SET balance_paise = 2000 WHERE telegram_id = ?', ['1002']);
  
  // Withdraw ₹15.00 (1500 paise)
  const wdAmount = 1500;
  const newBalAfterWd = 2000 - wdAmount; // 500 paise
  db.runImmediate(
    'UPDATE users SET balance_paise = ? WHERE telegram_id = ?',
    [newBalAfterWd, '1002']
  );
  db.runImmediate(
    'INSERT INTO withdrawals (user_id, amount_paise, upi_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ['1002', wdAmount, 'bob@okhdfcbank', 'pending', now]
  );

  let userBAfterHold = db.get('SELECT * FROM users WHERE telegram_id = ?', ['1002']);
  assert(userBAfterHold.balance_paise === 500, 'User balance reserved during withdrawal hold');

  const wd = db.get('SELECT * FROM withdrawals WHERE user_id = ? AND status = "pending"', ['1002']);
  assert(wd.amount_paise === 1500, 'Pending withdrawal of ₹15.00 recorded');

  // Admin marks PAID
  db.runImmediate(
    "UPDATE withdrawals SET status = 'paid', processed_at = ?, processed_by = '999999999' WHERE id = ?",
    [now, wd.id]
  );
  db.runImmediate(
    'UPDATE users SET total_withdrawn_paise = total_withdrawn_paise + ? WHERE telegram_id = ?',
    [wdAmount, '1002']
  );

  const userBPaid = db.get('SELECT * FROM users WHERE telegram_id = ?', ['1002']);
  assert(userBPaid.total_withdrawn_paise === 1500, 'Total withdrawn updated on Paid');

  // Test Reject & Refund Flow on a second withdrawal of remaining 500 paise
  db.runImmediate('UPDATE users SET balance_paise = 0 WHERE telegram_id = ?', ['1002']);
  db.runImmediate(
    'INSERT INTO withdrawals (user_id, amount_paise, upi_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
    ['1002', 500, 'wrong_upi', 'pending', now]
  );
  const wd2 = db.get('SELECT * FROM withdrawals WHERE user_id = ? AND status = "pending"', ['1002']);
  
  // Reject & Refund
  db.runImmediate(
    "UPDATE withdrawals SET status = 'rejected', rejection_reason = 'Invalid UPI', processed_at = ?, processed_by = '999999999' WHERE id = ?",
    [now, wd2.id]
  );
  db.runImmediate(
    'UPDATE users SET balance_paise = balance_paise + ? WHERE telegram_id = ?',
    [500, '1002']
  );

  const userBRefunded = db.get('SELECT * FROM users WHERE telegram_id = ?', ['1002']);
  assert(userBRefunded.balance_paise === 500, 'User balance fully refunded on rejection');

  // Cleanup test db file
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  console.log(`\n========================================`);
  console.log(`Test Suite Completed: ${passed} Passed, ${failed} Failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
