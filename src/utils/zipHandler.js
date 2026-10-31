const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const { execFileSync } = require('child_process');
const logger = require('../utils/logger');

const MAX_COMPRESSED_MB = 500;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 20000;

async function extractZip(zipPath, destPath, loggerInstance = logger) {
  if (!fs.existsSync(destPath)) {
    fs.mkdirSync(destPath, { recursive: true });
  }

  // Prefer the system `unzip` CLI: it is fully spec-compliant and reliably
  // extracts every entry. The `unzipper` streaming extractor (used below as a
  // fallback) occasionally drops files such as src/utils/logger.js, which broke
  // `npm run migrate` inside extracted projects.
  try {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', destPath], { stdio: 'ignore' });
    loggerInstance.info(`ZIP extracted to ${destPath}`);
    return;
  } catch (e) {
    if (e.code === 'ENOENT') {
      loggerInstance.warn('unzip CLI not found; falling back to unzipper stream.');
    } else {
      loggerInstance.warn(`unzip CLI failed (exit ${e.status}), falling back to unzipper: ${e.message || e}`);
    }
  }

  return new Promise((resolve, reject) => {
    const errors = [];

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

      // Ensure parent directories exist (unzipper does not always create them
      // before writing nested files), then extract explicitly.
      if (entry.type !== 'Directory') {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      entry.extract();
    });

    extractStream.on('close', function() {
      if (errors.length > 0) {
        reject(new Error(`Extraction failed: ${errors.join(', ')}`));
      } else {
        loggerInstance.info(`ZIP extracted to ${destPath} (unzipper fallback)`);
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

// Validates every entry of the archive before extraction. Rejects absolute
// paths / `..` traversal, archives with an excessive number of entries and
// zip-bombs (total uncompressed size).
async function validateZip(zipPath) {
  if (!fs.existsSync(zipPath)) {
    throw new Error('ZIP file does not exist');
  }

  const stat = fs.statSync(zipPath);
  const sizeMB = stat.size / (1024 * 1024);
  if (sizeMB > MAX_COMPRESSED_MB) {
    throw new Error(`File too large: ${sizeMB.toFixed(1)}MB (max ${MAX_COMPRESSED_MB}MB)`);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    let entryCount = 0;
    let totalUncompressed = 0;

    const parser = unzipper.Parse({ forceStream: true });
    const input = fs.createReadStream(zipPath);

    input.on('error', fail);
    parser.on('error', fail);

    parser.on('entry', (entry) => {
      const name = entry.path || '';
      const normalized = path.normalize(name);

      if (name.startsWith('/') || name.startsWith('\\') ||
          path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
        entry.autodrain();
        return fail(new Error(`Path traversal detected: ${name}`));
      }

      entryCount += 1;
      if (entryCount > MAX_ENTRIES) {
        entry.autodrain();
        return fail(new Error(`ZIP contains too many entries (max ${MAX_ENTRIES})`));
      }

      totalUncompressed += entry.vars?.uncompressedSize || 0;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
        entry.autodrain();
        return fail(new Error('ZIP expands to too much data (possible zip bomb)'));
      }

      entry.autodrain();
    });

    parser.on('close', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    parser.on('finish', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });

    input.pipe(parser);
  });
}

module.exports = { extractZip, validateZip };
