const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, '..', '..', 'storage', 'logs');

if (!fs.existsSync(logPath)) {
  fs.mkdirSync(logPath, { recursive: true });
}

const logFile = path.join(logPath, 'minddemo.log');

function timestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

function log(level, message, ...args) {
  const line = `${timestamp()} [${level}]: ${message}`;
  
  if (args.length > 0) {
    try {
      const parts = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a));
      console.log(`${line} ${parts.join(' ')}`);
      fs.appendFileSync(logFile, `${line} ${parts.join(' ')}\n`);
    } catch {
      console.log(line);
      fs.appendFileSync(logFile, `${line}\n`);
    }
  } else {
    console.log(line);
    fs.appendFileSync(logFile, `${line}\n`);
  }
}

const logger = {
  info: (msg, ...args) => log('INFO', msg, ...args),
  error: (msg, ...args) => log('ERROR', msg, ...args),
  warn: (msg, ...args) => log('WARN', msg, ...args),
  debug: (msg, ...args) => log('DEBUG', msg, ...args)
};

module.exports = logger;
