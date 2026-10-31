const crypto = require('crypto');
const db = require('../config/database');

// ---------------------------------------------------------------------------
// Server model (MindAgent control plane).
// Only the SHA256 hash of the agent token is stored, never the token itself.
// ---------------------------------------------------------------------------

function generateToken() {
  return `mindagt_${crypto.randomBytes(24).toString('hex')}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

class Server {
  static generateToken() {
    return generateToken();
  }

  static hashToken(token) {
    return hashToken(token);
  }

  static async create({ name, server_url, control_url, token, notes, is_pinned, allow_failover }) {
    const result = await db.query(
      `INSERT INTO servers (name, server_url, control_url, token_hash, status, notes, is_pinned, allow_failover)
       VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?)`,
      [name, server_url || null, control_url || null, hashToken(token), notes || null,
       is_pinned ? 1 : 0, allow_failover ? 1 : 0]
    );
    return result.insertId;
  }

  static async findAll() {
    return db.query('SELECT * FROM servers ORDER BY created_at DESC');
  }

  static async findById(id) {
    const rows = await db.query('SELECT * FROM servers WHERE id = ?', [id]);
    return rows[0];
  }

  static async findByTokenHash(tokenHash) {
    const rows = await db.query('SELECT * FROM servers WHERE token_hash = ?', [tokenHash]);
    return rows[0];
  }

  static async update(id, data) {
    const allowed = ['name', 'server_url', 'control_url', 'notes', 'is_pinned', 'allow_failover'];
    const fields = [];
    const values = [];
    for (const [key, value] of Object.entries(data)) {
      if (!allowed.includes(key) || value === undefined) continue;
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (!fields.length) return;
    values.push(id);
    await db.query(`UPDATE servers SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  static async updateToken(id, token) {
    await db.query('UPDATE servers SET token_hash = ? WHERE id = ?', [hashToken(token), id]);
  }

  static async updateStatus(id, status) {
    await db.query('UPDATE servers SET status = ?, last_seen = NOW() WHERE id = ?', [status, id]);
  }

  static async touch(id) {
    await db.query('UPDATE servers SET last_seen = NOW() WHERE id = ?', [id]);
  }

  static async updateAgentInfo(id, { status, agent_version, docker_version }) {
    await db.query(
      `UPDATE servers
       SET status = COALESCE(?, status), agent_version = COALESCE(?, agent_version),
           docker_version = COALESCE(?, docker_version), last_seen = NOW()
       WHERE id = ?`,
      [status || null, agent_version || null, docker_version || null, id]
    );
  }

  static async delete(id) {
    const server = await this.findById(id);
    await db.query('DELETE FROM servers WHERE id = ?', [id]);
    return server;
  }

  // A server that has not sent a heartbeat recently is considered offline.
  static async markStaleOffline(timeoutSeconds = 45) {
    return db.query(
      `UPDATE servers SET status = 'offline'
       WHERE status IN ('online', 'degraded', 'updating')
       AND (last_seen IS NULL OR last_seen < DATE_SUB(NOW(), INTERVAL ? SECOND))`,
      [timeoutSeconds]
    );
  }
}

module.exports = Server;
