const mysql = require('mysql2/promise');
const logger = require('../utils/logger');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 10,
  idleTimeout: 60000,
  queueLimit: 0,
  enableKeepAlive: true
});

pool.on('error', (err) => {
  logger.error('Database pool error:', err);
});

async function query(sql, params) {
  const start = Date.now();
  try {
    const [rows] = await pool.execute(sql, params);
    const duration = Date.now() - start;
    logger.debug(`Query executed in ${duration}ms: ${sql.substring(0, 80)}`);
    return rows;
  } catch (err) {
    const duration = Date.now() - start;
    logger.error(`Query failed after ${duration}ms: ${err.message}`);
    throw err;
  }
}

module.exports = {
  pool,
  query,
  execute: (sql, params) => pool.execute(sql, params)
};
