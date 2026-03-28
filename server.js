const express = require('express');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { initDB, buildQueries } = require('./db');
const { sendVerificationCode, sendReplyNotification } = require('./mail');
const { requireAuth, requireAdmin, addUserToViews } = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;
let Q;

// Uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname).toLowerCase())
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.jpg','.jpeg','.png','.gif','.webp','.mp4','.webm','.pdf','.zip','.rar','.7z','.txt'];
    cb(null, ok.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// Config
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));
app.use(express.urlencoded({ extended: true }));

// Сессии
let sessionConfig = {
  secret: process.env.SESSION_SECRET || 'qwa-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
};

if (process.env.DATABASE_URL) {
  const pgSession = require('connect-pg-simple')(session);
  sessionConfig.store = new pgSession({
    conString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

app.use(session(sessionConfig));
app.use(addUserToViews);

// Helpers
function esc(s) { 
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); 
}

function stripEmoji(s) {
  return (s||'').replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu,'').trim();
}

function formatPost(text) {
  if (!text) return '';
  return text.split('\n').map(line => {
    if (line.startsWith('&gt;') && !line.startsWith('&gt;&gt;'))
      return '<span class="greentext">' + line + '</span>';
    return line.replace(/&gt;&gt;(\d+)/g, '<a href="#p$1" class="quotelink">&gt;&gt;$1</a>');
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

function genCode() { 
  return Math.floor(100000+Math.random()*900000).toString(); 
}

function isImg(f) { 
  return f && ['.jpg','.jpeg','.png','.gif','.webp'].includes(path.extname(f).toLowerCase()); 
}

// Передаём функции в шаблоны
app.use((req, res, next) => {
  res.locals.formatPost = formatPost;
  res.locals.formatDate = formatDate;
  res.locals.fdate = formatDate;
  res.locals.fmt = formatPost;
  res.locals.isImg = isImg;
  next();
});

// ============ ROUTES ============

// Главная
app.get('/', async (req, res) => {
  try {
    const boards = await Q.getAllBoards();
    const stats = await Q.getTotalStats();
    const recent = await Q.getRecentPosts(10);
    const bws = await Promise.all(boards.map(async b => ({
      ...b,
      tc: (await Q.getThreadCount(b.slug)).cnt,
      pc: (await Q.getPostCount(b.slug)).cnt
    })));
    res.render('index', { boards: bws, stats, recent });
  } catch(e) { 
    console.error(e); 
    res.status(500).send('Ошибка сервера'); 
  }
});

// Поиск
app.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const boards = await Q.getAllBoards();
    let results = [];
    if (q.length >= 2) results = await Q.searchThreads(q);
    res.render('search', { boards, query: q, results });
  } catch(e) { 
    console.error(e); 
    res.status(500).send('Ошибка'); 
  }
});

// Регистрация
app.get('/register', (req, res) => {
  res.render('register', { error: null, step: 'form' });
});

app.post('/register', async (req, res) => {
  try {
    const { username, email, password, password2 } = req.body;
    
    if (!username || !email || !password) {
      return res.render('register', { error: 'Заполните все поля', step: 'form' });
    }
    if (username.length < 3 || username.length > 20) {
      return res.render('register', { error: 'Имя от 3 до 20 символов', step: 'form' });
    }
    if (!/^[a-zA-Z0-9_а-яА-ЯёЁ]+$/.test(username)) {
      return res.render('register', { error: 'Имя: буквы, цифры, _', step: 'form' });
    }
    if (password.length < 6) {
      return res.render('register', { error: 'Пароль минимум 6 символов', step: 'form' });
    }
    if (password !== password2) {
      return res.render('register', { error: 'Пароли не совпадают', step: 'form' });
    }
    if (!validEmail(email)) {
      return res.render('register', { error: 'Принимаются только Gmail, Mail.ru, Yandex', step: 'form' });
    }
    
    const existUser = await Q.getUserByUsername(username);
    if (existUser) {
      return res.render('register', { error: 'Имя уже занято', step: 'form' });
    }
    
    const existEmail = await Q.getUserByEmail(email);
    if (existEmail) {
      return res.render('register', { error: 'Почта уже используется', step: 'form' });
    }

    const code = genCode();
    await Q.saveVerifyCode(email, code);
    const sent = await sendVerificationCode(email, code);

    if (!sent) {
      // Почта не настроена - создаём без верификации
      const hash = bcrypt.hashSync(password, 10);
      const uid = await Q.createUser(username, email, hash);
      await Q.verifyUser(uid);
      const u = await Q.getUserById(uid);
      req.session.user = { id: u.id, username: u.username, email: u.email, role: u.role };
      return res.redirect('/');
    }

    req.session.pendingUser = { username, email, password };
    res.render('register', { error: null, step: 'verify', email });
  } catch(e) { 
    console.error(e); 
    res.render('register', { error: 'Ошибка сервера', step: 'form' }); 
  }
});

app.post('/verify', async (req, res) => {
  try {
    const { code } = req.body;
    const p = req.session.pendingUser;
    if (!p) return res.redirect('/register');
    
    const saved = await Q.getVerifyCode(p.email);
    if (!saved || saved.code !== code) {
      return res.render('register', { error: 'Неверный код', step: 'verify', email: p.email });
    }
    
    const hash = bcrypt.hashSync(p.password, 10);
    const uid = await Q.createUser(p.username, p.email, hash);
    await Q.verifyUser(uid);
    await Q.deleteVerifyCode(p.email);
    delete req.session.pendingUser;
    
    const u = await Q.getUserById(uid);
    req.session.user = { id: u.id, username: u.username, email: u.email, role: u.role };
    res.redirect('/');
  } catch(e) { 
    console.error(e); 
    res.redirect('/register'); 
  }
});

// Вход
app.get('/login', (req, res) => {
  res.render('login', { error: null, redirect: req.query.redirect || '/' });
});

app.post('/login', async (req, res) => {
  try {
    const { username, password, redirect } = req.body;
    const u = await Q.getUserByUsername(username);
    
    if (!u || !bcrypt.compareSync(password, u.password_hash)) {
      return res.render('login', { error: 'Неверный логин или пароль', redirect: redirect || '/' });
    }
    
    req.session.user = { id: u.id, username: u.username, email: u.email, role: u.role };
    res.redirect(redirect || '/');
  } catch(e) { 
    console.error(e); 
    res.render('login', { error: 'Ошибка сервера', redirect: '/' }); 
  }
});

app.get('/logout', (req, res) => { 
  req.session.destroy(); 
  res.redirect('/'); 
});

// Профиль
app.get('/profile', requireAuth, async (req, res) => {
  const user = await Q.getUserById(req.session.user.id);
  res.render('profile', { user });
});

app.get('/user/:username', async (req, res) => {
  const user = await Q.getUserByUsername(req.params.username);
  if (!user) return res.status(404).send('<h1>Пользователь не найден</h1><a href="/">Назад</a>');
  const boards = await Q.getAllBoards();
  res.render('userpage', { user, boards });
});

app.post('/profile/update', requireAuth, async (req, res) => {
  const about = esc((req.body.about || '').substring(0, 500));
  await Q.updateAbout(req.session.user.id, about);
  res.redirect('/profile');
});

// Админка
app.get('/admin', requireAdmin, async (req, res) => {
  const users = await Q.getAllUsers();
  const boards = await Q.getAllBoards();
  const stats = await Q.getTotalStats();
  res.render('admin', { users, boards, stats });
});

app.post('/admin/set-role', requireAdmin, async (req, res) => {
  if (['user', 'mod', 'admin'].includes(req.body.role)) {
    await Q.setUserRole(parseInt(req.body.user_id), req.body.role);
  }
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

// Доска
app.get('/:board/', async (req, res) => {
  try {
    const board = await Q.getBoard(req.params.board);
    if (!board) return res.status(404).send('<h1>404 -- Раздел не найден</h1><a href="/">На главную</a>');
    
    const threads = await Q.getThreadsByBoard(board.slug);
    const boards = await Q.getAllBoards();
    res.render('board', { board, boards, threads });
  } catch(e) { 
    console.error(e); 
    res.status(500).send('Ошибка'); 
  }
});

// Создание темы
app.post('/:board/post', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const board = await Q.getBoard(req.params.board);
    if (!board) return res.status(404).send('Раздел не найден');
    
    if (board.admin_only && req.session.user.role !== 'admin') {
      return res.status(403).send('<h1>Только для администраторов</h1><a href="/">Назад</a>');
    }
    
    let { subject, message } = req.body;
    message = stripEmoji(esc(message || ''));
    subject = stripEmoji(esc(subject || ''));
    
    if (!message) {
      return res.status(400).send('<h1>Напишите сообщение</h1><a href="/' + board.slug + '/">Назад</a>');
    }
    
    const u = req.session.user;
    const tid = await Q.createThread(board.slug, subject, u.username, u.id, message);
    await Q.incrementPostCount(u.id);
    
    if (req.file) {
      await Q.createPost(tid, board.slug, u.username, u.id, '', req.file.filename);
    }
    
    res.redirect('/' + board.slug + '/thread/' + tid);
  } catch(e) { 
    console.error(e); 
    res.status(500).send('Ошибка'); 
  }
});

// Тред
app.get('/:board/thread/:id', async (req, res) => {
  try {
    const board = await Q.getBoard(req.params.board);
    if (!board) return res.status(404).send('<h1>404</h1><a href="/">Назад</a>');
    
    const thread = await Q.getThread(parseInt(req.params.id), board.slug);
    if (!thread) return res.status(404).send('<h1>404 -- Тема не найдена</h1><a href="/' + board.slug + '/">Назад</a>');
    
    const posts = await Q.getPostsByThread(thread.id);
    const boards = await Q.getAllBoards();
    res.render('thread', { board, boards, thread, posts });
  } catch(e) { 
    console.error(e); 
    res.status(500).send('Ошибка'); 
  }
});

// Ответ
app.post('/:board/thread/:id/reply', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const board = await Q.getBoard(req.params.board);
    const thread = await Q.getThread(parseInt(req.params.id), req.params.board);
    
    if (!board || !thread) return res.status(404).send('Не найдено');
    if (thread.is_locked) return res.status(403).send('<h1>Тема закрыта</h1><a href="/">Назад</a>');
    
    let { message } = req.body;
    message = stripEmoji(esc(message || ''));
    
    if (!message && !req.file) {
      return res.status(400).send('<h1>Напишите сообщение или приложите файл</h1><a href="/' + board.slug + '/thread/' + thread.id + '">Назад</a>');
    }
    
    const u = req.session.user;
    const img = req.file ? req.file.filename : '';
    const pid = await Q.createPost(thread.id, board.slug, u.username, u.id, message || '', img);
    await Q.incrementPostCount(u.id);
    
    if (!(message || '').toLowerCase().includes('sage')) {
      await Q.bumpThread(thread.id);
    }
    
    // Уведомление автору
    if (thread.author_id && thread.author_id !== u.id) {
      const ta = await Q.getUserById(thread.author_id);
      if (ta && ta.email_verified && ta.notify_replies) {
        sendReplyNotification(ta.email, board.slug, thread.id, thread.subject, u.username);
      }
    }
    
    res.redirect('/' + board.slug + '/thread/' + thread.id + '#p' + pid);
  } catch(e) { 
    console.error(e); 
    res.status(500).send('Ошибка'); 
  }
});

// 404
app.use((req, res) => {
  res.status(404).send(`
    <div style="font-family:monospace;text-align:center;padding:50px;">
      <h1>404</h1>
      <p>Страница не найдена</p>
      <a href="/">На главную</a>
    </div>
  `);
});

// Запуск
async function start() {
  await initDB();
  Q = buildQueries();
  app.listen(PORT, () => console.log('[QWA] Форум запущен на http://localhost:' + PORT));
}
start();