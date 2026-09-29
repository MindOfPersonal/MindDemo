const { v4: uuidv4 } = require('uuid');

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function generateUniqueSlug(name) {
  return `${generateSlug(name)}-${Math.random().toString(36).substring(2, 8)}`;
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
