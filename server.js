const express = require('express');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { initDB, buildQueries } = require('./db');
const { sendVerificationCode, sendReplyNotification } = require('./mail');
const { requireAuth, requireAdmin, requireOwner, addUserToViews } = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;
let Q;

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname).toLowerCase())
});
const upload = multer({
  storage, limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.jpg','.jpeg','.png','.gif','.webp','.mp4','.webm','.pdf','.zip','.rar','.7z','.txt'];
    cb(null, ok.includes(path.extname(file.originalname).toLowerCase()));
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));
app.use(express.urlencoded({ extended: true }));

let sessionConfig = {
  secret: process.env.SESSION_SECRET || 'qwa-secret-2025',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
};
if (process.env.DATABASE_URL) {
  const pgSession = require('connect-pg-simple')(session);
  sessionConfig.store = new pgSession({ conString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}
app.use(session(sessionConfig));
app.use(addUserToViews);

// === Helpers ===
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function stripEmoji(s) { return (s||'').replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu,'').trim(); }

function formatPost(text) {
  if (!text) return '';
  return text.split('\n').map(line => {
    if (line.startsWith('&gt;') && !line.startsWith('&gt;&gt;'))
      return '<span class="greentext">' + line + '</span>';
    // @username упоминания
    line = line.replace(/@([a-zA-Z0-9_а-яА-ЯёЁ]+)/g, '<a href="/user/$1" class="mention">@$1</a>');
    line = line.replace(/&gt;&gt;(\d+)/g, '<a href="#p$1" class="quotelink">&gt;&gt;$1</a>');
    return line;
  }).join('<br>');
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const p = n => n.toString().padStart(2,'0');
  return p(dt.getUTCDate())+'.'+p(dt.getUTCMonth()+1)+'.'+dt.getUTCFullYear()+' '+p(dt.getUTCHours())+':'+p(dt.getUTCMinutes());
}

function validEmail(e) {
  const ok = ['gmail.com','mail.ru','yandex.ru','yandex.com','ya.ru','inbox.ru','list.ru','bk.ru'];
  return ok.includes((e||'').split('@')[1]);
}
function genCode() { return Math.floor(100000+Math.random()*900000).toString(); }
function isImg(f) { return f && ['.jpg','.jpeg','.png','.gif','.webp'].includes(path.extname(f).toLowerCase()); }

function getRolePrefix(role) {
  const prefixes = {
    owner: '<span class="role-owner">Owner</span>',
    coowner: '<span class="role-coowner">Co-Owner</span>',
    admin: '<span class="role-admin">Admin</span>',
    mod: '<span class="role-mod">Mod</span>',
    user: ''
  };
  return prefixes[role] || '';
}

function isStaff(role) {
  return ['owner','coowner','admin','mod'].includes(role);
}

app.use((req, res, next) => {
  res.locals.formatPost = formatPost;
  res.locals.formatDate = formatDate;
  res.locals.fdate = formatDate;
  res.locals.fmt = formatPost;
  res.locals.isImg = isImg;
  res.locals.getRolePrefix = getRolePrefix;
  res.locals.isStaff = isStaff;
  next();
});

// === Проверка отключения форума ===
app.use(async (req, res, next) => {
  if (!Q) return next();
  // Пропускаем статику и авторизацию
  const skip = ['/login', '/logout', '/style.css', '/uploads', '/disabled'];
  if (skip.some(s => req.path.startsWith(s))) return next();

  try {
    const disabled = await Q.getSetting('forum_disabled');
    if (disabled === 'true') {
      const user = req.session ? req.session.user : null;
      if (user && isStaff(user.role)) return next();
      return res.render('disabled');
    }
  } catch(e) {}
  next();
});

// === Проверка бана ===
app.use(async (req, res, next) => {
  if (!Q || !req.session || !req.session.user) return next();
  try {
    const u = await Q.getUserById(req.session.user.id);
    if (u && u.is_banned) {
      req.session.destroy();
      return res.send('<div style="font-family:monospace;text-align:center;padding:50px;"><h1>Вы заблокированы</h1><p>Причина: ' + (u.ban_reason || 'Не указана') + '</p><a href="/">Главная</a></div>');
    }
  } catch(e) {}
  next();
});

// === ROUTES ===

app.get('/', async (req, res) => {
  try {
    const boards = await Q.getAllBoards();
    const stats = await Q.getTotalStats();
    const recent = await Q.getRecentPosts(10);
    const bws = await Promise.all(boards.map(async b => ({
      ...b, tc: (await Q.getThreadCount(b.slug)).cnt, pc: (await Q.getPostCount(b.slug)).cnt
    })));
    let unread = 0;
    if (req.session.user) unread = await Q.getUnreadCount(req.session.user.id);
    res.render('index', { boards: bws, stats, recent, unread });
  } catch(e) { console.error(e); res.status(500).send('Ошибка сервера'); }
});

app.get('/search', async (req, res) => {
  try {
    const q = (req.query.q||'').trim();
    const boards = await Q.getAllBoards();
    let results = [];
    if (q.length >= 2) results = await Q.searchThreads(q);
    res.render('search', { boards, query: q, results });
  } catch(e) { console.error(e); res.status(500).send('Ошибка'); }
});

// Регистрация
app.get('/register', (req, res) => res.render('register', { error: null, step: 'form' }));

app.post('/register', async (req, res) => {
  try {
    const { username, email, password, password2 } = req.body;
    if (!username||!email||!password) return res.render('register',{error:'Заполните все поля',step:'form'});
    if (username.length<3||username.length>20) return res.render('register',{error:'Имя от 3 до 20 символов',step:'form'});
    if (!/^[a-zA-Z0-9_а-яА-ЯёЁ]+$/.test(username)) return res.render('register',{error:'Имя: буквы, цифры, _',step:'form'});
    if (password.length<6) return res.render('register',{error:'Пароль минимум 6 символов',step:'form'});
    if (password!==password2) return res.render('register',{error:'Пароли не совпадают',step:'form'});
    if (!validEmail(email)) return res.render('register',{error:'Только Gmail, Mail.ru, Yandex',step:'form'});
    if (await Q.getUserByUsername(username)) return res.render('register',{error:'Имя занято',step:'form'});
    if (await Q.getUserByEmail(email)) return res.render('register',{error:'Почта занята',step:'form'});

    const code = genCode();
    await Q.saveVerifyCode(email, code);
    const sent = await sendVerificationCode(email, code);

    if (!sent) {
      const hash = bcrypt.hashSync(password,10);
      const uid = await Q.createUser(username,email,hash);
      await Q.verifyUser(uid);
      const u = await Q.getUserById(uid);
      req.session.user = {id:u.id,username:u.username,email:u.email,role:u.role};
      return res.redirect('/');
    }
    req.session.pendingUser = {username,email,password};
    res.render('register', {error:null,step:'verify',email});
  } catch(e) { console.error(e); res.render('register',{error:'Ошибка сервера',step:'form'}); }
});

app.post('/verify', async (req, res) => {
  try {
    const {code} = req.body;
    const p = req.session.pendingUser;
    if (!p) return res.redirect('/register');
    const saved = await Q.getVerifyCode(p.email);
    if (!saved||saved.code!==code) return res.render('register',{error:'Неверный код',step:'verify',email:p.email});
    const hash = bcrypt.hashSync(p.password,10);
    const uid = await Q.createUser(p.username,p.email,hash);
    await Q.verifyUser(uid);
    await Q.deleteVerifyCode(p.email);
    delete req.session.pendingUser;
    const u = await Q.getUserById(uid);
    req.session.user = {id:u.id,username:u.username,email:u.email,role:u.role};
    res.redirect('/');
  } catch(e) { console.error(e); res.redirect('/register'); }
});

app.get('/login', (req, res) => res.render('login', {error:null,redirect:req.query.redirect||'/'}));

app.post('/login', async (req, res) => {
  try {
    const {username,password,redirect} = req.body;
    const u = await Q.getUserByUsername(username);
    if (!u||!bcrypt.compareSync(password,u.password_hash))
      return res.render('login',{error:'Неверный логин или пароль',redirect:redirect||'/'});
    if (u.is_banned) return res.render('login',{error:'Аккаунт заблокирован: '+(u.ban_reason||''),redirect:'/'});
    req.session.user = {id:u.id,username:u.username,email:u.email,role:u.role};
    res.redirect(redirect||'/');
  } catch(e) { console.error(e); res.render('login',{error:'Ошибка',redirect:'/'}); }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// Профиль
app.get('/profile', requireAuth, async (req, res) => {
  const user = await Q.getUserById(req.session.user.id);
  const unread = await Q.getUnreadCount(req.session.user.id);
  res.render('profile', {user, unread});
});

app.post('/profile/update', requireAuth, upload.single('avatar'), async (req, res) => {
  const about = esc((req.body.about||'').substring(0,500));
  await Q.updateAbout(req.session.user.id, about);
  if (req.file) await Q.updateAvatar(req.session.user.id, req.file.filename);
  res.redirect('/profile');
});

app.get('/user/:username', async (req, res) => {
  const user = await Q.getUserByUsername(req.params.username);
  if (!user) return res.status(404).send('<h1>Не найден</h1><a href="/">Назад</a>');
  const boards = await Q.getAllBoards();
  res.render('userpage', {user, boards});
});

// === ЛС ===
app.get('/messages', requireAuth, async (req, res) => {
  const inbox = await Q.getInbox(req.session.user.id);
  const sent = await Q.getSent(req.session.user.id);
  const boards = await Q.getAllBoards();
  res.render('messages', {inbox, sent, boards});
});

app.get('/messages/chat/:username', requireAuth, async (req, res) => {
  const other = await Q.getUserByUsername(req.params.username);
  if (!other) return res.status(404).send('Пользователь не найден');
  const msgs = await Q.getConversation(req.session.user.id, other.id);
  // Помечаем прочитанными
  for (const m of msgs) {
    if (m.to_id === req.session.user.id && !m.is_read) await Q.markRead(m.id, req.session.user.id);
  }
  const boards = await Q.getAllBoards();
  res.render('chat', {other, msgs, boards});
});

app.post('/messages/send/:username', requireAuth, async (req, res) => {
  const other = await Q.getUserByUsername(req.params.username);
  if (!other) return res.status(404).send('Не найден');
  const msg = esc((req.body.message||'').substring(0,2000));
  if (!msg) return res.redirect('/messages/chat/'+req.params.username);
  const u = req.session.user;
  // Проверка мута
  const me = await Q.getUserById(u.id);
  if (me.is_muted) return res.send('<h1>Вы в муте</h1><a href="/">Назад</a>');
  await Q.sendMessage(u.id, other.id, u.username, other.username, msg);
  res.redirect('/messages/chat/'+req.params.username);
});

// === Админка ===
app.get('/admin', requireAdmin, async (req, res) => {
  const users = await Q.getAllUsers();
  const boards = await Q.getAllBoards();
  const stats = await Q.getTotalStats();
  res.render('admin', {users,boards,stats});
});

app.post('/admin/set-role', requireAdmin, async (req, res) => {
  const {user_id, role} = req.body;
  const me = req.session.user;
  // Только owner может назначать coowner (и только одного)
  if (role === 'coowner') {
    if (me.role !== 'owner') return res.redirect('/admin');
    const users = await Q.getAllUsers();
    const existing = users.find(u => u.role === 'coowner');
    if (existing && existing.id !== parseInt(user_id)) {
      await Q.setUserRole(existing.id, 'user');
    }
  }
  if (role === 'owner') return res.redirect('/admin'); // нельзя назначить ещё одного owner
  if (['user','mod','admin','coowner'].includes(role)) await Q.setUserRole(parseInt(user_id), role);
  res.redirect('/admin');
});

app.post('/admin/ban', requireAdmin, async (req, res) => {
  const {user_id, reason} = req.body;
  const target = await Q.getUserById(parseInt(user_id));
  if (target && !['owner','coowner'].includes(target.role)) {
    await Q.banUser(parseInt(user_id), reason||'');
  }
  res.redirect('/admin');
});

app.post('/admin/unban', requireAdmin, async (req, res) => {
  await Q.unbanUser(parseInt(req.body.user_id));
  res.redirect('/admin');
});

app.post('/admin/mute', requireAdmin, async (req, res) => {
  await Q.muteUser(parseInt(req.body.user_id));
  res.redirect('/admin');
});

app.post('/admin/unmute', requireAdmin, async (req, res) => {
  await Q.unmuteUser(parseInt(req.body.user_id));
  res.redirect('/admin');
});

app.post('/admin/delete-thread', requireAdmin, async (req, res) => {
  await Q.deleteThread(parseInt(req.body.thread_id));
  res.redirect('/' + req.body.board_slug + '/');
});

app.post('/admin/pin-thread', requireAdmin, async (req, res) => {
  await Q.pinThread(parseInt(req.body.thread_id), parseInt(req.body.pin));
  res.redirect('/' + req.body.board_slug + '/thread/' + req.body.thread_id);
});

app.post('/admin/lock-thread', requireAdmin, async (req, res) => {
  await Q.lockThread(parseInt(req.body.thread_id), parseInt(req.body.lock));
  res.redirect('/' + req.body.board_slug + '/thread/' + req.body.thread_id);
});

app.post('/admin/delete-post', requireAdmin, async (req, res) => {
  await Q.deletePost(parseInt(req.body.post_id));
  res.redirect('/' + req.body.board_slug + '/thread/' + req.body.thread_id);
});

// === Owner Panel ===
app.get('/owner', requireOwner, async (req, res) => {
  const users = await Q.getAllUsers();
  const stats = await Q.getTotalStats();
  const forumDisabled = await Q.getSetting('forum_disabled');
  res.render('owner', {users, stats, forumDisabled: forumDisabled === 'true'});
});

// Протокол Пекорин -- отключить форум
app.post('/owner/toggle-forum', requireOwner, async (req, res) => {
  const {action, password} = req.body;
  if (password !== 'QWENTIVIPBYEXTER') {
    return res.redirect('/owner?error=wrong_password');
  }
  if (action === 'disable') {
    await Q.setSetting('forum_disabled', 'true');
  } else {
    await Q.setSetting('forum_disabled', 'false');
  }
  res.redirect('/owner');
});

// === Доска ===
app.get('/:board/', async (req, res) => {
  try {
    const board = await Q.getBoard(req.params.board);
    if (!board) return res.status(404).send('<h1>404</h1><a href="/">Назад</a>');
    const threads = await Q.getThreadsByBoard(board.slug);
    const boards = await Q.getAllBoards();
    res.render('board', {board,boards,threads});
  } catch(e) { console.error(e); res.status(500).send('Ошибка'); }
});

app.post('/:board/post', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const board = await Q.getBoard(req.params.board);
    if (!board) return res.status(404).send('Не найден');
    if (board.admin_only && !isStaff(req.session.user.role))
      return res.status(403).send('<h1>Только для администрации</h1><a href="/">Назад</a>');
    const me = await Q.getUserById(req.session.user.id);
    if (me.is_muted) return res.send('<h1>Вы в муте</h1><a href="/">Назад</a>');
    let {subject,message} = req.body;
    message = stripEmoji(esc(message||''));
    subject = stripEmoji(esc(subject||''));
    if (!message) return res.status(400).send('<h1>Напишите сообщение</h1><a href="/'+board.slug+'/">Назад</a>');
    const u = req.session.user;
    const tid = await Q.createThread(board.slug, subject, u.username, u.id, message);
    await Q.incrementPostCount(u.id);
    if (req.file) await Q.createPost(tid, board.slug, u.username, u.id, '', req.file.filename);
    res.redirect('/'+board.slug+'/thread/'+tid);
  } catch(e) { console.error(e); res.status(500).send('Ошибка'); }
});

app.get('/:board/thread/:id', async (req, res) => {
  try {
    const board = await Q.getBoard(req.params.board);
    if (!board) return res.status(404).send('<h1>404</h1><a href="/">Назад</a>');
    const thread = await Q.getThread(parseInt(req.params.id), board.slug);
    if (!thread) return res.status(404).send('<h1>404</h1><a href="/'+board.slug+'/">Назад</a>');
    const posts = await Q.getPostsByThread(thread.id);
    const boards = await Q.getAllBoards();
    // Получаем автора треда для аватарки
    const threadAuthor = await Q.getUserById(thread.author_id);
    res.render('thread', {board,boards,thread,posts,threadAuthor});
  } catch(e) { console.error(e); res.status(500).send('Ошибка'); }
});

app.post('/:board/thread/:id/reply', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const board = await Q.getBoard(req.params.board);
    const thread = await Q.getThread(parseInt(req.params.id), req.params.board);
    if (!board||!thread) return res.status(404).send('Не найдено');
    if (thread.is_locked) return res.status(403).send('<h1>Тема закрыта</h1>');
    const me = await Q.getUserById(req.session.user.id);
    if (me.is_muted) return res.send('<h1>Вы в муте</h1><a href="/">Назад</a>');
    let {message} = req.body;
    message = stripEmoji(esc(message||''));
    if (!message&&!req.file) return res.status(400).send('<h1>Напишите сообщение</h1>');
    const u = req.session.user;
    const img = req.file?req.file.filename:'';
    const pid = await Q.createPost(thread.id, board.slug, u.username, u.id, message||'', img);
    await Q.incrementPostCount(u.id);
    if (!(message||'').toLowerCase().includes('sage')) await Q.bumpThread(thread.id);
    if (thread.author_id && thread.author_id!==u.id) {
      const ta = await Q.getUserById(thread.author_id);
      if (ta&&ta.email_verified&&ta.notify_replies)
        sendReplyNotification(ta.email, board.slug, thread.id, thread.subject, u.username);
    }
    res.redirect('/'+board.slug+'/thread/'+thread.id+'#p'+pid);
  } catch(e) { console.error(e); res.status(500).send('Ошибка'); }
});

app.use((req, res) => {
  res.status(404).send('<div style="font-family:monospace;text-align:center;padding:50px;"><h1>404</h1><p>Не найдено</p><a href="/">Главная</a></div>');
});

async function start() {
  await initDB();
  Q = buildQueries();
  app.listen(PORT, () => console.log('[QWA] Форум запущен на http://localhost:'+PORT));
}
start();