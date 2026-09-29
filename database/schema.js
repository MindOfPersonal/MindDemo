const db = require('../src/config/database');
const logger = require('../src/utils/logger');
const bcrypt = require('bcrypt');

const schema = `
CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\`;

USE \`${process.env.DB_NAME}\`;

CREATE TABLE IF NOT EXISTS \`admins\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`username\` VARCHAR(64) NOT NULL UNIQUE,
  \`password_hash\` VARCHAR(255) NOT NULL,
  \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`last_login\` TIMESTAMP NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`demos\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`name\` VARCHAR(128) NOT NULL,
  \`slug\` VARCHAR(128) NOT NULL UNIQUE,
  \`description\` TEXT,
  \`project_path\` VARCHAR(512),
  \`baseline_path\` VARCHAR(512),
  \`status\` ENUM('stopped', 'running', 'building', 'error') DEFAULT 'stopped',
  \`start_command\` VARCHAR(255),
  \`install_command\` VARCHAR(255),
  \`build_command\` VARCHAR(255),
  \`internal_port\` INT UNSIGNED DEFAULT 3000,
  \`timeout_minutes\` INT UNSIGNED DEFAULT 30,
  \`max_sessions\` INT UNSIGNED DEFAULT 10,
  \`memory_limit\` VARCHAR(32) DEFAULT '512m',
  \`cpu_limit\` VARCHAR(32) DEFAULT '1',
  \`disk_limit\` VARCHAR(32) DEFAULT '1g',
  \`env_vars\` JSON,
  \`demo_username\` VARCHAR(64),
  \`demo_email\` VARCHAR(255),
  \`demo_password\` VARCHAR(255),
  \`show_credentials\` ENUM('auto', 'hidden', 'button', 'panel') DEFAULT 'auto',
  \`banner_enabled\` TINYINT(1) DEFAULT 0,
  \`landing_page\` TINYINT(1) DEFAULT 0,
  \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`demo_sessions\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`demo_id\` INT UNSIGNED NOT NULL,
  \`session_token\` VARCHAR(128) NOT NULL UNIQUE,
  \`container_id\` VARCHAR(128),
  \`container_port\` INT UNSIGNED,
  \`status\` ENUM('active', 'inactive', 'ending', 'stopped') DEFAULT 'active',
  \`started_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`last_activity\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`ended_at\` TIMESTAMP NULL,
  INDEX \`idx_demo_status\` (\`demo_id\`, \`status\`),
  INDEX \`idx_last_activity\` (\`last_activity\`),
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`demo_environment\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`demo_id\` INT UNSIGNED NOT NULL,
  \`key\` VARCHAR(128) NOT NULL,
  \`value\` TEXT,
  \`is_secret\` TINYINT(1) DEFAULT 0,
  UNIQUE KEY \`unique_demo_key\` (\`demo_id\`, \`key\`),
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`demo_logs\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`demo_id\` INT UNSIGNED,
  \`session_id\` INT UNSIGNED,
  \`level\` ENUM('info', 'warn', 'error') DEFAULT 'info',
  \`message\` TEXT NOT NULL,
  \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX \`idx_demo_logs\` (\`demo_id\`, \`created_at\`),
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`demo_stats\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`demo_id\` INT UNSIGNED NOT NULL,
  \`session_id\` INT UNSIGNED,
  \`cpu_usage\` DECIMAL(5,2),
  \`memory_usage\` VARCHAR(64),
  \`disk_usage\` VARCHAR(64),
  \`uptime_seconds\` INT UNSIGNED,
  \`recorded_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`demo_visitors\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`demo_id\` INT UNSIGNED NOT NULL,
  \`session_id\` INT UNSIGNED,
  \`visitor_token\` VARCHAR(128) NOT NULL,
  \`ip_address\` VARCHAR(45),
  \`user_agent\` TEXT,
  \`first_seen\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`last_seen\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function initialize() {
  try {
    const statements = schema.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        await db.query(stmt.trim());
      }
    }
    logger.info('Database initialized successfully');
  } catch (err) {
    logger.error('Database initialization failed:', err.message);
    process.exit(1);
  }
}

async function createDefaultAdmin() {
  try {
    const existing = await db.query(
      'SELECT COUNT(*) as count FROM admins WHERE username = ?',
      [process.env.ADMIN_USERNAME]
    );

    if (existing[0].count === 0) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
      await db.query(
        'INSERT INTO admins (username, password_hash) VALUES (?, ?)',
        [process.env.ADMIN_USERNAME, hash]
      );
      logger.info(`Default admin account created with username: ${process.env.ADMIN_USERNAME}`);
    }
  } catch (err) {
    logger.error('Failed to create default admin:', err.message);
  }
}

module.exports = {
  initialize,
  createDefaultAdmin
};
