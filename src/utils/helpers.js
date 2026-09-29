const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

function generateSlug(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'demo';
}

function generateUniqueSlug(name) {
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${generateSlug(name)}-${suffix}`;
}

function generateSessionToken() {
  return uuidv4().replace(/-/g, '').substring(0, 12);
}

function generateVisitorToken() {
  return uuidv4();
}

module.exports = {
  generateSlug,
  generateUniqueSlug,
  generateSessionToken,
  generateVisitorToken
};
