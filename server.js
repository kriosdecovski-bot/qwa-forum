const express = require('express');
const path = require('path');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { initDB, buildQueries } = require('./db-postgres');
const { sendVerificationCode, sendReplyNotification } = require('./mail');
const { requireAuth, requireAdmin, addUserToViews } = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;

let Q;

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uuidv4() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.pdf', '.zip', '.rar', '.7z', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed'));
    }
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'qwa-forum-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));
app.use(addUserToViews);

function sanitize(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripEmoji(str) {
  if (!str) return '';
  return str.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '').trim();
}

function formatPost(text) {
  if (!text) return '';
  let lines = text.split('\n');
  return lines.map(line => {
    if (line.startsWith('&gt;') && !line.startsWith('&gt;&gt;'))
      return '<span class="greentext">' + line + '</span>';
    return line.replace(/&gt;&gt;(\d+)/g, '<a href="#p$1" class="quotelink">&gt;&gt;$1</a>');
  }).join('<br>');
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const pad = n => n.toString().padStart(2, '0');
  return `${pad(dt.getUTCDate())}.${pad(dt.getUTCMonth()+1)}.${dt.getUTCFullYear()} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;
}

function isValidEmail(email) {
  const allowed = ['gmail.com', 'mail.ru', 'yandex.ru', 'yandex.com', 'ya.ru', 'inbox.ru', 'list.ru', 'bk.ru'];
  const domain = email.split('@')[1];
  return allowed.includes(domain);
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function isImageFile(filename) {
  if (!filename) return false;
  return ['.jpg','.jpeg','.png','.gif','.webp'].includes(path.extname(filename).toLowerCase());
}

app.use((req, res, next) => {
  res.locals.formatPost = formatPost;
  res.locals.formatDate = formatDate;
  res.locals.isImageFile = isImageFile;
  res.locals.siteName = 'QWA';
  next();
});

// === ROUTES ===

app.get('/', async (req, res) => {
  try {
    const boards = await Q.getAllBoards();
    const stats = await Q.getTotalStats();
    const boardsWithStats = await Promise.all(boards.map(async b => ({
      ...b,
      threadCount: (await Q.getThreadCount(b.slug)).cnt,
      postCount: (await Q.getPostCount(b.slug)).cnt
    })));
    res.render('index', { boards: boardsWithStats, stats });
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/register', (req, res) => {
  res.render('register', { error: null, step: 'form' });
});

app.post('/register', async (req, res) => {
  const { username, email, password, password2 } = req.body;

  if (!username || !email || !password) {
    return res.render('register', { error: 'Заполните все поля', step: 'form' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.render('register', { error: 'Имя от 3 до 20 символов', step: 'form' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.render('register', { error: 'Имя: только буквы, цифры, _', step: 'form' });
  }
  if (password.length < 6) {
    return res.render('register', { error: 'Пароль минимум 6 символов', step: 'form' });
  }
  if (password !== password2) {
    return res.render('register', { error: 'Пароли не совпадают', step: 'form' });
  }
  if (!isValidEmail(email)) {
    return res.render('register', { error: 'Только gmail.com, mail.ru, yandex.ru', step: 'form' });
  }

  const existUser = await Q.getUserByUsername(username);
  if (existUser) {
    return res.render('register', { error: 'Это имя уже занято', step: 'form' });
  }

  const existEmail = await Q.getUserByEmail(email);
  if (existEmail) {
    return res.render('register', { error: 'Эта почта уже используется', step: 'form' });
  }

  const code = generateCode();
  await Q.saveVerifyCode(email, code);

  const sent = await sendVerificationCode(email, code);
  if (!sent) {
    const hash = bcrypt.hashSync(password, 10);
    const userId = await Q.createUser(username, email, hash);
    await Q.verifyUser(userId);
    req.session.user = await Q.getUserById(userId);
    return res.redirect('/');
  }

  req.session.pendingUser = { username, email, password };
  res.render('register', { error: null, step: 'verify', email });
});

app.post('/verify', async (req, res) => {
  const { code } = req.body;
  const pending = req.session.pendingUser;

  if (!pending) return res.redirect('/register');

  const saved = await Q.getVerifyCode(pending.email);
  if (!saved || saved.code !== code) {
    return res.render('register', { error: 'Неверный код', step: 'verify', email: pending.email });
  }

  const codeTime = new Date(saved.created_at).getTime();
  if (Date.now() - codeTime > 10 * 60 * 1000) {
    return res.render('register', { error: 'Код истёк. Зарегистрируйтесь заново', step: 'form' });
  }

  const hash = bcrypt.hashSync(pending.password, 10);
  const userId = await Q.createUser(pending.username, pending.email, hash);
  await Q.verifyUser(userId);
  await Q.deleteVerifyCode(pending.email);

  delete req.session.pendingUser;
  req.session.user = await Q.getUserById(userId);
  res.redirect('/');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null, redirect: req.query.redirect || '/' });
});

app.post('/login', async (req, res) => {
  const { username, password, redirect } = req.body;
  const user = await Q.getUserByUsername(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'Неверный логин или пароль', redirect: redirect || '/' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    email_verified: user.email_verified
  };
  res.redirect(redirect || '/');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/profile', requireAuth, async (req, res) => {
  const user = await Q.getUserById(req.session.user.id);
  res.render('profile', { user });
});

app.get('/admin', requireAdmin, async (req, res) => {
  const users = await Q.getAllUsers();
  const boards = await Q.getAllBoards();
  const stats = await Q.getTotalStats();
  res.render('admin', { users, boards, stats });
});

app.post('/admin/set-role', requireAdmin, async (req, res) => {
  const { user_id, role } = req.body;
  if (['user', 'mod', 'admin'].includes(role)) {
    await Q.setUserRole(parseInt(user_id), role);
  }
  res.redirect('/admin');
});

app.post('/admin/delete-thread', requireAdmin, async (req, res) => {
  const { thread_id, board_slug } = req.body;
  await Q.deleteThread(parseInt(thread_id));
  res.redirect('/' + board_slug + '/');
});

app.post('/admin/pin-thread', requireAdmin, async (req, res) => {
  const { thread_id, board_slug, pin } = req.body;
  await Q.pinThread(parseInt(thread_id), parseInt(pin));
  res.redirect('/' + board_slug + '/thread/' + thread_id);
});

app.post('/admin/lock-thread', requireAdmin, async (req, res) => {
  const { thread_id, board_slug, lock } = req.body;
  await Q.lockThread(parseInt(thread_id), parseInt(lock));
  res.redirect('/' + board_slug + '/thread/' + thread_id);
});

app.post('/admin/delete-post', requireAdmin, async (req, res) => {
  const { post_id, board_slug, thread_id } = req.body;
  await Q.deletePost(parseInt(post_id));
  res.redirect('/' + board_slug + '/thread/' + thread_id);
});

app.get('/:board/', async (req, res) => {
  const board = await Q.getBoard(req.params.board);
  if (!board) return res.status(404).send('<h1>404</h1><a href="/">Назад</a>');

  const threads = await Q.getThreadsByBoard(board.slug);
  const boards = await Q.getAllBoards();
  res.render('board', { board, boards, threads });
});

app.post('/:board/post', requireAuth, upload.single('file'), async (req, res) => {
  const board = await Q.getBoard(req.params.board);
  if (!board) return res.status(404).send('Board not found');

  if (board.admin_only && req.session.user.role !== 'admin') {
    return res.status(403).send('<h1>Только для админов</h1><a href="/">Назад</a>');
  }

  let { subject, message } = req.body;
  message = stripEmoji(sanitize(message || ''));
  subject = stripEmoji(sanitize(subject || ''));

  if (!message || message.length < 1) {
    return res.status(400).send('<h1>Сообщение не может быть пустым</h1><a href="/' + board.slug + '/">Назад</a>');
  }

  const user = req.session.user;
  const threadId = await Q.createThread(board.slug, subject, user.username, user.id, message);

  if (req.file) {
    await Q.createPost(threadId, board.slug, user.username, user.id, '[File attached to OP]', req.file.filename);
  }

  res.redirect('/' + board.slug + '/thread/' + threadId);
});

app.get('/:board/thread/:id', async (req, res) => {
  const board = await Q.getBoard(req.params.board);
  if (!board) return res.status(404).send('<h1>404</h1><a href="/">Назад</a>');

  const thread = await Q.getThread(parseInt(req.params.id), board.slug);
  if (!thread) return res.status(404).send('<h1>404</h1><a href="/' + board.slug + '/">Назад</a>');

  const posts = await Q.getPostsByThread(thread.id);
  const boards = await Q.getAllBoards();
  res.render('thread', { board, boards, thread, posts });
});

app.post('/:board/thread/:id/reply', requireAuth, upload.single('file'), async (req, res) => {
  const board = await Q.getBoard(req.params.board);
  const thread = await Q.getThread(parseInt(req.params.id), req.params.board);

  if (!board || !thread) return res.status(404).send('Not found');
  if (thread.is_locked) return res.status(403).send('<h1>Тема закрыта</h1><a href="/' + board.slug + '/">Назад</a>');

  let { message } = req.body;
  message = stripEmoji(sanitize(message || ''));

  if (!message && !req.file) {
    return res.status(400).send('<h1>Напишите сообщение или приложите файл</h1><a href="/' + board.slug + '/thread/' + thread.id + '">Назад</a>');
  }

  const user = req.session.user;
  const imagePath = req.file ? req.file.filename : '';
  const postId = await Q.createPost(thread.id, board.slug, user.username, user.id, message || '', imagePath);

  const isSage = (message || '').toLowerCase().includes('sage');
  if (!isSage) await Q.bumpThread(thread.id);

  if (thread.author_id && thread.author_id !== user.id) {
    const threadAuthor = await Q.getUserById(thread.author_id);
    if (threadAuthor && threadAuthor.email_verified && threadAuthor.notify_replies) {
      sendReplyNotification(threadAuthor.email, board.slug, thread.id, thread.subject, user.username);
    }
  }

  res.redirect('/' + board.slug + '/thread/' + thread.id + '#p' + postId);
});

app.use((req, res) => {
  res.status(404).send(`
    <div style="font-family:monospace;text-align:center;padding:50px;">
      <h1>404</h1><p>Страница не найдена</p><a href="/">На главную</a>
    </div>
  `);
});

async function start() {
  await initDB();
  Q = buildQueries();
  app.listen(PORT, () => console.log('[QWA] Forum running at http://localhost:' + PORT));
}
start();