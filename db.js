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
    // Таблица сессий (обязательно первой!)
    await client.query(`
      CREATE TABLE IF NOT EXISTS session (
        sid VARCHAR NOT NULL PRIMARY KEY,
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'user',
        about TEXT DEFAULT '',
        email_verified INTEGER DEFAULT 0,
        notify_replies INTEGER DEFAULT 1,
        post_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS verify_codes (
        id SERIAL PRIMARY KEY,
        email VARCHAR(100) NOT NULL,
        code VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS boards (
        id SERIAL PRIMARY KEY,
        slug VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT DEFAULT '',
        admin_only INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS threads (
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
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        thread_id INTEGER NOT NULL,
        board_slug VARCHAR(50) NOT NULL,
        author_name VARCHAR(50) DEFAULT 'Anonymous',
        author_id INTEGER DEFAULT 0,
        message TEXT NOT NULL,
        image_path VARCHAR(255) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

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
        await client.query(
          "INSERT INTO boards (slug,name,description,admin_only,sort_order) VALUES($1,$2,$3,$4,$5)", b
        );
      }
    }

    // Админ по умолчанию
    const adminCheck = await client.query("SELECT COUNT(*)::int as cnt FROM users WHERE role='admin'");
    if (adminCheck.rows[0].cnt === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      await client.query(
        "INSERT INTO users (username,email,password_hash,role,email_verified) VALUES($1,$2,$3,$4,$5)",
        ['admin', 'admin@qwa.forum', hash, 'admin', 1]
      );
      console.log('[DB] Админ создан: admin / admin123');
    }

    console.log('[DB] База данных готова');
  } finally {
    client.release();
  }
}

function buildQueries() {
  return {
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
    setUserRole: async (id, role) => {
      await pool.query("UPDATE users SET role=$1 WHERE id=$2", [role, id]);
    },
    incrementPostCount: async (id) => {
      await pool.query("UPDATE users SET post_count = post_count + 1 WHERE id=$1", [id]);
    },
    getAllUsers: async () => {
      const r = await pool.query(
        "SELECT id,username,email,role,email_verified,post_count,created_at FROM users ORDER BY id"
      );
      return r.rows;
    },

    saveVerifyCode: async (email, code) => {
      await pool.query("DELETE FROM verify_codes WHERE email=$1", [email]);
      await pool.query("INSERT INTO verify_codes (email,code) VALUES($1,$2)", [email, code]);
    },
    getVerifyCode: async (email) => {
      const r = await pool.query(
        "SELECT * FROM verify_codes WHERE email=$1 ORDER BY id DESC LIMIT 1", [email]
      );
      return r.rows[0] || null;
    },
    deleteVerifyCode: async (email) => {
      await pool.query("DELETE FROM verify_codes WHERE email=$1", [email]);
    },

    getAllBoards: async () => {
      const r = await pool.query("SELECT * FROM boards ORDER BY sort_order, id");
      return r.rows;
    },
    getBoard: async (slug) => {
      const r = await pool.query("SELECT * FROM boards WHERE slug=$1", [slug]);
      return r.rows[0] || null;
    },

    getThreadsByBoard: async (slug) => {
      const r = await pool.query(`
        SELECT t.*, (SELECT COUNT(*)::int FROM posts WHERE thread_id=t.id) as reply_count
        FROM threads t WHERE board_slug=$1
        ORDER BY is_pinned DESC, bumped_at DESC LIMIT 100
      `, [slug]);
      return r.rows;
    },
    getThread: async (id, slug) => {
      const r = await pool.query(
        "SELECT * FROM threads WHERE id=$1 AND board_slug=$2", [id, slug]
      );
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

    getPostsByThread: async (tid) => {
      const r = await pool.query(
        "SELECT * FROM posts WHERE thread_id=$1 ORDER BY created_at", [tid]
      );
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

    searchThreads: async (query) => {
      const r = await pool.query(`
        SELECT t.*, b.name as board_name,
          (SELECT COUNT(*)::int FROM posts WHERE thread_id=t.id) as reply_count
        FROM threads t
        JOIN boards b ON b.slug = t.board_slug
        WHERE t.subject ILIKE $1 OR t.message ILIKE $1
        ORDER BY t.bumped_at DESC LIMIT 50
      `, ['%' + query + '%']);
      return r.rows;
    },

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
      return {
        total_threads: t.rows[0].cnt,
        total_posts: p.rows[0].cnt,
        total_users: u.rows[0].cnt
      };
    },

    getRecentPosts: async (limit) => {
      const r = await pool.query(`
        SELECT p.*, t.subject as thread_subject, b.name as board_name
        FROM posts p
        JOIN threads t ON t.id = p.thread_id
        JOIN boards b ON b.slug = p.board_slug
        ORDER BY p.created_at DESC LIMIT $1
      `, [limit || 10]);
      return r.rows;
    }
  };
}

module.exports = { initDB, buildQueries };