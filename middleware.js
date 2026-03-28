// Проверка авторизации
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    next();
  } else {
    res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }
}

// Проверка админа
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    next();
  } else {
    res.status(403).send(`
      <div style="font-family:monospace;text-align:center;padding:50px;">
        <h1>403 -- Dostup zapreshen</h1>
        <p>Tolko dlya administratorov.</p>
        <a href="/">Nazad</a>
      </div>
    `);
  }
}

// Добавляем user в шаблоны
function addUserToViews(req, res, next) {
  res.locals.currentUser = req.session ? req.session.user || null : null;
  next();
}

module.exports = { requireAuth, requireAdmin, addUserToViews };