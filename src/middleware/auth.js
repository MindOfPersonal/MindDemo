function authRequired(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  if (req.path.startsWith('/api/admin/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  res.redirect('/admin/login');
}

function guestOnly(req, res, next) {
  if (req.session && req.session.adminId) {
    return res.redirect('/admin/dashboard');
  }
  next();
}

module.exports = { authRequired, guestOnly };
