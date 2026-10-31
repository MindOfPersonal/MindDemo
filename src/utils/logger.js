const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, '..', '..', 'storage', 'logs');

if (!fs.existsSync(logPath)) {
  fs.mkdirSync(logPath, { recursive: true });
}

const logFile = path.join(logPath, 'minddemo.log');

// Asynchronous append stream instead of appendFileSync on every line, so
// logging does not block the event loop under load.
const stream = fs.createWriteStream(logFile, { flags: 'a' });
stream.on('error', (err) => {
  console.error(`Log stream error: ${err.message}`);
});

function timestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

function log(level, message, ...args) {
  let line = `${timestamp()} [${level}]: ${message}`;

  if (args.length > 0) {
    try {
      const parts = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a));
      line += ` ${parts.join(' ')}`;
    } catch {
      // Keep the base line if an argument cannot be serialized.
    }
  }

  console.log(line);
  stream.write(`${line}\n`);
}

const logger = {
  info: (msg, ...args) => log('INFO', msg, ...args),
  error: (msg, ...args) => log('ERROR', msg, ...args),
  warn: (msg, ...args) => log('WARN', msg, ...args),
  debug: (msg, ...args) => log('DEBUG', msg, ...args)
};

module.exports = logger;
