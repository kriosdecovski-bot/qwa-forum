const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'qwa.db');
let db;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    email_verified INTEGER DEFAULT 0,
    notify_replies INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS verify_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    admin_only INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_slug TEXT NOT NULL,
    subject TEXT DEFAULT '',
    author_name TEXT DEFAULT 'Anonymous',
    author_id INTEGER DEFAULT 0,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    bumped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_locked INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    board_slug TEXT NOT NULL,
    author_name TEXT DEFAULT 'Anonymous',
    author_id INTEGER DEFAULT 0,
    message TEXT NOT NULL,
    image_path TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const r = db.exec("SELECT COUNT(*) FROM boards");
  const count = r[0] ? r[0].values[0][0] : 0;

  if (count === 0) {
    const boards = [
      ['general',  'Общий',        'Разговоры на любые темы',                    0, 1],
      ['roblox',   'Roblox',       'Обсуждение игр в Roblox',                    0, 2],
      ['games',    'Игры',         'ПК, консоли, мобильные игры',                0, 3],
      ['politics', 'Политика',     'Политика и общество',                        0, 4],
      ['tech',     'Технологии',   'Программирование, железо, софт',             0, 5],
      ['music',    'Музыка',       'Музыка всех жанров',                         0, 6],
      ['anime',    'Anime',        'Аниме, манга, ранобэ',                       0, 7],
      ['random',   'Random',       'Обо всём и ни о чём',                        0, 8],
      ['news',     'Новости QWA',  'Официальные новости форума (только админы)', 1, 0]
    ];
    for (const b of boards) {
      db.run("INSERT INTO boards (slug,name,description,admin_only,sort_order) VALUES(?,?,?,?,?)", b);
    }
    save();
  }

  const adminCheck = db.exec("SELECT COUNT(*) FROM users WHERE role='admin'");
  const adminCount = adminCheck[0] ? adminCheck[0].values[0][0] : 0;

  if (adminCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.run(
      "INSERT INTO users (username,email,password_hash,role,email_verified) VALUES(?,?,?,?,?)",
      ['admin', 'admin@qwa.forum', hash, 'admin', 1]
    );
    save();
    console.log('[DB] Admin created: admin / admin123');
  }

  return db;
}

function save() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function rows(r) {
  if (!r || !r.length) return [];
  const c = r[0].columns;
  return r[0].values.map(v => {
    const o = {};
    c.forEach((k, i) => o[k] = v[i]);
    return o;
  });
}

function val(r, def) {
  if (!r || !r.length) return def;
  return r[0].values[0][0];
}

function buildQueries() {
  return {
    createUser: (username, email, hash) => {
      db.run("INSERT INTO users (username,email,password_hash) VALUES(?,?,?)", [username, email, hash]);
      save();
      return val(db.exec("SELECT last_insert_rowid()"), 0);
    },
    getUserByUsername: (u) => rows(db.exec("SELECT * FROM users WHERE username=?", [u]))[0] || null,
    getUserByEmail: (e) => rows(db.exec("SELECT * FROM users WHERE email=?", [e]))[0] || null,
    getUserById: (id) => rows(db.exec("SELECT * FROM users WHERE id=?", [id]))[0] || null,
    verifyUser: (id) => { db.run("UPDATE users SET email_verified=1 WHERE id=?", [id]); save(); },
    setUserRole: (id, role) => { db.run("UPDATE users SET role=? WHERE id=?", [role, id]); save(); },
    getAllUsers: () => rows(db.exec("SELECT id,username,email,role,email_verified,created_at FROM users ORDER BY id")),

    saveVerifyCode: (email, code) => {
      db.run("DELETE FROM verify_codes WHERE email=?", [email]);
      db.run("INSERT INTO verify_codes (email,code) VALUES(?,?)", [email, code]);
      save();
    },
    getVerifyCode: (email) => rows(db.exec("SELECT * FROM verify_codes WHERE email=? ORDER BY id DESC LIMIT 1", [email]))[0] || null,
    deleteVerifyCode: (email) => { db.run("DELETE FROM verify_codes WHERE email=?", [email]); save(); },

    getAllBoards: () => rows(db.exec("SELECT * FROM boards ORDER BY sort_order, id")),
    getBoard: (slug) => rows(db.exec("SELECT * FROM boards WHERE slug=?", [slug]))[0] || null,

    getThreadsByBoard: (slug) => rows(db.exec(`
      SELECT t.*, (SELECT COUNT(*) FROM posts WHERE thread_id=t.id) as reply_count
      FROM threads t WHERE board_slug=?
      ORDER BY is_pinned DESC, bumped_at DESC LIMIT 100
    `, [slug])),
    getThread: (id, slug) => rows(db.exec("SELECT * FROM threads WHERE id=? AND board_slug=?", [id, slug]))[0] || null,
    createThread: (slug, subject, authorName, authorId, message) => {
      db.run(
        "INSERT INTO threads (board_slug,subject,author_name,author_id,message) VALUES(?,?,?,?,?)",
        [slug, subject, authorName, authorId, message]
      );
      save();
      return val(db.exec("SELECT last_insert_rowid()"), 0);
    },
    deleteThread: (id) => {
      db.run("DELETE FROM posts WHERE thread_id=?", [id]);
      db.run("DELETE FROM threads WHERE id=?", [id]);
      save();
    },
    pinThread: (id, pin) => { db.run("UPDATE threads SET is_pinned=? WHERE id=?", [pin, id]); save(); },
    lockThread: (id, lock) => { db.run("UPDATE threads SET is_locked=? WHERE id=?", [lock, id]); save(); },

    getPostsByThread: (tid) => rows(db.exec("SELECT * FROM posts WHERE thread_id=? ORDER BY created_at", [tid])),
    createPost: (tid, slug, authorName, authorId, message, imagePath) => {
      db.run(
        "INSERT INTO posts (thread_id,board_slug,author_name,author_id,message,image_path) VALUES(?,?,?,?,?,?)",
        [tid, slug, authorName, authorId, message, imagePath || '']
      );
      save();
      return val(db.exec("SELECT last_insert_rowid()"), 0);
    },
    deletePost: (id) => { db.run("DELETE FROM posts WHERE id=?", [id]); save(); },
    bumpThread: (id) => { db.run("UPDATE threads SET bumped_at=CURRENT_TIMESTAMP WHERE id=?", [id]); save(); },

    getThreadCount: (slug) => ({ cnt: val(db.exec("SELECT COUNT(*) FROM threads WHERE board_slug=?", [slug]), 0) }),
    getPostCount: (slug) => ({ cnt: val(db.exec("SELECT COUNT(*) FROM posts WHERE board_slug=?", [slug]), 0) }),
    getTotalStats: () => ({
      total_threads: val(db.exec("SELECT COUNT(*) FROM threads"), 0),
      total_posts: val(db.exec("SELECT COUNT(*) FROM posts"), 0),
      total_users: val(db.exec("SELECT COUNT(*) FROM users"), 0)
    })
  };
}

module.exports = { initDB, buildQueries };