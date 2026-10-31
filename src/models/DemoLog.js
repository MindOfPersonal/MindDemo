const db = require('../config/database');

function safeLimit(limit, fallback = 1000, max = 10000) {
  const n = parseInt(limit, 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

class DemoLog {
  static async add(data) {
    const { demo_id, session_id, level, message } = data;
    const result = await db.query(
      'INSERT INTO demo_logs (demo_id, session_id, level, message) VALUES (?, ?, ?, ?)',
      [demo_id || null, session_id || null, level || 'info', message]
    );
    return result.insertId;
  }

  static async getByDemoId(demoId, limit = 1000) {
    // LIMIT is interpolated as a validated integer: a `LIMIT ?` placeholder is
    // not reliably supported by prepared statements on MariaDB/MySQL.
    return db.query(
      `SELECT * FROM demo_logs WHERE demo_id = ? ORDER BY created_at DESC LIMIT ${safeLimit(limit)}`,
      [demoId]
    );
  }

  static async getAll(limit = 500) {
    return db.query(
      `SELECT dl.*, d.name as demo_name FROM demo_logs dl 
       LEFT JOIN demos d ON dl.demo_id = d.id 
       ORDER BY dl.created_at DESC LIMIT ${safeLimit(limit, 500)}`
    );
  }

  static async clear(demoId) {
    await db.query('DELETE FROM demo_logs WHERE demo_id = ?', [demoId]);
  }

  static async getBySessionId(sessionId, limit = 1000) {
    return db.query(
      `SELECT * FROM demo_logs WHERE session_id = ? ORDER BY created_at ASC LIMIT ${safeLimit(limit)}`,
      [sessionId]
    );
  }
}

module.exports = DemoLog;
