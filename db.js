const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'qwa.db');
const db = new Database(dbPath);

// Включаем WAL для производительности
db.pragma('journal_mode = WAL');

// === СОЗДАНИЕ ТАБЛИЦ ===

db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_slug TEXT NOT NULL,
    subject TEXT DEFAULT '',
    author TEXT DEFAULT 'Anonymous',
    message TEXT NOT NULL,
    image_url TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    bumped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reply_count INTEGER DEFAULT 0,
    is_locked INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0,
    FOREIGN KEY (board_slug) REFERENCES boards(slug)
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    board_slug TEXT NOT NULL,
    author TEXT DEFAULT 'Anonymous',
    message TEXT NOT NULL,
    image_url TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (thread_id) REFERENCES threads(id),
    FOREIGN KEY (board_slug) REFERENCES boards(slug)
  );
`);

// === ЗАПОЛНЯЕМ БОРДЫ ПО УМОЛЧАНИЮ ===

const boardCount = db.prepare('SELECT COUNT(*) as cnt FROM boards').get().cnt;
if (boardCount === 0) {
  const insertBoard = db.prepare(
    'INSERT INTO boards (slug, name, description) VALUES (?, ?, ?)'
  );

  const defaultBoards = [
    ['b', 'Random', 'Pair randoms -- pair vsego'],
    ['tech', 'Technology', 'Kompyutery, programmirovanie, zhelezo'],
    ['g', 'Games', 'Igry, obsuzhdeniya, novosti'],
    ['mu', 'Music', 'Muzyka vsekh zhanrov'],
    ['a', 'Anime', 'Anime i manga'],
    ['hw', 'Hello World', 'Dlya novichkov na forume'],
    ['pol', 'Politics', 'Politika i obschestvo'],
    ['sci', 'Science', 'Nauka i obrazovanie']
  ];

  const insertMany = db.transaction((boards) => {
    for (const b of boards) {
      insertBoard.run(b[0], b[1], b[2]);
    }
  });

  insertMany(defaultBoards);
}

// === ПОДГОТОВЛЕННЫЕ ЗАПРОСЫ ===

const queries = {
  // Борды
  getAllBoards: db.prepare('SELECT * FROM boards ORDER BY id'),

  getBoard: db.prepare('SELECT * FROM boards WHERE slug = ?'),

  // Треды
  getThreadsByBoard: db.prepare(`
    SELECT t.*, 
      (SELECT COUNT(*) FROM posts WHERE thread_id = t.id) as reply_count_live
    FROM threads t
    WHERE t.board_slug = ?
    ORDER BY t.is_pinned DESC, t.bumped_at DESC
    LIMIT 50
  `),

  getThread: db.prepare('SELECT * FROM threads WHERE id = ? AND board_slug = ?'),

  createThread: db.prepare(`
    INSERT INTO threads (board_slug, subject, author, message, image_url)
    VALUES (?, ?, ?, ?, '')
  `),

  // Посты
  getPostsByThread: db.prepare(`
    SELECT * FROM posts WHERE thread_id = ? ORDER BY created_at ASC
  `),

  createPost: db.prepare(`
    INSERT INTO posts (thread_id, board_slug, author, message, image_url)
    VALUES (?, ?, ?, ?, '')
  `),

  bumpThread: db.prepare(`
    UPDATE threads SET bumped_at = CURRENT_TIMESTAMP WHERE id = ?
  `),

  getThreadCount: db.prepare(`
    SELECT COUNT(*) as cnt FROM threads WHERE board_slug = ?
  `),

  getPostCount: db.prepare(`
    SELECT COUNT(*) as cnt FROM posts WHERE board_slug = ?
  `),

  getTotalStats: db.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM threads) as total_threads,
      (SELECT COUNT(*) FROM posts) as total_posts
  `)
};

module.exports = { db, queries };