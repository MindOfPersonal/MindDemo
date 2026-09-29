const db = require('../config/database');
const logger = require('../utils/logger');

class DemoSession {
  static async create(data) {
    const { demo_id, session_token, container_id, container_port } = data;
    const result = await db.query(
      'INSERT INTO demo_sessions (demo_id, session_token, container_id, container_port, status) VALUES (?, ?, ?, ?, "active")',
      [demo_id, session_token, container_id, container_port]
    );
    return result.insertId;
  }

  static async findByToken(token) {
    const rows = await db.query('SELECT * FROM demo_sessions WHERE session_token = ?', [token]);
    return rows[0];
  }

  static async findById(id) {
    const rows = await db.query('SELECT * FROM demo_sessions WHERE id = ?', [id]);
    return rows[0];
  }

  static async updateActivity(id) {
    await db.query(
      'UPDATE demo_sessions SET last_activity = NOW() WHERE id = ?',
      [id]
    );
  }

  static async updateStatus(id, status) {
    const updates = { active: 'SET status = ?, last_activity = NOW()', inactive: 'SET status = ?, last_activity = NOW()' };
    await db.query(`UPDATE demo_sessions ${updates[status] || 'SET status = ?'} WHERE id = ?`, [status, id]);
  }

  static async end(id) {
    await db.query(
      'UPDATE demo_sessions SET status = "stopped", ended_at = NOW() WHERE id = ?',
      [id]
    );
  }

  static async endAllForDemo(demoId) {
    return db.query(
      'UPDATE demo_sessions SET status = "stopped", ended_at = NOW() ' +
      'WHERE demo_id = ? AND status IN ("active", "inactive")',
      [demoId]
    );
  }

  static async updateContainerInfo(id, { container_id, container_port }) {
    await db.query(
      'UPDATE demo_sessions SET container_id = ?, container_port = ? WHERE id = ?',
      [container_id, container_port, id]
    );
  }

  static async findActiveByDemoId(demoId) {
    return db.query(
      'SELECT * FROM demo_sessions WHERE demo_id = ? AND status IN ("active", "inactive")',
      [demoId]
    );
  }

  static async findExpiredSessions() {
    return db.query(
      `SELECT s.*, d.timeout_minutes FROM demo_sessions s 
       JOIN demos d ON s.demo_id = d.id 
       WHERE s.status IN ("active", "inactive") 
       AND s.last_activity < DATE_SUB(NOW(), INTERVAL d.timeout_minutes MINUTE)`
    );
  }

  static async countActive() {
    const rows = await db.query(
      'SELECT COUNT(*) AS count FROM demo_sessions WHERE status IN ("active", "inactive")'
    );
    return rows[0] ? rows[0].count : 0;
  }

  // Sessions that stopped sending heartbeats (visitor closed the page). The
  // grace window is intentionally short so closed tabs free their container
  // quickly, independent of the longer per-demo inactivity timeout.
  static async findStaleSessions(graceSeconds = 60) {
    const seconds = Math.max(1, parseInt(graceSeconds, 10) || 60);
    return db.query(
      `SELECT * FROM demo_sessions
       WHERE status IN ("active", "inactive")
       AND last_activity < DATE_SUB(NOW(), INTERVAL ${seconds} SECOND)`
    );
  }

  static async delete(id) {
    await db.query('DELETE FROM demo_sessions WHERE id = ?', [id]);
  }
}

module.exports = DemoSession;
