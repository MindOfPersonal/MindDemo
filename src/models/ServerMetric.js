const db = require('../config/database');

class ServerMetric {
  static async record(serverId, metrics = {}) {
    await db.query(
      `INSERT INTO server_metrics
        (server_id, cpu_percent, cpu_cores, load_avg_1, memory_total_mb, memory_used_mb,
         disk_total_gb, disk_used_gb, running_demos, free_slots)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        serverId,
        metrics.cpu_percent || null,
        metrics.cpu_cores || null,
        metrics.load_avg_1 || null,
        metrics.memory_total_mb || null,
        metrics.memory_used_mb || null,
        metrics.disk_total_gb || null,
        metrics.disk_used_gb || null,
        metrics.running_demos || null,
        metrics.free_slots || null
      ]
    );
  }

  static async getRecent(serverId, limit = 100) {
    return db.query(
      'SELECT * FROM server_metrics WHERE server_id = ? ORDER BY recorded_at DESC LIMIT ?',
      [serverId, limit]
    );
  }

  static async getLatest(serverId) {
    const rows = await db.query(
      'SELECT * FROM server_metrics WHERE server_id = ? ORDER BY recorded_at DESC LIMIT 1',
      [serverId]
    );
    return rows[0];
  }
}

module.exports = ServerMetric;
