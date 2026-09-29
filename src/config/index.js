require('dotenv').config();
const path = require('path');

const NODE_ENV = process.env.NODE_ENV || 'production';
const SESSION_SECRET = process.env.SESSION_SECRET;

if (
  NODE_ENV === 'production' &&
  (!SESSION_SECRET || SESSION_SECRET === 'default_secret' || SESSION_SECRET === 'change_this_secret_key')
) {
  throw new Error('SESSION_SECRET must be set to a strong, unique value in production');
}

module.exports = {
  PORT: process.env.PORT || 3050,
  APP_URL: process.env.APP_URL || 'http://localhost:3050',
  NODE_ENV,
  SESSION_SECRET: SESSION_SECRET || 'default_secret',
  DB: {
    HOST: process.env.DB_HOST || 'localhost',
    PORT: process.env.DB_PORT || 3306,
    NAME: process.env.DB_NAME || 'minddemo',
    USER: process.env.DB_USER || 'minddemo',
    PASSWORD: process.env.DB_PASSWORD || ''
  },
  DEMO_DEFAULT_TIMEOUT: parseInt(process.env.DEMO_DEFAULT_TIMEOUT || '30'),
  DEMO_MAX_UPLOAD_SIZE: parseInt(process.env.DEMO_MAX_UPLOAD_SIZE || '500'),
  DEMO_MAX_SESSIONS: parseInt(process.env.DEMO_MAX_SESSIONS || '10'),
  DEMO_SESSION_GRACE_SECONDS: parseInt(process.env.DEMO_SESSION_GRACE_SECONDS || '60'),
  DOCKER_SOCKET: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  AGENT: {
    ENABLED: process.env.AGENT_ENABLED !== 'false',
    COMMAND_TIMEOUT_MS: parseInt(process.env.AGENT_COMMAND_TIMEOUT_MS || '60000'),
    IMAGE_PUSH_MAX_MB: parseInt(process.env.AGENT_IMAGE_PUSH_MAX_MB || '2000'),
    RELEASE_URL: process.env.AGENT_RELEASE_URL || 'https://get.minddevelopment.nl/agent',
    OFFLINE_AFTER_SECONDS: parseInt(process.env.AGENT_OFFLINE_AFTER_SECONDS || '45')
  },
  DISCORD: {
    // The webhook is only active when a URL is configured and it is not
    // explicitly disabled. `DISCORD_WEBHOOK_ENABLED=false` mutes all output
    // without having to remove the URL (handy for local development).
    ENABLED: process.env.DISCORD_WEBHOOK_ENABLED !== 'false',
    WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
    USERNAME: process.env.DISCORD_WEBHOOK_USERNAME || 'MindDemo',
    AVATAR_URL: process.env.DISCORD_WEBHOOK_AVATAR || '',
    // Comma-separated allow-list of event keys, or '*' for everything.
    EVENTS: process.env.DISCORD_WEBHOOK_EVENTS || '*',
    // Discord allows ~30 requests/minute per webhook. A small gap between
    // messages plus a queue keeps us safely below the rate limit.
    MIN_INTERVAL_MS: parseInt(process.env.DISCORD_WEBHOOK_MIN_INTERVAL_MS || '1100'),
    MAX_QUEUE: parseInt(process.env.DISCORD_WEBHOOK_MAX_QUEUE || '200'),
    // Optional role/user id to ping on high-severity events (errors/security).
    MENTION: process.env.DISCORD_WEBHOOK_MENTION || ''
  },
  UPLOAD_PATH: path.join(__dirname, '..', '..', 'storage', 'uploads'),
  PROJECTS_PATH: path.join(__dirname, '..', '..', 'storage', 'projects'),
  BASELINES_PATH: path.join(__dirname, '..', '..', 'storage', 'baselines'),
  SESSIONS_PATH: path.join(__dirname, '..', '..', 'storage', 'sessions'),
  LOGS_PATH: path.join(__dirname, '..', '..', 'storage', 'logs')
};
