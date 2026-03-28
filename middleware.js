function requireAuth(req, res, next) {
  if (req.session && req.session.user) next();
  else res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && ['admin','owner','coowner'].includes(req.session.user.role)) next();
  else res.status(403).send('<div style="font-family:monospace;text-align:center;padding:50px;"><h1>403</h1><p>Только для администрации.</p><a href="/">Назад</a></div>');
}

function requireOwner(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'owner') next();
  else res.status(403).send('<div style="font-family:monospace;text-align:center;padding:50px;"><h1>403</h1><p>Только для владельца.</p><a href="/">Назад</a></div>');
}

function addUserToViews(req, res, next) {
  res.locals.currentUser = req.session ? req.session.user || null : null;
  next();
}

module.exports = { requireAuth, requireAdmin, requireOwner, addUserToViews };