const session = require('express-session');

const defer = typeof setImmediate === 'function'
  ? setImmediate
  : (fn, ...args) => process.nextTick(() => fn(...args));

class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.getStmt = db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?');
    this.setStmt = db.prepare(`
      INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire
    `);
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?');
    db.prepare('DELETE FROM sessions WHERE expire <= ?').run(Date.now());
  }

  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid);
      if (!row || row.expire <= Date.now()) {
        if (row) this.destroyStmt.run(sid);
        defer(callback, null, null);
        return;
      }
      defer(callback, null, JSON.parse(row.sess));
    } catch (err) {
      defer(callback, err);
    }
  }

  set(sid, sess, callback) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), expiryOf(sess));
      if (callback) defer(callback, null);
    } catch (err) {
      if (callback) defer(callback, err);
    }
  }

  destroy(sid, callback) {
    try {
      this.destroyStmt.run(sid);
      if (callback) defer(callback, null);
    } catch (err) {
      if (callback) defer(callback, err);
    }
  }

  touch(sid, sess, callback) {
    try {
      this.touchStmt.run(expiryOf(sess), sid);
      if (callback) defer(callback, null);
    } catch (err) {
      if (callback) defer(callback, err);
    }
  }
}

function expiryOf(sess) {
  const expires = sess && sess.cookie && sess.cookie.expires;
  const parsed = expires ? new Date(expires).getTime() : NaN;
  if (Number.isFinite(parsed)) return parsed;
  const maxAge = sess && sess.cookie && sess.cookie.maxAge;
  if (Number.isFinite(maxAge)) return Date.now() + maxAge;
  // 瀏覽器工作階段 cookie 沒有到期日，資料庫仍保留，關掉瀏覽器後 cookie 自己消失。
  return Date.now() + 30 * 24 * 60 * 60 * 1000;
}

module.exports = { SqliteStore };
