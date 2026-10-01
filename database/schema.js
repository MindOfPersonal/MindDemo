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

CREATE TABLE IF NOT EXISTS \`servers\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`name\` VARCHAR(128) NOT NULL,
  \`server_url\` VARCHAR(255),
  \`control_url\` VARCHAR(255),
  \`token_hash\` CHAR(64) NOT NULL,
  \`status\` ENUM('unknown','online','offline','updating','error','maintenance','degraded') DEFAULT 'unknown',
  \`agent_version\` VARCHAR(32),
  \`docker_version\` VARCHAR(32),
  \`last_seen\` TIMESTAMP NULL,
  \`is_pinned\` TINYINT(1) DEFAULT 0,
  \`allow_failover\` TINYINT(1) DEFAULT 0,
  \`notes\` TEXT,
  \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`agent_commands\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`server_id\` INT UNSIGNED NOT NULL,
  \`command_id\` VARCHAR(64) NOT NULL UNIQUE,
  \`type\` VARCHAR(64) NOT NULL,
  \`payload\` JSON,
  \`status\` ENUM('pending','sent','done','failed','timeout') DEFAULT 'pending',
  \`result\` JSON,
  \`error_code\` VARCHAR(64),
  \`error_message\` TEXT,
  \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`started_at\` TIMESTAMP NULL,
  \`completed_at\` TIMESTAMP NULL,
  \`created_by\` VARCHAR(64),
  INDEX \`idx_agent_commands_server\` (\`server_id\`, \`created_at\`),
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`server_metrics\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`server_id\` INT UNSIGNED NOT NULL,
  \`cpu_percent\` DECIMAL(5,2),
  \`cpu_cores\` INT UNSIGNED,
  \`load_avg_1\` DECIMAL(6,2),
  \`memory_total_mb\` INT UNSIGNED,
  \`memory_used_mb\` INT UNSIGNED,
  \`disk_total_gb\` INT UNSIGNED,
  \`disk_used_gb\` INT UNSIGNED,
  \`running_demos\` INT UNSIGNED,
  \`free_slots\` INT UNSIGNED,
  \`recorded_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX \`idx_server_metrics\` (\`server_id\`, \`recorded_at\`),
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`demos\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`name\` VARCHAR(128) NOT NULL,
  \`slug\` VARCHAR(128) NOT NULL UNIQUE,
  \`description\` TEXT,
  \`project_path\` VARCHAR(512),
  \`baseline_path\` VARCHAR(512),
  \`server_id\` INT UNSIGNED NULL,
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
  \`server_id\` INT UNSIGNED NULL,
  \`agent_command_id\` VARCHAR(64) NULL,
  \`status\` ENUM('active', 'inactive', 'ending', 'stopped') DEFAULT 'active',
  \`started_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`last_activity\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`last_seen\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`ended_at\` TIMESTAMP NULL,
  INDEX \`idx_demo_status\` (\`demo_id\`, \`status\`),
  INDEX \`idx_last_activity\` (\`last_activity\`),
  INDEX \`idx_last_seen\` (\`last_seen\`),
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

// Additive migrations for existing installations. `CREATE TABLE IF NOT EXISTS`
// never adds columns to a table that already exists, so new columns are applied
// explicitly here. Each change is checked against information_schema first, so
// running this repeatedly is safe.
async function columnExists(table, column) {
  const rows = await db.query(
    `SELECT COUNT(*) AS count FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
    [process.env.DB_NAME, table, column]
  );
  return rows[0].count > 0;
}

async function addColumnIfMissing(table, column, definition) {
  if (await columnExists(table, column)) return false;
  await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  logger.info(`Migration: added ${table}.${column}`);
  return true;
}

async function migrate() {
  await addColumnIfMissing('demos', 'server_id', 'INT UNSIGNED NULL');
  await addColumnIfMissing('demo_sessions', 'server_id', 'INT UNSIGNED NULL');
  await addColumnIfMissing('demo_sessions', 'agent_command_id', 'VARCHAR(64) NULL');
  // last_seen tracks page presence (polling) while last_activity tracks real
  // visitor interaction. Keeping them apart lets an idle-but-open tab expire
  // on the inactivity timeout instead of being kept alive by its own polls.
  await addColumnIfMissing('demo_sessions', 'last_seen', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
}

async function initialize() {
  try {
    const statements = schema.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        await db.query(stmt.trim());
      }
    }
    await migrate();
    logger.info('Database initialized successfully');
  } catch (err) {
    logger.error('Database initialization failed:', err.message);
    process.exit(1);
  }
}

async function createDefaultAdmin() {
  try {
    if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
      logger.warn('ADMIN_USERNAME/ADMIN_PASSWORD not set; skipping default admin creation');
      return;
    }

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
