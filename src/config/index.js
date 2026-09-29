const path = require('path');

module.exports = {
  PORT: process.env.PORT || 3050,
  APP_URL: process.env.APP_URL || 'http://localhost:3050',
  NODE_ENV: process.env.NODE_ENV || 'production',
  SESSION_SECRET: process.env.SESSION_SECRET || 'default_secret',
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
  DOCKER_SOCKET: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  UPLOAD_PATH: path.join(__dirname, '..', '..', 'storage', 'uploads'),
  PROJECTS_PATH: path.join(__dirname, '..', '..', 'storage', 'projects'),
  BASELINES_PATH: path.join(__dirname, '..', '..', 'storage', 'baselines'),
  SESSIONS_PATH: path.join(__dirname, '..', '..', 'storage', 'sessions'),
  LOGS_PATH: path.join(__dirname, '..', '..', 'storage', 'logs')
};
