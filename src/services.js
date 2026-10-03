const crypto = require('crypto');
const { AppError } = require('./errors');
const { CATEGORIES, ENDOWMENTS, MAX_AMOUNT } = require('./constants');
const { taipeiDate } = require('./time');
const sms = require('./sms');

function createServices(db, options = {}) {
  const now = options.now || (() => new Date());

  function clock() {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  }

  function normalizeMobile(raw) {
    const digits = String(raw || '').replace(/[\s-]/g, '');
    if (!/^09\d{8}$/.test(digits)) {
      throw new AppError('請輸入台灣手機號碼，例如 0912345678。');
    }
    return digits;
  }

  function cleanName(raw, max = 20) {
    const name = String(raw || '').replace(/[\u0000-\u001F]/g, '').trim();
    if (name.length < 1 || [...name].length > max) {
      throw new AppError(`名稱請填 1 到 ${max} 個字。`);
    }
    return name;
  }

  function cleanText(raw, label, { min = 1, max = 1000 } = {}) {
    const text = String(raw || '').replace(/\r\n/g, '\n').trim();
    if ([...text].length < min) throw new AppError(`${label}必須填寫。`);
    if ([...text].length > max) throw new AppError(`${label}請不要超過 ${max} 個字。`);
    return text;
  }

  function cleanComment(raw) {
    const text = String(raw || '').replace(/\r\n/g, '\n').trim();
    if (!text) return null;
    if ([...text].length > 500) throw new AppError('備註請在 500 字以內。');
    return text;
  }

  function parseAmount(raw, label, min) {
    const text = String(raw ?? '').trim();
    if (!/^\d+$/.test(text)) throw new AppError(`${label}請填 0 以上的整數。`);
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < min || value > MAX_AMOUNT) {
      throw new AppError(`${label}超出範圍。`);
    }
    return value;
  }

  function hashOtp(mobile, code) {
    const pepper = process.env.SESSION_SECRET || 'zeus-dev-pepper';
    return crypto.createHash('sha256').update(`${pepper}:${mobile}:${code}`).digest('hex');
  }

  function mustUser(id) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw new AppError('找不到使用者。');
    return user;
  }

  function findByMobile(mobile) {
    return db.prepare('SELECT * FROM users WHERE mobile = ?').get(mobile) || null;
  }

  function insertUser({ mobile, displayName, role }) {
    const endowment = ENDOWMENTS[role];
    const info = db.prepare(`
      INSERT INTO users (mobile, display_name, role, merit, quota, blocked, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(mobile, displayName, role, endowment.merit, endowment.quota, clock().toISOString());
    return mustUser(Number(info.lastInsertRowid));
  }

  function endow(user, role, floor) {
    if (user.role === role) return user;
    const merit = Math.max(user.merit, floor.merit);
    const quota = Math.max(user.quota, floor.quota, merit);
    db.prepare('UPDATE users SET role = ?, merit = ?, quota = ? WHERE id = ?')
      .run(role, merit, quota, user.id);
    return mustUser(user.id);
  }

  function assertFounder(actorId) {
    const actor = mustUser(actorId);
    if (actor.role !== 'founder') throw new AppError('只有創辦人可以做這件事。');
    return actor;
  }

  function ratingSummary(userId) {
    const row = db.prepare(`
      SELECT COUNT(*) AS count, AVG(stars) AS avg
      FROM ratings WHERE ratee_id = ?
    `).get(userId);
    return {
      ratingCount: row.count,
      ratingAvg: row.count ? Math.round(row.avg * 10) / 10 : null,
    };
  }

  async function requestOtp(rawMobile) {
    const mobile = normalizeMobile(rawMobile);
    const since = clock().getTime() - 10 * 60 * 1000;
    const recent = db.prepare(`
      SELECT COUNT(*) AS count FROM otp_codes WHERE mobile = ? AND created_at >= ?
    `).get(mobile, since).count;
    if (recent >= 5) throw new AppError('驗證碼要得太頻繁，請 10 分鐘後再試。');

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const sent = await sms.sendOtp(mobile, code);
    const timestamp = clock().getTime();
    db.prepare('UPDATE otp_codes SET consumed = 1 WHERE mobile = ? AND consumed = 0').run(mobile);
    db.prepare(`
      INSERT INTO otp_codes (mobile, code_hash, expires_at, consumed, created_at)
      VALUES (?, ?, ?, 0, ?)
    `).run(mobile, hashOtp(mobile, code), timestamp + 10 * 60 * 1000, timestamp);

    return { mobile, devCode: sent.mode === 'dev' ? code : null };
  }

  function verifyOtp(rawMobile, rawCode) {
    const mobile = normalizeMobile(rawMobile);
    const code = String(rawCode || '').trim();
    if (!/^\d{6}$/.test(code)) throw new AppError('請輸入 6 位數驗證碼。');

    const row = db.prepare(`
      SELECT * FROM otp_codes
      WHERE mobile = ? AND consumed = 0
      ORDER BY id DESC LIMIT 1
    `).get(mobile);
    const expired = !row || row.expires_at < clock().getTime();
    const actual = Buffer.from(hashOtp(mobile, code), 'hex');
    const expected = row ? Buffer.from(row.code_hash, 'hex') : Buffer.alloc(actual.length);
    const matches = !!row && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (expired || !matches) throw new AppError('驗證碼不正確或已過期。');

    db.prepare('UPDATE otp_codes SET consumed = 1 WHERE id = ?').run(row.id);
    return { mobile, user: findByMobile(mobile) };
  }

  function register(rawMobile, displayName) {
    const mobile = normalizeMobile(rawMobile);
    if (findByMobile(mobile)) throw new AppError('這個手機號碼已經註冊，請直接登入。');
    return insertUser({ mobile, displayName: cleanName(displayName), role: 'user' });
  }

  function seedFounder(rawMobile, displayName) {
    const mobile = normalizeMobile(rawMobile);
    const name = cleanName(displayName || '創辦人');
    const existing = findByMobile(mobile);
    if (!existing) return insertUser({ mobile, displayName: name, role: 'founder' });
    if (existing.role === 'founder') return existing;
    const updated = endow(existing, 'founder', ENDOWMENTS.founder);
    if (updated.display_name !== name && displayName) {
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, updated.id);
      return mustUser(updated.id);
    }
    return updated;
  }

  function createPost(authorId, input) {
    const author = mustUser(authorId);
    if (author.blocked) throw new AppError('你的帳號已被封鎖，不能發布或接下。');
    const kind = input.kind;
    if (kind !== 'offer' && kind !== 'need') throw new AppError('請選擇「我可以提供」或「我需要」。');
    if (author.role === 'org' && kind !== 'need') {
      throw new AppError('福利機構只能發布「我需要」。幫忙的人完成後，功德由機構付出。');
    }
    if (!CATEGORIES[input.category]) throw new AppError('請選擇食物、交通或其他。');
    const description = cleanText(input.description, '描述');
    const amount = parseAmount(input.amount, '金額', 1);
    const info = db.prepare(`
      INSERT INTO posts (author_id, kind, category, description, amount, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `).run(author.id, kind, input.category, description, amount, clock().toISOString());
    return { id: Number(info.lastInsertRowid) };
  }

  function acceptPost(postId, userId) {
    return db.transaction(() => {
      const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
      if (!post || post.status !== 'open') throw new AppError('這則已經不能接下。');
      const actor = mustUser(userId);
      const author = mustUser(post.author_id);
      if (actor.blocked) throw new AppError('你的帳號已被封鎖，不能發布或接下。');
      if (author.blocked) throw new AppError('發布者已被封鎖，這則不能接下。');
      if (actor.id === author.id) throw new AppError('不能接下自己的貼文。');

      const payer = post.kind === 'offer' ? actor : author;
      const host = post.kind === 'offer' ? author : actor;
      if (payer.role === 'user' && !(payer.merit - post.amount > 0)) {
        const who = payer.id === actor.id ? '你' : '對方';
        throw new AppError(
          `${who}的功德是 ${payer.merit}，這則標示 ${post.amount}。一般使用者要接下或被配對，功德減去金額後必須大於 0。`
        );
      }

      const changed = db.prepare(`
        UPDATE posts
        SET status = 'matched', accepter_id = ?, host_id = ?, seeker_id = ?, matched_at = ?
        WHERE id = ? AND status = 'open'
      `).run(actor.id, host.id, payer.id, clock().toISOString(), post.id);
      if (changed.changes !== 1) throw new AppError('這則已經不能接下。');
      return { id: post.id };
    }).immediate();
  }

  function cancelPost(postId, userId) {
    const changed = db.prepare(`
      UPDATE posts SET status = 'cancelled'
      WHERE id = ? AND author_id = ? AND status = 'open'
    `).run(postId, userId);
    if (changed.changes !== 1) throw new AppError('這則不能取消。');
  }

  // 同一對帳號每個台北日只能結算一次。
  // 這一次會讓雙方功德額度各增加結算金額。隔日再次結算會再增加額度。這是規則。
  function attemptSettle(postId) {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
    if (!post || post.status !== 'matched') throw new AppError('這則目前不能結算。');
    if (post.host_value == null || post.seeker_value == null) return { status: 'waiting' };

    const hostValue = post.host_value;
    const seekerValue = post.seeker_value;
    const amount = hostValue === 0 || seekerValue === 0 ? 0 : Math.min(hostValue, seekerValue);
    const date = taipeiDate(clock());
    const lo = Math.min(post.host_id, post.seeker_id);
    const hi = Math.max(post.host_id, post.seeker_id);
    const existing = db.prepare(`
      SELECT post_id FROM daily_settlements
      WHERE user_lo = ? AND user_hi = ? AND taipei_date = ?
    `).get(lo, hi, date);
    if (existing) {
      return {
        status: 'daily',
        message: `你們兩位在台北時間 ${date} 已經結算過一次。同一對帳號一天只能結算一次，這也是當天彼此功德額度唯一會增加的一次。明天可以再結算，額度會再增加。`,
      };
    }

    const payer = db.prepare('SELECT id, merit, role FROM users WHERE id = ?').get(post.seeker_id);
    if (payer.merit < amount) {
      const roleName = payer.role === 'org' ? '福利機構' : payer.role === 'founder' ? '創辦人' : '接受幫助的人';
      return {
        status: 'insufficient',
        message: `${roleName}目前有 ${payer.merit} 功德，這次結算是 ${amount}，扣完會變成負數，所以不能完成。餘額沒有變動。請改填較低的金額。`,
      };
    }

    db.prepare('UPDATE users SET quota = quota + ?, merit = merit - ? WHERE id = ?')
      .run(amount, amount, post.seeker_id);
    db.prepare('UPDATE users SET quota = quota + ?, merit = merit + ? WHERE id = ?')
      .run(amount, amount, post.host_id);
    db.prepare(`
      INSERT INTO daily_settlements (user_lo, user_hi, taipei_date, post_id, amount)
      VALUES (?, ?, ?, ?, ?)
    `).run(lo, hi, date, post.id, amount);
    db.prepare(`
      UPDATE posts
      SET status = 'settled', settled_amount = ?, settled_on = ?, settled_at = ?
      WHERE id = ?
    `).run(amount, date, clock().toISOString(), post.id);

    const parties = db.prepare('SELECT merit, quota FROM users WHERE id IN (?, ?)').all(post.host_id, post.seeker_id);
    for (const row of parties) {
      if (row.merit < 0 || row.merit > row.quota) {
        throw new AppError('結算會讓功德變成負數或超過額度，已取消，餘額沒有變動。');
      }
    }

    return { status: 'settled', amount, hostValue, seekerValue, date };
  }

  function submitValue(postId, userId, rawValue) {
    const value = parseAmount(rawValue, '估價', 0);
    return db.transaction(() => {
      const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
      if (!post || post.status !== 'matched') throw new AppError('這則目前不能填寫估價。');
      if (userId !== post.host_id && userId !== post.seeker_id) {
        throw new AppError('只有這次互助的雙方可以填寫。');
      }
      const column = userId === post.host_id ? 'host_value' : 'seeker_value';
      db.prepare(`UPDATE posts SET ${column} = ? WHERE id = ?`).run(value, post.id);
      return attemptSettle(post.id);
    }).immediate();
  }

  function retrySettle(postId, userId) {
    return db.transaction(() => {
      const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
      if (!post || post.status !== 'matched') throw new AppError('這則目前不能結算。');
      if (userId !== post.host_id && userId !== post.seeker_id) {
        throw new AppError('只有這次互助的雙方可以結算。');
      }
      if (post.host_value == null || post.seeker_value == null) {
        throw new AppError('雙方都要先填寫這次值多少。');
      }
      return attemptSettle(post.id);
    }).immediate();
  }

  function rate(postId, userId, rawStars, rawComment) {
    const stars = Number(rawStars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new AppError('請給 1 到 5 顆星。');
    const comment = cleanComment(rawComment);
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
    if (!post || post.status !== 'settled') throw new AppError('結算完成後才能評分。');
    if (userId !== post.host_id && userId !== post.seeker_id) throw new AppError('只有雙方可以評分。');
    const rateeId = userId === post.host_id ? post.seeker_id : post.host_id;
    try {
      db.prepare(`
        INSERT INTO ratings (post_id, rater_id, ratee_id, stars, comment, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(post.id, userId, rateeId, stars, comment, clock().toISOString());
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new AppError('你已經評過這次互助。');
      throw err;
    }
  }

  function blockUser(actorId, rawMobile, reason) {
    assertFounder(actorId);
    const user = findByMobile(normalizeMobile(rawMobile));
    if (!user) throw new AppError('找不到這個手機號碼。');
    if (user.id === actorId) throw new AppError('不能封鎖自己。');
    const why = cleanText(reason || '收取現金', '原因', { max: 200 });
    db.prepare('UPDATE users SET blocked = 1, block_reason = ? WHERE id = ?').run(why, user.id);
    return mustUser(user.id);
  }

  function unblockUser(actorId, rawMobile) {
    assertFounder(actorId);
    const user = findByMobile(normalizeMobile(rawMobile));
    if (!user) throw new AppError('找不到這個手機號碼。');
    db.prepare('UPDATE users SET blocked = 0, block_reason = NULL WHERE id = ?').run(user.id);
    return mustUser(user.id);
  }

  function closePendingApplications(userId, status, keepId) {
    db.prepare(`
      UPDATE org_applications SET status = ?
      WHERE user_id = ? AND status = 'pending' AND id != ?
    `).run(status, userId, keepId || 0);
  }

  function createOrg(actorId, rawMobile, displayName) {
    assertFounder(actorId);
    const mobile = normalizeMobile(rawMobile);
    const name = cleanName(displayName, 30);
    const existing = findByMobile(mobile);
    if (!existing) {
      const user = insertUser({ mobile, displayName: name, role: 'org' });
      return { user, created: true };
    }
    if (existing.role === 'founder') throw new AppError('創辦人不能改成福利機構。');
    if (existing.role === 'org') throw new AppError('這個帳號已經是福利機構。');
    if (existing.blocked) throw new AppError('這個帳號已被封鎖。');
    const user = endow(existing, 'org', ENDOWMENTS.org);
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, user.id);
    db.prepare(`UPDATE org_applications SET status = 'approved' WHERE user_id = ? AND status = 'pending'`).run(user.id);
    return { user: mustUser(user.id), created: false };
  }

  function applyOrg(userId, orgName) {
    const user = mustUser(userId);
    if (user.blocked) throw new AppError('被封鎖的帳號不能申請。');
    if (user.role === 'org') throw new AppError('你已經是福利機構。');
    if (user.role === 'founder') throw new AppError('創辦人不用申請福利機構。');
    const name = cleanName(orgName, 30);
    const pending = db.prepare(`
      SELECT id FROM org_applications WHERE user_id = ? AND status = 'pending'
    `).get(userId);
    if (pending) throw new AppError('你已經有一份申請在等審核。');
    db.prepare(`
      INSERT INTO org_applications (user_id, org_name, status, created_at)
      VALUES (?, ?, 'pending', ?)
    `).run(userId, name, clock().toISOString());
  }

  function approveApplication(actorId, applicationId) {
    assertFounder(actorId);
    return db.transaction(() => {
      const application = db.prepare('SELECT * FROM org_applications WHERE id = ?').get(applicationId);
      if (!application || application.status !== 'pending') throw new AppError('這份申請不在待審。');
      const user = mustUser(application.user_id);
      if (user.role === 'founder') throw new AppError('創辦人不能改成福利機構。');
      if (user.blocked) throw new AppError('這個帳號已被封鎖。');
      if (user.role !== 'org') endow(user, 'org', ENDOWMENTS.org);
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(application.org_name, user.id);
      db.prepare(`UPDATE org_applications SET status = 'approved' WHERE id = ?`).run(application.id);
      closePendingApplications(user.id, 'rejected', application.id);
      return mustUser(user.id);
    }).immediate();
  }

  function rejectApplication(actorId, applicationId) {
    assertFounder(actorId);
    const application = db.prepare('SELECT * FROM org_applications WHERE id = ?').get(applicationId);
    if (!application || application.status !== 'pending') throw new AppError('這份申請不在待審。');
    db.prepare(`UPDATE org_applications SET status = 'rejected' WHERE id = ?`).run(application.id);
  }

  function latestApplication(userId) {
    return db.prepare(`
      SELECT id, org_name, status, created_at
      FROM org_applications WHERE user_id = ? ORDER BY id DESC LIMIT 1
    `).get(userId) || null;
  }

  function listOpenPosts() {
    return db.prepare(`
      SELECT p.id, p.kind, p.category, p.description, p.amount, p.created_at,
             u.id AS author_id, u.display_name AS author_name, u.role AS author_role,
             (SELECT ROUND(AVG(stars), 1) FROM ratings WHERE ratee_id = u.id) AS author_avg,
             (SELECT COUNT(*) FROM ratings WHERE ratee_id = u.id) AS author_count
      FROM posts p
      JOIN users u ON u.id = p.author_id
      WHERE p.status = 'open' AND u.blocked = 0
      ORDER BY p.id DESC
      LIMIT 50
    `).all();
  }

  function dashboard(userId) {
    const user = mustUser(userId);
    const posts = db.prepare(`
      SELECT p.id, p.kind, p.category, p.description, p.amount, p.status,
             p.settled_amount, p.created_at, p.author_id,
             a.display_name AS author_name, b.display_name AS accepter_name
      FROM posts p
      JOIN users a ON a.id = p.author_id
      LEFT JOIN users b ON b.id = p.accepter_id
      WHERE p.author_id = ? OR p.accepter_id = ?
      ORDER BY p.id DESC
    `).all(userId, userId);
    return { user, posts, ...ratingSummary(userId), application: latestApplication(userId) };
  }

  function getProfile(userId) {
    const user = db.prepare(`
      SELECT id, display_name, role, blocked, created_at
      FROM users WHERE id = ?
    `).get(userId);
    if (!user) return null;
    const ratings = db.prepare(`
      SELECT r.stars, r.created_at, u.display_name AS rater_name, u.id AS rater_id
      FROM ratings r
      JOIN users u ON u.id = r.rater_id
      WHERE r.ratee_id = ?
      ORDER BY r.id DESC
    `).all(userId);
    return { user, ratings, ...ratingSummary(userId) };
  }

  function postPage(postId, viewerId) {
    const row = db.prepare(`
      SELECT p.*,
        a.display_name AS author_name, a.role AS author_role,
        a.blocked AS author_blocked, a.merit AS author_merit,
        b.display_name AS accepter_name, b.role AS accepter_role
      FROM posts p
      JOIN users a ON a.id = p.author_id
      LEFT JOIN users b ON b.id = p.accepter_id
      WHERE p.id = ?
    `).get(postId);
    if (!row) return null;

    const viewer = viewerId ? db.prepare('SELECT * FROM users WHERE id = ?').get(viewerId) : null;
    const summary = ratingSummary(row.author_id);
    const settled = row.status === 'settled';
    const isParty = !!(viewer && (viewer.id === row.host_id || viewer.id === row.seeker_id));
    const seeker = row.seeker_id
      ? db.prepare('SELECT id, display_name, role, merit FROM users WHERE id = ?').get(row.seeker_id)
      : null;
    const host = row.host_id
      ? db.prepare('SELECT id, display_name, role FROM users WHERE id = ?').get(row.host_id)
      : null;

    let canAccept = false;
    let acceptHint = null;
    if (row.status === 'open' && viewer && viewer.id !== row.author_id) {
      if (viewer.blocked) {
        acceptHint = '你的帳號已被封鎖，不能接下。';
      } else if (row.author_blocked) {
        acceptHint = '發布者已被封鎖，不能接下。';
      } else {
        const payerIsViewer = row.kind === 'offer';
        const payerMerit = payerIsViewer ? viewer.merit : row.author_merit;
        const payerRole = payerIsViewer ? viewer.role : row.author_role;
        if (payerRole === 'user' && !(payerMerit - row.amount > 0)) {
          acceptHint = payerIsViewer
            ? `你的功德是 ${payerMerit}，這則標示 ${row.amount}。扣除後必須大於 0 才能接下。`
            : `對方的功德是 ${payerMerit}，這則標示 ${row.amount}。扣除後必須大於 0，現在不能配對。`;
        } else {
          canAccept = true;
        }
      }
    }

    const myRating = viewer && isParty
      ? db.prepare('SELECT stars FROM ratings WHERE post_id = ? AND rater_id = ?').get(row.id, viewer.id)
      : null;

    return {
      id: row.id,
      kind: row.kind,
      category: row.category,
      description: row.description,
      amount: row.amount,
      status: row.status,
      createdAt: row.created_at,
      settledAmount: settled ? row.settled_amount : null,
      settledOn: row.settled_on,
      author: {
        id: row.author_id,
        name: row.author_name,
        role: row.author_role,
        blocked: row.author_blocked === 1,
        ratingAvg: summary.ratingAvg,
        ratingCount: summary.ratingCount,
      },
      accepter: row.accepter_id
        ? { id: row.accepter_id, name: row.accepter_name, role: row.accepter_role }
        : null,
      host: host ? { id: host.id, name: host.display_name, role: host.role } : null,
      seeker: seeker
        ? {
          id: seeker.id,
          name: seeker.display_name,
          role: seeker.role,
          merit: isParty && row.status === 'matched' ? seeker.merit : null,
        }
        : null,
      isAuthor: !!(viewer && viewer.id === row.author_id),
      isParty,
      myValue: !viewer ? null
        : viewer.id === row.host_id ? row.host_value
          : viewer.id === row.seeker_id ? row.seeker_value
            : null,
      otherSubmitted: !!(
        viewer && row.host_id && (
          (viewer.id === row.host_id && row.seeker_value != null)
          || (viewer.id === row.seeker_id && row.host_value != null)
        )
      ),
      showBothValues: settled,
      hostValue: settled ? row.host_value : null,
      seekerValue: settled ? row.seeker_value : null,
      canAccept,
      acceptHint,
      canCancel: !!(viewer && viewer.id === row.author_id && row.status === 'open'),
      canSubmitValue: !!(isParty && row.status === 'matched'),
      canRetrySettle: !!(isParty && row.status === 'matched' && row.host_value != null && row.seeker_value != null),
      canRate: !!(isParty && settled && !myRating),
      myStars: myRating ? myRating.stars : null,
      loggedIn: !!viewer,
    };
  }

  function adminSnapshot(actorId, lookupMobile) {
    assertFounder(actorId);
    const applications = db.prepare(`
      SELECT a.id, a.org_name, a.created_at, u.mobile, u.display_name, u.id AS user_id
      FROM org_applications a
      JOIN users u ON u.id = a.user_id
      WHERE a.status = 'pending'
      ORDER BY a.id
    `).all();
    const blocked = db.prepare(`
      SELECT id, mobile, display_name, block_reason
      FROM users WHERE blocked = 1 ORDER BY id DESC
    `).all();
    let lookup = null;
    if (lookupMobile) {
      try {
        const user = findByMobile(normalizeMobile(lookupMobile));
        lookup = user
          ? {
            id: user.id,
            mobile: user.mobile,
            displayName: user.display_name,
            role: user.role,
            merit: user.merit,
            quota: user.quota,
            blocked: user.blocked === 1,
            blockReason: user.block_reason,
          }
          : { missing: true };
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        lookup = { error: err.message };
      }
    }
    return { applications, blocked, lookup };
  }

  return {
    requestOtp,
    verifyOtp,
    register,
    seedFounder,
    createPost,
    acceptPost,
    cancelPost,
    submitValue,
    retrySettle,
    rate,
    blockUser,
    unblockUser,
    createOrg,
    applyOrg,
    approveApplication,
    rejectApplication,
    latestApplication,
    listOpenPosts,
    dashboard,
    getProfile,
    postPage,
    adminSnapshot,
    findByMobile,
  };
}

module.exports = { createServices };
