const db = require('../config/database');

// ---------------------------------------------------------------------------
// Audit + tracking of commands sent to agents. The command_id makes every
// command idempotent end to end.
// ---------------------------------------------------------------------------

class AgentCommand {
  static async create({ server_id, command_id, type, payload, created_by }) {
    await db.query(
      `INSERT INTO agent_commands (server_id, command_id, type, payload, status, created_by)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [server_id, command_id, type, JSON.stringify(payload || {}), created_by || null]
    );
  }

  static async markSent(commandId) {
    await db.query(
      "UPDATE agent_commands SET status = 'sent', started_at = NOW() WHERE command_id = ? AND status = 'pending'",
      [commandId]
    );
  }

  static async markDone(commandId, result) {
    await db.query(
      "UPDATE agent_commands SET status = 'done', result = ?, completed_at = NOW() WHERE command_id = ?",
      [JSON.stringify(result || {}), commandId]
    );
  }

  static async markFailed(commandId, error_code, error_message, result) {
    await db.query(
      `UPDATE agent_commands SET status = 'failed', error_code = ?, error_message = ?, result = ?, completed_at = NOW()
       WHERE command_id = ?`,
      [error_code || null, error_message || null, JSON.stringify(result || {}), commandId]
    );
  }

  static async markTimeout(commandId) {
    await db.query(
      "UPDATE agent_commands SET status = 'timeout', completed_at = NOW() WHERE command_id = ? AND status IN ('pending','sent')",
      [commandId]
    );
  }

  static async findByCommandId(commandId) {
    const rows = await db.query('SELECT * FROM agent_commands WHERE command_id = ?', [commandId]);
    return rows[0];
  }

  static async findRecentByServer(serverId, limit = 50) {
    return db.query(
      'SELECT * FROM agent_commands WHERE server_id = ? ORDER BY created_at DESC LIMIT ?',
      [serverId, limit]
    );
  }

  static async findAll(limit = 100) {
    return db.query('SELECT * FROM agent_commands ORDER BY created_at DESC LIMIT ?', [limit]);
  }
}

module.exports = AgentCommand;
