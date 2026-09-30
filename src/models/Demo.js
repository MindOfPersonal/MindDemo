const db = require('../config/database');
const { generateUniqueSlug } = require('../utils/helpers');
const logger = require('../utils/logger');

class Demo {
  static async create(data) {
    const {
      name,
      slug,
      description,
      project_path,
      baseline_path,
      start_command,
      install_command,
      build_command,
      internal_port = 3000,
      timeout_minutes,
      env_vars,
      show_credentials,
      banner_enabled,
      landing_page,
      demo_username,
      demo_email,
      demo_password,
      server_id
    } = data;

    const finalSlug = slug || generateUniqueSlug(name);

    const result = await db.query(
      `INSERT INTO demos 
       (name, slug, description, project_path, baseline_path, status, start_command, 
        install_command, build_command, internal_port, timeout_minutes, env_vars,
        demo_username, demo_email, demo_password, show_credentials, banner_enabled, landing_page, server_id)
       VALUES (?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
       [name, finalSlug, description || null, project_path, baseline_path, start_command || 'npm start',
       install_command || null, build_command || null, internal_port, timeout_minutes,
       JSON.stringify(env_vars || {}), demo_username || null, demo_email || null, demo_password || null,
       show_credentials || 'auto', banner_enabled ? 1 : 0, landing_page ? 1 : 0, server_id || null]
    );

    logger.info(`Demo created: ${name} (slug: ${finalSlug}, id: ${result.insertId})`);
    return { id: result.insertId, slug: finalSlug, ...data };
  }

  static async findAll() {
    return db.query('SELECT * FROM demos ORDER BY created_at DESC');
  }

  static async findById(id) {
    const rows = await db.query('SELECT * FROM demos WHERE id = ?', [id]);
    return rows[0];
  }

  static async findBySlug(slug) {
    const rows = await db.query('SELECT * FROM demos WHERE slug = ?', [slug]);
    return rows[0];
  }

  static async update(id, data) {
    const ALLOWED = new Set([
      'name', 'slug', 'description', 'start_command', 'install_command',
      'build_command', 'internal_port', 'timeout_minutes', 'env_vars',
      'demo_username', 'demo_email', 'demo_password', 'show_credentials',
      'banner_enabled', 'landing_page', 'status', 'server_id'
    ]);
    const fields = [];
    const values = [];
    
    for (const [key, value] of Object.entries(data)) {
      if (key === 'id' || value === undefined || !ALLOWED.has(key)) continue;
      fields.push(`${key} = ?`);
      values.push(typeof value === 'object' && value !== null ? JSON.stringify(value) : value);
    }
    
    if (fields.length === 0) return;
    
    values.push(id);
    await db.query(`UPDATE demos SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  static async updateStatus(id, status) {
    await db.query('UPDATE demos SET status = ? WHERE id = ?', [status, id]);
  }

  static async delete(id) {
    const demo = await this.findById(id);
    await db.query('DELETE FROM demos WHERE id = ?', [id]);
    if (demo) {
      logger.info(`Demo deleted: ${demo.name} (slug: ${demo.slug})`);
    }
    return demo;
  }
}

module.exports = Demo;
