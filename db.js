const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000
});

async function initDB() {
  const client = await pool.connect();
  try {
    // Сессии
    await client.query(`CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire)`);

    // Пользователи
    await client.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'user',
      about TEXT DEFAULT '',
      avatar VARCHAR(255) DEFAULT '',
      email_verified INTEGER DEFAULT 0,
      notify_replies INTEGER DEFAULT 1,
      post_count INTEGER DEFAULT 0,
      is_banned INTEGER DEFAULT 0,
      is_muted INTEGER DEFAULT 0,
      ban_reason TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Добавляем новые колонки если их нет (для старых юзеров)
    const cols = ['avatar', 'is_banned', 'is_muted', 'ban_reason'];
    for (const col of cols) {
      try {
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col} ${
          col === 'avatar' ? "VARCHAR(255) DEFAULT ''" :
          col === 'ban_reason' ? "TEXT DEFAULT ''" :
          "INTEGER DEFAULT 0"
        }`);
      } catch(e) {}
    }

    // Коды верификации
    await client.query(`CREATE TABLE IF NOT EXISTS verify_codes (
      id SERIAL PRIMARY KEY,
      email VARCHAR(100) NOT NULL,
      code VARCHAR(10) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Борды
    await client.query(`CREATE TABLE IF NOT EXISTS boards (
      id SERIAL PRIMARY KEY,
      slug VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      description TEXT DEFAULT '',
      admin_only INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0
    )`);

    // Треды
    await client.query(`CREATE TABLE IF NOT EXISTS threads (
      id SERIAL PRIMARY KEY,
      board_slug VARCHAR(50) NOT NULL,
      subject VARCHAR(200) DEFAULT '',
      author_name VARCHAR(50) DEFAULT 'Anonymous',
      author_id INTEGER DEFAULT 0,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      bumped_at TIMESTAMP DEFAULT NOW(),
      is_locked INTEGER DEFAULT 0,
      is_pinned INTEGER DEFAULT 0
    )`);

    // Посты
    await client.query(`CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      thread_id INTEGER NOT NULL,
      board_slug VARCHAR(50) NOT NULL,
      author_name VARCHAR(50) DEFAULT 'Anonymous',
      author_id INTEGER DEFAULT 0,
      message TEXT NOT NULL,
      image_path VARCHAR(255) DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Личные сообщения
    await client.query(`CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      from_name VARCHAR(50) NOT NULL,
      to_name VARCHAR(50) NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Настройки форума (протокол Пекорин)
    await client.query(`CREATE TABLE IF NOT EXISTS forum_settings (
      key VARCHAR(50) PRIMARY KEY,
      value TEXT DEFAULT ''
    )`);

    // Дефолтные настройки
    const settingsCheck = await client.query("SELECT COUNT(*)::int as cnt FROM forum_settings");
    if (settingsCheck.rows[0].cnt === 0) {
      await client.query("INSERT INTO forum_settings (key,value) VALUES('forum_disabled','false')");
      await client.query("INSERT INTO forum_settings (key,value) VALUES('disabled_message','Форум временно отключён.')");
    }

    // Борды по умолчанию
    const boardCheck = await client.query("SELECT COUNT(*)::int as cnt FROM boards");
    if (boardCheck.rows[0].cnt === 0) {
      const boards = [
        ['news',     'Новости QWA',  'Официальные новости форума',              1, 0],
        ['general',  'Общий',        'Разговоры на любые темы',                  0, 1],
        ['roblox',   'Roblox',       'Всё о Roblox: игры, скрипты, обсуждения',  0, 2],
        ['games',    'Игры',         'ПК, консоли, мобильные игры',              0, 3],
        ['politics', 'Политика',     'Политика и общество',                      0, 4],
        ['tech',     'Технологии',   'Программирование, железо, софт',           0, 5],
        ['music',    'Музыка',       'Музыка всех жанров',                       0, 6],
        ['anime',    'Аниме',        'Аниме, манга, ранобэ',                     0, 7],
        ['creative', 'Творчество',   'Арт, видео, рассказы, проекты',            0, 8],
        ['random',   'Random',       'Обо всём и ни о чём',                      0, 9]
      ];
      for (const b of boards) {
        await client.query("INSERT INTO boards (slug,name,description,admin_only,sort_order) VALUES($1,$2,$3,$4,$5)", b);
      }
    }

    // Владелец Peko
    const ownerCheck = await client.query("SELECT COUNT(*)::int as cnt FROM users WHERE role='owner'");
    if (ownerCheck.rows[0].cnt === 0) {
      // Проверяем есть ли admin, меняем его на owner
      const adminExists = await client.query("SELECT id FROM users WHERE username='admin'");
      if (adminExists.rows.length > 0) {
        await client.query("UPDATE users SET username='Peko', role='owner' WHERE username='admin'");
        console.log('[DB] admin переименован в Peko (owner)');
      } else {
        const hash = bcrypt.hashSync('admin123', 10);
        await client.query(
          "INSERT INTO users (username,email,password_hash,role,email_verified) VALUES($1,$2,$3,$4,$5)",
          ['Peko', 'admin@qwa.forum', hash, 'owner', 1]
        );
        console.log('[DB] Владелец создан: Peko / admin123');
      }
    }

    console.log('[DB] База данных готова');
  } finally {
    client.release();
  }
}

function buildQueries() {
  return {
    // === Пользователи ===
    createUser: async (username, email, hash) => {
      const r = await pool.query(
        "INSERT INTO users (username,email,password_hash) VALUES($1,$2,$3) RETURNING id",
        [username, email, hash]
      );
      return r.rows[0].id;
    },
    getUserByUsername: async (u) => {
      const r = await pool.query("SELECT * FROM users WHERE username=$1", [u]);
      return r.rows[0] || null;
    },
    getUserByEmail: async (e) => {
      const r = await pool.query("SELECT * FROM users WHERE email=$1", [e]);
      return r.rows[0] || null;
    },
    getUserById: async (id) => {
      const r = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
      return r.rows[0] || null;
    },
    verifyUser: async (id) => {
      await pool.query("UPDATE users SET email_verified=1 WHERE id=$1", [id]);
    },
    updateAbout: async (id, about) => {
      await pool.query("UPDATE users SET about=$1 WHERE id=$2", [about, id]);
    },
    updateAvatar: async (id, avatar) => {
      await pool.query("UPDATE users SET avatar=$1 WHERE id=$2", [avatar, id]);
    },
    setUserRole: async (id, role) => {
      await pool.query("UPDATE users SET role=$1 WHERE id=$2", [role, id]);
    },
    banUser: async (id, reason) => {
      await pool.query("UPDATE users SET is_banned=1, ban_reason=$1 WHERE id=$2", [reason, id]);
    },
    unbanUser: async (id) => {
      await pool.query("UPDATE users SET is_banned=0, ban_reason='' WHERE id=$1", [id]);
    },
    muteUser: async (id) => {
      await pool.query("UPDATE users SET is_muted=1 WHERE id=$1", [id]);
    },
    unmuteUser: async (id) => {
      await pool.query("UPDATE users SET is_muted=0 WHERE id=$1", [id]);
    },
    incrementPostCount: async (id) => {
      await pool.query("UPDATE users SET post_count = post_count + 1 WHERE id=$1", [id]);
    },
    getAllUsers: async () => {
      const r = await pool.query(
        "SELECT id,username,email,role,email_verified,post_count,is_banned,is_muted,avatar,created_at FROM users ORDER BY id"
      );
      return r.rows;
    },

    // === Коды ===
    saveVerifyCode: async (email, code) => {
      await pool.query("DELETE FROM verify_codes WHERE email=$1", [email]);
      await pool.query("INSERT INTO verify_codes (email,code) VALUES($1,$2)", [email, code]);
    },
    getVerifyCode: async (email) => {
      const r = await pool.query("SELECT * FROM verify_codes WHERE email=$1 ORDER BY id DESC LIMIT 1", [email]);
      return r.rows[0] || null;
    },
    deleteVerifyCode: async (email) => {
      await pool.query("DELETE FROM verify_codes WHERE email=$1", [email]);
    },

    // === Борды ===
    getAllBoards: async () => {
      const r = await pool.query("SELECT * FROM boards ORDER BY sort_order, id");
      return r.rows;
    },
    getBoard: async (slug) => {
      const r = await pool.query("SELECT * FROM boards WHERE slug=$1", [slug]);
      return r.rows[0] || null;
    },

    // === Треды ===
    getThreadsByBoard: async (slug) => {
      const r = await pool.query(`
        SELECT t.*, (SELECT COUNT(*)::int FROM posts WHERE thread_id=t.id) as reply_count
        FROM threads t WHERE board_slug=$1
        ORDER BY is_pinned DESC, bumped_at DESC LIMIT 100
      `, [slug]);
      return r.rows;
    },
    getThread: async (id, slug) => {
      const r = await pool.query("SELECT * FROM threads WHERE id=$1 AND board_slug=$2", [id, slug]);
      return r.rows[0] || null;
    },
    createThread: async (slug, subject, authorName, authorId, message) => {
      const r = await pool.query(
        "INSERT INTO threads (board_slug,subject,author_name,author_id,message) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [slug, subject, authorName, authorId, message]
      );
      return r.rows[0].id;
    },
    deleteThread: async (id) => {
      await pool.query("DELETE FROM posts WHERE thread_id=$1", [id]);
      await pool.query("DELETE FROM threads WHERE id=$1", [id]);
    },
    pinThread: async (id, pin) => {
      await pool.query("UPDATE threads SET is_pinned=$1 WHERE id=$2", [pin, id]);
    },
    lockThread: async (id, lock) => {
      await pool.query("UPDATE threads SET is_locked=$1 WHERE id=$2", [lock, id]);
    },

    // === Посты ===
    getPostsByThread: async (tid) => {
      const r = await pool.query("SELECT p.*, u.avatar, u.role as author_role FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.thread_id=$1 ORDER BY p.created_at", [tid]);
      return r.rows;
    },
    createPost: async (tid, slug, authorName, authorId, message, imagePath) => {
      const r = await pool.query(
        "INSERT INTO posts (thread_id,board_slug,author_name,author_id,message,image_path) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
        [tid, slug, authorName, authorId, message, imagePath || '']
      );
      return r.rows[0].id;
    },
    deletePost: async (id) => {
      await pool.query("DELETE FROM posts WHERE id=$1", [id]);
    },
    bumpThread: async (id) => {
      await pool.query("UPDATE threads SET bumped_at=NOW() WHERE id=$1", [id]);
    },

    // === Личные сообщения ===
    sendMessage: async (fromId, toId, fromName, toName, message) => {
      await pool.query(
        "INSERT INTO messages (from_id,to_id,from_name,to_name,message) VALUES($1,$2,$3,$4,$5)",
        [fromId, toId, fromName, toName, message]
      );
    },
    getInbox: async (userId) => {
      const r = await pool.query(
        "SELECT * FROM messages WHERE to_id=$1 ORDER BY created_at DESC LIMIT 100", [userId]
      );
      return r.rows;
    },
    getSent: async (userId) => {
      const r = await pool.query(
        "SELECT * FROM messages WHERE from_id=$1 ORDER BY created_at DESC LIMIT 100", [userId]
      );
      return r.rows;
    },
    getConversation: async (userId1, userId2) => {
      const r = await pool.query(
        "SELECT * FROM messages WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1) ORDER BY created_at ASC LIMIT 200",
        [userId1, userId2]
      );
      return r.rows;
    },
    markRead: async (messageId, userId) => {
      await pool.query("UPDATE messages SET is_read=1 WHERE id=$1 AND to_id=$2", [messageId, userId]);
    },
    getUnreadCount: async (userId) => {
      const r = await pool.query("SELECT COUNT(*)::int as cnt FROM messages WHERE to_id=$1 AND is_read=0", [userId]);
      return r.rows[0].cnt;
    },

    // === Настройки форума ===
    getSetting: async (key) => {
      const r = await pool.query("SELECT value FROM forum_settings WHERE key=$1", [key]);
      return r.rows[0] ? r.rows[0].value : null;
    },
    setSetting: async (key, value) => {
      await pool.query(
        "INSERT INTO forum_settings (key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2",
        [key, value]
      );
    },

    // === Поиск ===
    searchThreads: async (query) => {
      const r = await pool.query(`
        SELECT t.*, b.name as board_name,
          (SELECT COUNT(*)::int FROM posts WHERE thread_id=t.id) as reply_count
        FROM threads t JOIN boards b ON b.slug = t.board_slug
        WHERE t.subject ILIKE $1 OR t.message ILIKE $1
        ORDER BY t.bumped_at DESC LIMIT 50
      `, ['%' + query + '%']);
      return r.rows;
    },

    // === Статистика ===
    getThreadCount: async (slug) => {
      const r = await pool.query("SELECT COUNT(*)::int as cnt FROM threads WHERE board_slug=$1", [slug]);
      return { cnt: r.rows[0].cnt };
    },
    getPostCount: async (slug) => {
      const r = await pool.query("SELECT COUNT(*)::int as cnt FROM posts WHERE board_slug=$1", [slug]);
      return { cnt: r.rows[0].cnt };
    },
    getTotalStats: async () => {
      const t = await pool.query("SELECT COUNT(*)::int as cnt FROM threads");
      const p = await pool.query("SELECT COUNT(*)::int as cnt FROM posts");
      const u = await pool.query("SELECT COUNT(*)::int as cnt FROM users");
      return { total_threads: t.rows[0].cnt, total_posts: p.rows[0].cnt, total_users: u.rows[0].cnt };
    },
    getRecentPosts: async (limit) => {
      const r = await pool.query(`
        SELECT p.*, t.subject as thread_subject, b.name as board_name
        FROM posts p JOIN threads t ON t.id = p.thread_id JOIN boards b ON b.slug = p.board_slug
        ORDER BY p.created_at DESC LIMIT $1
      `, [limit || 10]);
      return r.rows;
    }
  };
}

module.exports = { initDB, buildQueries };