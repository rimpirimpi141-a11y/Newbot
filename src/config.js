import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

const config = {
  botToken: process.env.BOT_TOKEN || '',
  adminTelegramId: process.env.ADMIN_TELEGRAM_ID ? String(process.env.ADMIN_TELEGRAM_ID).trim() : '',
  supportUsername: (process.env.SUPPORT_USERNAME || 'Support').replace(/^@/, ''),
  dbPath: process.env.DB_PATH || path.join(process.cwd(), 'data', 'taskwork.db'),
  port: parseInt(process.env.PORT || '3000', 10),
  defaultMinimumWithdrawalPaise: 1500, // ₹15.00
  defaultReferralRewardPaise: 20, // ₹0.20
};

// Ensure data directory exists
const dbDir = path.dirname(path.resolve(config.dbPath));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export default config;
