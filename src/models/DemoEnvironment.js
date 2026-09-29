const db = require('../config/database');

class DemoEnvironment {
  static async set(demoId, key, value, isSecret = false) {
    await db.query(
      'REPLACE INTO demo_environment (demo_id, `key`, `value`, is_secret) VALUES (?, ?, ?, ?)',
      [demoId, key, value, isSecret ? 1 : 0]
    );
  }

  static async getByDemoId(demoId) {
    const rows = await db.query(
      'SELECT `key`, `value`, is_secret FROM demo_environment WHERE demo_id = ?',
      [demoId]
    );
    return rows;
  }

  static async getEnvVarsForContainer(demoId) {
    const rows = await this.getByDemoId(demoId);
    const env = {};
    for (const row of rows) {
      env[row.key] = row.value;
    }
    env.DEMO_MODE = 'true';
    return env;
  }
}

module.exports = DemoEnvironment;
