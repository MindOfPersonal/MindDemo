const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const logger = require('../utils/logger');

async function extractZip(zipPath, destPath, loggerInstance = logger) {
  return new Promise((resolve, reject) => {
    const errors = [];

    if (!fs.existsSync(destPath)) {
      fs.mkdirSync(destPath, { recursive: true });
    }

    const extractStream = unzipper.Extract({ path: destPath });

    extractStream.on('entry', function(entry) {
      const filePath = path.join(destPath, entry.path);
      const relativePath = path.relative(destPath, filePath);
      const normalized = path.normalize(relativePath);

      if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
        loggerInstance.error(`Path traversal attempt detected: ${entry.path}`);
        errors.push(`Path traversal detected: ${entry.path}`);
        entry.autodrain();
        return;
      }

      entry.extract();
    });

    extractStream.on('close', function() {
      if (errors.length > 0) {
        reject(new Error(`Extraction failed: ${errors.join(', ')}`));
      } else {
        loggerInstance.info(`ZIP extracted to ${destPath}`);
        resolve();
      }
    });

    extractStream.on('error', function(err) {
      loggerInstance.error('Extraction error:', err);
      reject(err);
    });

    fs.createReadStream(zipPath).pipe(extractStream);
  });
}

async function validateZip(zipPath) {
  return new Promise((resolve, reject) => {
    const errors = [];

    if (!fs.existsSync(zipPath)) {
      return reject(new Error('ZIP file does not exist'));
    }

    const stat = fs.statSync(zipPath);
    const sizeMB = stat.size / (1024 * 1024);

    if (sizeMB > 500) {
      errors.push(`File too large: ${sizeMB.toFixed(1)}MB (max 500MB)`);
    }

    fs.createReadStream(zipPath)
      .pipe(unzipper.ParseOne())
      .on('entry', (entry) => {
        const path = entry.path;
        if (path.includes('..') || path.startsWith('/')) {
          errors.push(`Path traversal detected: ${path}`);
        }
        entry.autodrain();
      })
      .on('close', () => {
        if (errors.length > 0) {
          reject(new Error(errors.join('; ')));
        } else {
          resolve();
        }
      })
      .on('error', reject);
  });
}

module.exports = { extractZip, validateZip };
