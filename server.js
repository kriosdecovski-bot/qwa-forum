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

let Q; // queries

// === UPLOADS ===
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
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
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

// === CONFIG ===
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'qwa-forum-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));
app.use(addUserToViews);

// === HELPERS ===
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
  const dt = new Date(d + (d.includes('Z') ? '' : 'Z'));
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
  res.locals.error = null;
  res.locals.success = null;
  next();
});

// ==================== ROUTES ====================

// --- ГЛАВНАЯ ---
app.get('/', (req, res) => {
  const boards = Q.getAllBoards();
  const stats = Q.getTotalStats();
  const boardsWithStats = boards.map(b => ({
    ...b,
    threadCount: Q.getThreadCount(b.slug).cnt,
    postCount: Q.getPostCount(b.slug).cnt
  }));
  res.render('index', { boards: boardsWithStats, stats });
});

// --- РЕГИСТРАЦИЯ ---
app.get('/register', (req, res) => {
  res.render('register', { error: null, step: 'form' });
});

app.post('/register', async (req, res) => {
  const { username, email, password, password2 } = req.body;

  if (!username || !email || !password) {
    return res.render('register', { error: 'Zapolnite vse polya', step: 'form' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.render('register', { error: 'Imya ot 3 do 20 simvolov', step: 'form' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.render('register', { error: 'Imya: tolko bukvy, cifry, _', step: 'form' });
  }
  if (password.length < 6) {
    return res.render('register', { error: 'Parol minimum 6 simvolov', step: 'form' });
  }
  if (password !== password2) {
    return res.render('register', { error: 'Paroli ne sovpadayut', step: 'form' });
  }
  if (!isValidEmail(email)) {
    return res.render('register', { error: 'Tolko gmail.com, mail.ru, yandex.ru', step: 'form' });
  }
  if (Q.getUserByUsername(username)) {
    return res.render('register', { error: 'Eto imya uzhe zanyato', step: 'form' });
  }
  if (Q.getUserByEmail(email)) {
    return res.render('register', { error: 'Eta pochta uzhe ispolzuetsya', step: 'form' });
  }

  const code = generateCode();
  Q.saveVerifyCode(email, code);

  const sent = await sendVerificationCode(email, code);
  if (!sent) {
    // Если почта не настроена, создаём без верификации
    const hash = bcrypt.hashSync(password, 10);
    const userId = Q.createUser(username, email, hash);
    Q.verifyUser(userId);
    req.session.user = Q.getUserById(userId);
    return res.redirect('/');
  }

  // Сохраняем данные в сессии для подтверждения
  req.session.pendingUser = { username, email, password };
  res.render('register', { error: null, step: 'verify', email });
});

app.post('/verify', (req, res) => {
  const { code } = req.body;
  const pending = req.session.pendingUser;

  if (!pending) return res.redirect('/register');

  const saved = Q.getVerifyCode(pending.email);
  if (!saved || saved.code !== code) {
    return res.render('register', { error: 'Nevernyy kod', step: 'verify', email: pending.email });
  }

  // Проверяем срок (10 минут)
  const codeTime = new Date(saved.created_at + 'Z').getTime();
  if (Date.now() - codeTime > 10 * 60 * 1000) {
    return res.render('register', { error: 'Kod istek. Zaregistriruytes zanovo', step: 'form' });
  }

  const hash = bcrypt.hashSync(pending.password, 10);
  const userId = Q.createUser(pending.username, pending.email, hash);
  Q.verifyUser(userId);
  Q.deleteVerifyCode(pending.email);

  delete req.session.pendingUser;
  req.session.user = Q.getUserById(userId);
  res.redirect('/');
});

// --- ВХОД ---
app.get('/login', (req, res) => {
  res.render('login', { error: null, redirect: req.query.redirect || '/' });
});

app.post('/login', (req, res) => {
  const { username, password, redirect } = req.body;
  const user = Q.getUserByUsername(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'Nevernyy login ili parol', redirect: redirect || '/' });
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

// --- ВЫХОД ---
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// --- ПРОФИЛЬ ---
app.get('/profile', requireAuth, (req, res) => {
  const user = Q.getUserById(req.session.user.id);
  res.render('profile', { user });
});

// --- АДМИНКА ---
app.get('/admin', requireAdmin, (req, res) => {
  const users = Q.getAllUsers();
  const boards = Q.getAllBoards();
  const stats = Q.getTotalStats();
  res.render('admin', { users, boards, stats });
});

app.post('/admin/set-role', requireAdmin, (req, res) => {
  const { user_id, role } = req.body;
  if (['user', 'mod', 'admin'].includes(role)) {
    Q.setUserRole(parseInt(user_id), role);
  }
  res.redirect('/admin');
});

app.post('/admin/delete-thread', requireAdmin, (req, res) => {
  const { thread_id, board_slug } = req.body;
  Q.deleteThread(parseInt(thread_id));
  res.redirect('/' + board_slug + '/');
});

app.post('/admin/pin-thread', requireAdmin, (req, res) => {
  const { thread_id, board_slug, pin } = req.body;
  Q.pinThread(parseInt(thread_id), parseInt(pin));
  res.redirect('/' + board_slug + '/thread/' + thread_id);
});

app.post('/admin/lock-thread', requireAdmin, (req, res) => {
  const { thread_id, board_slug, lock } = req.body;
  Q.lockThread(parseInt(thread_id), parseInt(lock));
  res.redirect('/' + board_slug + '/thread/' + thread_id);
});

app.post('/admin/delete-post', requireAdmin, (req, res) => {
  const { post_id, board_slug, thread_id } = req.body;
  Q.deletePost(parseInt(post_id));
  res.redirect('/' + board_slug + '/thread/' + thread_id);
});

// --- ДОСКА ---
app.get('/:board/', (req, res) => {
  const board = Q.getBoard(req.params.board);
  if (!board) return res.status(404).send('<h1>404</h1><a href="/">Nazad</a>');

  const threads = Q.getThreadsByBoard(board.slug);
  const boards = Q.getAllBoards();
  res.render('board', { board, boards, threads });
});

// --- СОЗДАНИЕ ТРЕДА ---
app.post('/:board/post', requireAuth, upload.single('file'), (req, res) => {
  const board = Q.getBoard(req.params.board);
  if (!board) return res.status(404).send('Board not found');

  if (board.admin_only && req.session.user.role !== 'admin') {
    return res.status(403).send('<h1>Tolko dlya adminov</h1><a href="/">Nazad</a>');
  }

  let { subject, message } = req.body;
  message = stripEmoji(sanitize(message || ''));
  subject = stripEmoji(sanitize(subject || ''));

  if (!message || message.length < 1) {
    return res.status(400).send('<h1>Soobshenie ne mozhet byt pustym</h1><a href="/' + board.slug + '/">Nazad</a>');
  }

  const user = req.session.user;
  const threadId = Q.createThread(board.slug, subject, user.username, user.id, message);

  // Если приложен файл, добавляем как первый пост с картинкой
  if (req.file) {
    Q.createPost(threadId, board.slug, user.username, user.id, '[File attached to OP]', req.file.filename);
  }

  res.redirect('/' + board.slug + '/thread/' + threadId);
});

// --- ТРЕД ---
app.get('/:board/thread/:id', (req, res) => {
  const board = Q.getBoard(req.params.board);
  if (!board) return res.status(404).send('<h1>404</h1><a href="/">Nazad</a>');

  const thread = Q.getThread(parseInt(req.params.id), board.slug);
  if (!thread) return res.status(404).send('<h1>404</h1><a href="/' + board.slug + '/">Nazad</a>');

  const posts = Q.getPostsByThread(thread.id);
  const boards = Q.getAllBoards();
  res.render('thread', { board, boards, thread, posts });
});

// --- ОТВЕТ В ТРЕД ---
app.post('/:board/thread/:id/reply', requireAuth, upload.single('file'), async (req, res) => {
  const board = Q.getBoard(req.params.board);
  const thread = Q.getThread(parseInt(req.params.id), req.params.board);

  if (!board || !thread) return res.status(404).send('Not found');
  if (thread.is_locked) return res.status(403).send('<h1>Tema zakryta</h1><a href="/' + board.slug + '/">Nazad</a>');

  let { message } = req.body;
  message = stripEmoji(sanitize(message || ''));

  if (!message && !req.file) {
    return res.status(400).send('<h1>Napishite soobshenie ili prilozhite fayl</h1><a href="/' + board.slug + '/thread/' + thread.id + '">Nazad</a>');
  }

  const user = req.session.user;
  const imagePath = req.file ? req.file.filename : '';
  const postId = Q.createPost(thread.id, board.slug, user.username, user.id, message || '', imagePath);

  // Bump
  const isSage = (message || '').toLowerCase().includes('sage');
  if (!isSage) Q.bumpThread(thread.id);

  // Уведомление автору треда
  if (thread.author_id && thread.author_id !== user.id) {
    const threadAuthor = Q.getUserById(thread.author_id);
    if (threadAuthor && threadAuthor.email_verified && threadAuthor.notify_replies) {
      sendReplyNotification(threadAuthor.email, board.slug, thread.id, thread.subject, user.username);
    }
  }

  res.redirect('/' + board.slug + '/thread/' + thread.id + '#p' + postId);
});

// --- 404 ---
app.use((req, res) => {
  res.status(404).send(`
    <div style="font-family:monospace;text-align:center;padding:50px;">
      <h1>404</h1><p>Stranica ne naydena</p><a href="/">Na glavnuyu</a>
    </div>
  `);
});

// === START ===
async function start() {
  await initDB();
  Q = buildQueries();
  app.listen(PORT, () => console.log('[QWA] Forum running at http://localhost:' + PORT));
}
start();