const express = require('express');
const path = require('path');
const { db, queries } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// === НАСТРОЙКА ===

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

// Простая фильтрация XSS
function sanitize(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Убираем эмодзи из текста
function stripEmoji(str) {
  if (!str) return '';
  return str.replace(
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu,
    ''
  ).trim();
}

// Форматирование текста поста (greentext, ссылки на посты)
function formatPost(text) {
  if (!text) return '';

  let lines = text.split('\n');
  let result = [];

  for (let line of lines) {
    // greentext
    if (line.startsWith('&gt;') && !line.startsWith('&gt;&gt;')) {
      result.push('<span class="greentext">' + line + '</span>');
    }
    // ссылки на посты >>123
    else {
      line = line.replace(
        /&gt;&gt;(\d+)/g,
        '<a href="#p$1" class="quotelink">&gt;&gt;$1</a>'
      );
      result.push(line);
    }
  }

  return result.join('<br>');
}

// Генерация tripcode (простой хэш)
function generateTrip(name) {
  if (!name) return { displayName: 'Anonymous', tripcode: '' };

  const parts = name.split('#');
  if (parts.length < 2) {
    return { displayName: sanitize(parts[0]) || 'Anonymous', tripcode: '' };
  }

  const displayName = sanitize(parts[0]) || 'Anonymous';
  const secret = parts[1];

  // Простой хэш для tripcode
  let hash = 0;
  for (let i = 0; i < secret.length; i++) {
    const char = secret.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const tripcode = '!' + Math.abs(hash).toString(36).toUpperCase().slice(0, 8);

  return { displayName, tripcode };
}

// Форматирование даты
function formatDate(dateStr) {
  const d = new Date(dateStr + 'Z');
  const pad = (n) => n.toString().padStart(2, '0');

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['01','02','03','04','05','06','07','08','09','10','11','12'];

  return `${pad(d.getUTCDate())}/${months[d.getUTCMonth()]}/${d.getUTCFullYear()}` +
    `(${days[d.getUTCDay()]})` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// Передаём хелперы в шаблоны
app.use((req, res, next) => {
  res.locals.formatPost = formatPost;
  res.locals.formatDate = formatDate;
  res.locals.siteName = 'QWA';
  next();
});

// === МАРШРУТЫ ===

// Главная -- список досок
app.get('/', (req, res) => {
  const boards = queries.getAllBoards.all();
  const stats = queries.getTotalStats.get();

  // Подсчёт постов для каждой борды
  const boardsWithStats = boards.map(b => ({
    ...b,
    threadCount: queries.getThreadCount.get(b.slug).cnt,
    postCount: queries.getPostCount.get(b.slug).cnt
  }));

  res.render('index', {
    boards: boardsWithStats,
    stats
  });
});

// Доска -- список тредов
app.get('/:board/', (req, res) => {
  const boardSlug = req.params.board;
  const board = queries.getBoard.get(boardSlug);

  if (!board) {
    return res.status(404).send('<h1>404 -- Board not found</h1><a href="/">Back</a>');
  }

  const threads = queries.getThreadsByBoard.all(boardSlug);
  const allBoards = queries.getAllBoards.all();

  // Для каждого треда берём последние 3 ответа
  const threadsWithPreviews = threads.map(t => {
    const allPosts = queries.getPostsByThread.all(t.id);
    const lastPosts = allPosts.slice(-3);
    const omitted = allPosts.length > 3 ? allPosts.length - 3 : 0;
    return {
      ...t,
      lastPosts,
      omitted
    };
  });

  res.render('board', {
    board,
    boards: allBoards,
    threads: threadsWithPreviews
  });
});

// Создание треда
app.post('/:board/post', (req, res) => {
  const boardSlug = req.params.board;
  const board = queries.getBoard.get(boardSlug);

  if (!board) {
    return res.status(404).send('Board not found');
  }

  let { name, subject, message } = req.body;

  // Очистка
  message = stripEmoji(sanitize(message || ''));
  subject = stripEmoji(sanitize(subject || ''));

  if (!message || message.length < 1) {
    return res.status(400).send(
      '<h2>Error: Message cannot be empty.</h2><a href="/' + boardSlug + '/">Back</a>'
    );
  }

  if (message.length > 5000) {
    return res.status(400).send(
      '<h2>Error: Message too long (max 5000).</h2><a href="/' + boardSlug + '/">Back</a>'
    );
  }

  const { displayName, tripcode } = generateTrip(name);
  const authorField = tripcode ? displayName + ' ' + tripcode : displayName;

  const result = queries.createThread.run(boardSlug, subject, authorField, message);

  res.redirect('/' + boardSlug + '/thread/' + result.lastInsertRowid);
});

// Просмотр треда
app.get('/:board/thread/:id', (req, res) => {
  const boardSlug = req.params.board;
  const threadId = parseInt(req.params.id);

  const board = queries.getBoard.get(boardSlug);
  if (!board) {
    return res.status(404).send('<h1>404 -- Board not found</h1><a href="/">Back</a>');
  }

  const thread = queries.getThread.get(threadId, boardSlug);
  if (!thread) {
    return res.status(404).send('<h1>404 -- Thread not found</h1><a href="/' + boardSlug + '/">Back</a>');
  }

  const posts = queries.getPostsByThread.all(threadId);
  const allBoards = queries.getAllBoards.all();

  res.render('thread', {
    board,
    boards: allBoards,
    thread,
    posts
  });
});

// Ответ в тред
app.post('/:board/thread/:id/reply', (req, res) => {
  const boardSlug = req.params.board;
  const threadId = parseInt(req.params.id);

  const board = queries.getBoard.get(boardSlug);
  const thread = queries.getThread.get(threadId, boardSlug);

  if (!board || !thread) {
    return res.status(404).send('Thread not found');
  }

  if (thread.is_locked) {
    return res.status(403).send(
      '<h2>Error: Thread is locked.</h2><a href="/' + boardSlug + '/thread/' + threadId + '">Back</a>'
    );
  }

  let { name, message } = req.body;

  message = stripEmoji(sanitize(message || ''));

  if (!message || message.length < 1) {
    return res.status(400).send(
      '<h2>Error: Message cannot be empty.</h2><a href="/' + boardSlug + '/thread/' + threadId + '">Back</a>'
    );
  }

  if (message.length > 5000) {
    return res.status(400).send(
      '<h2>Error: Message too long.</h2><a href="/' + boardSlug + '/thread/' + threadId + '">Back</a>'
    );
  }

  const { displayName, tripcode } = generateTrip(name);
  const authorField = tripcode ? displayName + ' ' + tripcode : displayName;

  const result = queries.createPost.run(threadId, boardSlug, authorField, message);

  // Bump тред (если не sage)
  const isSage = (name || '').toLowerCase().includes('sage');
  if (!isSage) {
    queries.bumpThread.run(threadId);
  }

  res.redirect('/' + boardSlug + '/thread/' + threadId + '#p' + result.lastInsertRowid);
});

// === 404 ===
app.use((req, res) => {
  res.status(404).send(`
    <div style="font-family:monospace;text-align:center;margin-top:100px;">
      <h1>404</h1>
      <p>Nothing here.</p>
      <a href="/">Back to QWA</a>
    </div>
  `);
});

// === ЗАПУСК ===
app.listen(PORT, () => {
  console.log(`[QWA] Forum running at http://localhost:${PORT}`);
});