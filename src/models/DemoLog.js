const db = require('../config/database');

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
    return db.query(
      'SELECT * FROM demo_logs WHERE demo_id = ? ORDER BY created_at DESC LIMIT ?',
      [demoId, limit]
    );
  }

  static async getAll(limit = 500) {
    return db.query(
      `SELECT dl.*, d.name as demo_name FROM demo_logs dl 
       LEFT JOIN demos d ON dl.demo_id = d.id 
       ORDER BY dl.created_at DESC LIMIT ?`,
      [limit]
    );
  }

  static async clear(demoId) {
    await db.query('DELETE FROM demo_logs WHERE demo_id = ?', [demoId]);
  }
}

module.exports = DemoLog;
