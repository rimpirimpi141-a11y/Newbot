import http from 'http';
import config from './src/config.js';
import { initDatabase, getDatabase } from './src/database.js';
import { startBotPolling, stopBotPolling } from './src/bot.js';

const PORT = parseInt(process.env.PORT || config.port || '3000', 10);

/**
 * 1. Lightweight HTTP Server for Render Health Checks & Port Binding
 */
const server = http.createServer((req, res) => {
  const url = req.url || '/';

  // Render Web Service root health check and status endpoints
  if (url === '/' || url === '/health' || url === '/api/status') {
    try {
      let stats = { totalUsers: 0, activeTasks: 0, pendingProofs: 0, pendingWithdrawals: 0 };
      try {
        const db = getDatabase();
        stats.totalUsers = db.get('SELECT COUNT(*) as count FROM users')?.count || 0;
        stats.activeTasks = db.get("SELECT COUNT(*) as count FROM tasks WHERE status = 'active'")?.count || 0;
        stats.pendingProofs = db.get("SELECT COUNT(*) as count FROM submissions WHERE status = 'pending'")?.count || 0;
        stats.pendingWithdrawals = db.get("SELECT COUNT(*) as count FROM withdrawals WHERE status = 'pending'")?.count || 0;
      } catch {}

      const responseBody = JSON.stringify({
        status: 'ok',
        service: 'TaskWork Telegram Bot',
        polling: true,
        botConfigured: Boolean(config.botToken && !config.botToken.startsWith('123456789')),
        stats,
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      });
      return res.end(responseBody);
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK');
    }
  }

  // Fallback 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

/**
 * 2. Bootstrap Database & Start Telegram Long Polling
 */
async function main() {
  try {
    console.log('📦 Initializing SQLite Database...');
    await initDatabase();
    console.log('✅ SQLite Database ready.');

    // Start background Telegram long-polling
    await startBotPolling();

    // Start HTTP Server for Render Port Binding
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🌐 HTTP Server listening on port ${PORT} (Render Health Check Ready)`);
      console.log(`🤖 Bot Polling Status: ${config.botToken ? 'Configured' : 'Waiting for BOT_TOKEN'}`);
    });
  } catch (err) {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  }
}

/**
 * 3. Graceful Shutdown & Unhandled Exception Resilience
 */
async function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Gracefully shutting down...`);
  try {
    await stopBotPolling();
    const db = getDatabase();
    if (db && typeof db.persist === 'function') {
      db.persist();
      console.log('💾 Database flushed to disk.');
    }
  } catch (err) {
    console.error('Error during shutdown:', err.message);
  } finally {
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Promise Rejection]:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]:', err);
});

// Launch
main();
