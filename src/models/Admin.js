const bcrypt = require('bcrypt');
const db = require('../config/database');
const logger = require('../utils/logger');

class Admin {
  static async findByUsername(username) {
    const rows = await db.query(
      'SELECT id, username, password_hash, created_at, last_login FROM admins WHERE username = ?',
      [username]
    );
    return rows[0];
  }

  static async authenticate(username, password) {
    const admin = await this.findByUsername(username);
    if (!admin) {
      return null;
    }
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return null;
    }
    return admin;
  }

  static async updateLastLogin(id) {
    await db.query(
      'UPDATE admins SET last_login = NOW() WHERE id = ?',
      [id]
    );
  }
}

module.exports = Admin;
