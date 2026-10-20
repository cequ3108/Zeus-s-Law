const crypto = require('crypto');
const { AppError } = require('./errors');
const { CATEGORIES, ENDOWMENTS, MAX_AMOUNT, RATING_TAGS, MEETING_MODES, PUBLIC_MEETING_MODES, REPORT_REASONS } = require('./constants');
const { taipeiDate, taipeiMonth, taipeiMonthRange, weekRange, lastSeenLabel, LAST_SEEN_INTERVAL_MS } = require('./time');
const sms = require('./sms');
const { cleanPassword, hashPassword, verifyPassword, temporaryPassword } = require('./password');
const { normalizeCity, normalizeDistrict } = require('./places');
const { TEMPLATES } = require('./templates');
const { meetingShareText, lineShareUrl } = require('./share');
const { milestoneBoard } = require('./milestones');

const BANNED_PHRASES = ['現金', '轉帳給我', '匯款', '付錢'];
const THANK_BANNED = ['現金', '轉帳', '匯款', '付錢', '付現', '紅包', '街口', '微信支付'];
const THANK_BANNED_LATIN = ['linepay', 'paypal', 'wechatpay', 'applepay'];
const THANKS_LIMIT = 100;
const RATING_REMIND_MS = 14 * 24 * 60 * 60 * 1000;
const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
const THANKS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const THANKS_EDIT_MS = 24 * 60 * 60 * 1000;

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

  function expiryHours(raw) {
    if (raw == null || raw === '') return 48;
    const hours = Number(raw);
    if (hours !== 24 && hours !== 48 && hours !== 72) {
      throw new AppError('有效時間請選 24、48 或 72 小時。');
    }
    return hours;
  }

  function expiresAt(hours) {
    return new Date(clock().getTime() + hours * 60 * 60 * 1000).toISOString();
  }

  function isExpired(post) {
    return !!(post && post.expires_at && post.expires_at <= clock().toISOString());
  }

  function assertNoCashLanguage(text) {
    const hit = BANNED_PHRASES.find((phrase) => text.includes(phrase));
    if (hit) throw new AppError(`請不要寫「${hit}」。功德不可購買、兌現或轉售。`);
  }

  function assertThankYouClean(text) {
    const hit = THANK_BANNED.find((phrase) => text.includes(phrase));
    if (hit) throw new AppError(`請不要在感謝留言寫「${hit}」。站內規則禁止現金交易。`);
    const folded = text.toLowerCase().replace(/\s+/g, '');
    if (THANK_BANNED_LATIN.some((phrase) => folded.includes(phrase))) {
      throw new AppError('請不要在感謝留言寫付款方式。站內規則禁止現金交易。');
    }
  }

  function cleanOptional(raw, label, max) {
    const text = String(raw || '').replace(/[\u0000-\u001F]/g, '').trim();
    if (!text) return null;
    if ([...text].length > max) throw new AppError(`${label}請不要超過 ${max} 個字。`);
    return text;
  }

  function cleanMeetingMode(raw) {
    const text = String(raw || '').replace(/[\u0000-\u001F]/g, '').trim();
    if (!text) return null;
    if (!MEETING_MODES.includes(text)) throw new AppError('請選擇列出的見面方式，或先不選。');
    return text;
  }

  function cleanTitle(raw) {
    const text = String(raw || '').replace(/[\u0000-\u001F]/g, '').trim();
    if (!text) return null;
    if ([...text].length > 40) throw new AppError('標題請不要超過 40 個字。');
    return text;
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

  function acknowledgeRules(userId) {
    const user = mustUser(userId);
    if (!user.rules_acknowledged_at) {
      db.prepare(`
        UPDATE users SET rules_acknowledged_at = ? WHERE id = ? AND rules_acknowledged_at IS NULL
      `).run(clock().toISOString(), user.id);
    }
    return mustUser(user.id);
  }

  function onboardingFor(userId) {
    const user = db.prepare(`
      SELECT id, display_name, availability, city, rules_acknowledged_at, onboarding_dismissed_at
      FROM users WHERE id = ?
    `).get(userId);
    if (!user || user.onboarding_dismissed_at) return null;
    const veteran = db.prepare(`
      SELECT 1 FROM posts
      WHERE status = 'settled' AND (host_id = ? OR seeker_id = ?)
      LIMIT 1
    `).get(userId, userId);
    if (veteran) return null;
    const acted = db.prepare(`
      SELECT 1 FROM posts WHERE author_id = ? OR accepter_id = ? LIMIT 1
    `).get(userId, userId);
    const named = String(user.display_name || '').trim();
    const intro = String(user.availability || '').trim();
    const steps = [
      {
        id: 'profile',
        label: '填好暱稱和自我介紹',
        href: '/account',
        done: named.length > 0 && intro.length > 0,
      },
      {
        id: 'city',
        label: '選好縣市',
        href: '/account',
        done: String(user.city || '').trim().length > 0,
      },
      {
        id: 'rules',
        label: '看過規則',
        href: '/rules',
        done: !!user.rules_acknowledged_at,
      },
      {
        id: 'start',
        label: '發布一則，或接下別人的互助',
        href: '/posts/new',
        done: !!acted,
      },
    ];
    const done = steps.filter((step) => step.done).length;
    return { steps, done, total: steps.length, complete: done === steps.length };
  }

  function dismissOnboarding(userId) {
    db.prepare(`
      UPDATE users SET onboarding_dismissed_at = ?
      WHERE id = ? AND onboarding_dismissed_at IS NULL
    `).run(clock().toISOString(), userId);
  }

  function touchLastSeen(userId, knownAt) {
    const now = clock();
    let previous = knownAt;
    if (previous === undefined) {
      const row = db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(userId);
      if (!row) return;
      previous = row.last_seen_at;
    }
    if (previous) {
      const then = new Date(previous).getTime();
      if (!Number.isNaN(then) && now.getTime() - then < LAST_SEEN_INTERVAL_MS) return;
    }
    const cutoff = new Date(now.getTime() - LAST_SEEN_INTERVAL_MS).toISOString();
    db.prepare(`
      UPDATE users SET last_seen_at = ?
      WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)
    `).run(now.toISOString(), userId, cutoff);
  }

  function setHideLastSeen(userId, hide) {
    db.prepare('UPDATE users SET hide_last_seen = ? WHERE id = ?').run(hide ? 1 : 0, userId);
  }

  function lastSeenFor(user, viewerId) {
    if (!user || !user.last_seen_at) return '';
    if (Number(user.hide_last_seen) === 1 && Number(viewerId) !== Number(user.id)) return '';
    return lastSeenLabel(user.last_seen_at, clock());
  }

  function mustUser(id) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw new AppError('找不到使用者。');
    return user;
  }

  function findByMobile(mobile) {
    return db.prepare('SELECT * FROM users WHERE mobile = ?').get(mobile) || null;
  }

  function insertUser({ mobile, displayName, role, passwordHash = null }) {
    const endowment = ENDOWMENTS[role];
    const info = db.prepare(`
      INSERT INTO users (mobile, display_name, role, merit, quota, blocked, created_at, password_hash)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(mobile, displayName, role, endowment.merit, endowment.quota, clock().toISOString(), passwordHash);
    const user = mustUser(Number(info.lastInsertRowid));
    const reason = role === 'founder' ? 'founder_seed' : role === 'org' ? 'org_create' : 'signup';
    recordLedger({ userId: user.id, deltaMerit: user.merit, deltaQuota: user.quota, reason });
    return user;
  }

  function recordLedger({ userId, deltaMerit, deltaQuota, reason, postId = null, counterpartyId = null }) {
    const user = db.prepare('SELECT merit, quota FROM users WHERE id = ?').get(userId);
    db.prepare(`
      INSERT INTO ledger (
        created_at, user_id, delta_merit, delta_quota, merit_after, quota_after,
        reason, post_id, counterparty_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      clock().toISOString(), userId, deltaMerit, deltaQuota, user.merit, user.quota,
      reason, postId, counterpartyId,
    );
  }

  function endow(user, role, floor) {
    if (user.role === role) return user;
    const merit = Math.max(user.merit, floor.merit);
    const quota = Math.max(user.quota, floor.quota, merit);
    const deltaMerit = merit - user.merit;
    const deltaQuota = quota - user.quota;
    db.prepare('UPDATE users SET role = ?, merit = ?, quota = ? WHERE id = ?')
      .run(role, merit, quota, user.id);
    if (deltaMerit !== 0 || deltaQuota !== 0) {
      recordLedger({
        userId: user.id,
        deltaMerit,
        deltaQuota,
        reason: role === 'founder' ? 'founder_endow' : 'org_endow',
      });
    }
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

  function reputation(userId) {
    const helped = db.prepare(`
      SELECT COUNT(*) AS count FROM posts WHERE host_id = ? AND status = 'settled'
    `).get(userId).count;
    const helpedBy = db.prepare(`
      SELECT COUNT(*) AS count FROM posts WHERE seeker_id = ? AND status = 'settled'
    `).get(userId).count;
    const badges = [];
    if (helped >= 1) badges.push('伸出援手');
    if (helped >= 5) badges.push('常幫忙');
    if (helped >= 1 && helpedBy >= 1) badges.push('互相往來');
    return { helped, helpedBy, badges, ...ratingSummary(userId) };
  }

  function milestoneCounts(userId) {
    const completed = db.prepare(`
      SELECT COUNT(*) AS count FROM posts
      WHERE status = 'settled' AND (host_id = ? OR seeker_id = ?)
    `).get(userId, userId).count;
    const fives = db.prepare(`
      SELECT COUNT(*) AS count FROM ratings WHERE ratee_id = ? AND stars = 5
    `).get(userId).count;
    return milestoneBoard(completed, fives);
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

  function registerWithPassword(rawMobile, displayName, rawPassword, rawConfirm) {
    const mobile = normalizeMobile(rawMobile);
    if (findByMobile(mobile)) throw new AppError('這個手機號碼已經註冊，請直接登入。');
    const password = cleanPassword(rawPassword);
    if (password !== String(rawConfirm ?? '')) throw new AppError('兩次輸入的密碼不一樣。');
    return insertUser({
      mobile,
      displayName: cleanName(displayName),
      role: 'user',
      passwordHash: hashPassword(password),
    });
  }

  async function requestPasswordReset(rawMobile) {
    const mobile = normalizeMobile(rawMobile);
    if (!findByMobile(mobile)) throw new AppError('這個手機號碼還沒有註冊。');
    return requestOtp(mobile);
  }

  function resetPassword(rawMobile, rawPassword, rawConfirm) {
    const mobile = normalizeMobile(rawMobile);
    const user = findByMobile(mobile);
    if (!user) throw new AppError('這個手機號碼還沒有註冊。');
    const password = cleanPassword(rawPassword);
    if (password !== String(rawConfirm ?? '')) throw new AppError('兩次輸入的密碼不一樣。');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    return mustUser(user.id);
  }

  function resetPasswordByFounder(actorId, rawMobile) {
    assertFounder(actorId);
    const user = findByMobile(normalizeMobile(rawMobile));
    if (!user) throw new AppError('找不到這個手機號碼。');
    const temporary = temporaryPassword();
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(temporary), user.id);
    return { user: mustUser(user.id), temporary };
  }

  function loginWithPassword(rawMobile, rawPassword) {
    let mobile;
    try {
      mobile = normalizeMobile(rawMobile);
    } catch {
      throw new AppError('手機號碼或密碼不正確。');
    }
    const user = findByMobile(mobile);
    const ok = !!(user && user.password_hash && verifyPassword(String(rawPassword ?? ''), user.password_hash));
    if (!ok) throw new AppError('手機號碼或密碼不正確。');
    return user;
  }

  function ensureFounderAccount(rawMobile, rawPassword) {
    const mobile = normalizeMobile(rawMobile);
    const passwordHash = hashPassword(cleanPassword(rawPassword));
    const existing = findByMobile(mobile);
    if (!existing) {
      const user = insertUser({ mobile, displayName: '創辦人', role: 'founder', passwordHash });
      return { created: true, user };
    }
    if (existing.role !== 'founder') {
      throw new AppError('這個手機號碼已經是其他角色，沒有改成創辦人，餘額也沒有變動。');
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, existing.id);
    return { created: false, user: mustUser(existing.id) };
  }

  function ensureFounderFromEnv(env = process.env) {
    const phone = String(env.FOUNDER_PHONE || '').trim();
    const password = env.FOUNDER_PASSWORD;
    const missingPassword = password == null || password === '';
    if (!phone && missingPassword) return { status: 'skipped' };
    if (!phone || missingPassword) return { status: 'incomplete' };
    try {
      const result = ensureFounderAccount(phone, password);
      return {
        status: result.created ? 'created' : 'updated',
        mobile: result.user.mobile,
      };
    } catch (err) {
      if (err instanceof AppError && err.message.includes('其他角色')) {
        return { status: 'conflict', message: err.message };
      }
      throw err;
    }
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
    assertNoCashLanguage([input.title, description, input.meeting_place, input.meeting_time].join('\n'));
    const city = normalizeCity(input.city);
    const district = normalizeDistrict(input.district, city);
    const title = cleanTitle(input.title);
    const hours = expiryHours(input.expires_hours);
    const meetingPlace = cleanOptional(input.meeting_place, '地點', 80);
    const meetingTime = cleanOptional(input.meeting_time, '時間', 80);
    const meetingMode = cleanMeetingMode(input.meeting_mode);
    const info = db.prepare(`
      INSERT INTO posts (
        author_id, kind, category, description, amount, status, created_at,
        city, district, title, expires_at, meeting_place, meeting_time, meeting_mode
      )
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      author.id, kind, input.category, description, amount, clock().toISOString(),
      city, district, title, expiresAt(hours), meetingPlace, meetingTime, meetingMode,
    );
    return { id: Number(info.lastInsertRowid) };
  }

  function updateAccountPlace(userId, input) {
    const city = normalizeCity(input.city, { required: false });
    const district = normalizeDistrict(input.district, city);
    db.prepare('UPDATE users SET city = ?, district = ? WHERE id = ?').run(city, district, userId);
    return mustUser(userId);
  }

  function updateAvailability(userId, raw) {
    const text = cleanOptional(raw, '今日空檔', 80);
    db.prepare('UPDATE users SET availability = ? WHERE id = ?').run(text, userId);
    return mustUser(userId);
  }

  function acceptPost(postId, userId) {
    return db.transaction(() => {
      const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
      if (!post || post.status !== 'open' || isExpired(post)) throw new AppError('這則已經不能接下。');
      const actor = mustUser(userId);
      const author = mustUser(post.author_id);
      if (actor.blocked) throw new AppError('你的帳號已被封鎖，不能發布或接下。');
      if (author.blocked) throw new AppError('發布者已被封鎖，這則不能接下。');
      if (actor.id === author.id) throw new AppError('不能接下自己的貼文。');
      if (pairHidden(actor.id, author.id)) {
        throw new AppError('你們已設定不想再遇到，不能接下這則。');
      }

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

  function repostPost(postId, userId) {
    return db.transaction(() => {
      const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
      if (!post || post.author_id !== userId || post.status !== 'open') {
        throw new AppError('這則不能重發。');
      }
      const changed = db.prepare(`
        UPDATE posts SET status = 'cancelled' WHERE id = ? AND author_id = ? AND status = 'open'
      `).run(post.id, userId);
      if (changed.changes !== 1) throw new AppError('這則不能重發。');
      let hours = 48;
      if (post.expires_at) {
        const span = new Date(post.expires_at).getTime() - new Date(post.created_at).getTime();
        const candidate = Math.round(span / (60 * 60 * 1000));
        if (candidate === 24 || candidate === 48 || candidate === 72) hours = candidate;
      }
      const info = db.prepare(`
        INSERT INTO posts (
          author_id, kind, category, description, amount, status, created_at,
          city, district, title, expires_at, meeting_place, meeting_time, meeting_mode
        )
        VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        post.author_id, post.kind, post.category, post.description, post.amount,
        clock().toISOString(), post.city, post.district, post.title, expiresAt(hours),
        post.meeting_place, post.meeting_time, post.meeting_mode,
      );
      return { id: Number(info.lastInsertRowid) };
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

    recordLedger({
      userId: post.seeker_id,
      deltaMerit: -amount,
      deltaQuota: amount,
      reason: 'settle_spend',
      postId: post.id,
      counterpartyId: post.host_id,
    });
    recordLedger({
      userId: post.host_id,
      deltaMerit: amount,
      deltaQuota: amount,
      reason: 'settle_receive',
      postId: post.id,
      counterpartyId: post.seeker_id,
    });

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

  function cleanRatingTags(raw) {
    if (raw == null || raw === '') return [];
    const incoming = Array.isArray(raw) ? raw : [raw];
    const tags = [];
    for (const item of incoming) {
      const tag = String(item ?? '').trim();
      if (!tag) continue;
      if (!RATING_TAGS.includes(tag)) throw new AppError('請只選列出的正向標籤。');
      if (!tags.includes(tag)) tags.push(tag);
    }
    if (tags.length > 3) throw new AppError('正向標籤最多選 3 個。');
    return tags;
  }

  function rate(postId, userId, rawStars, rawComment, rawTags) {
    const stars = Number(rawStars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new AppError('請給 1 到 5 顆星。');
    const comment = cleanComment(rawComment);
    const tags = cleanRatingTags(rawTags);
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
    if (!post || post.status !== 'settled') throw new AppError('結算完成後才能評分。');
    if (userId !== post.host_id && userId !== post.seeker_id) throw new AppError('只有雙方可以評分。');
    const rateeId = userId === post.host_id ? post.seeker_id : post.host_id;
    const save = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO ratings (post_id, rater_id, ratee_id, stars, comment, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(post.id, userId, rateeId, stars, comment, clock().toISOString());
      const ratingId = Number(info.lastInsertRowid);
      const insertTag = db.prepare('INSERT INTO rating_tags (rating_id, tag) VALUES (?, ?)');
      for (const tag of tags) insertTag.run(ratingId, tag);
    });
    try {
      save();
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new AppError('你已經評過這次互助。');
      throw err;
    }
  }

  function cleanThanks(raw) {
    const text = String(raw || '').replace(/[\u0000-\u001F]/g, '').trim();
    if (!text) throw new AppError('感謝留言要寫一些內容。');
    if ([...text].length > THANKS_LIMIT) throw new AppError('感謝留言請不要超過 100 個字。');
    assertThankYouClean(text);
    return text;
  }

  function stillWithin(iso, windowMs) {
    const at = new Date(iso).getTime();
    return Number.isFinite(at) && clock().getTime() <= at + windowMs;
  }

  function thanksParties(post, authorId) {
    if (!post || post.status !== 'settled' || !post.settled_at) throw new AppError('結算完成後才能留感謝。');
    if (authorId !== post.host_id && authorId !== post.seeker_id) {
      throw new AppError('只有這次互助的雙方可以留感謝。');
    }
    const recipientId = authorId === post.host_id ? post.seeker_id : post.host_id;
    return { recipientId };
  }

  function saveThanks(postId, authorId, rawBody) {
    const body = cleanThanks(rawBody);
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
    const { recipientId } = thanksParties(post, authorId);
    const existing = db.prepare(
      'SELECT * FROM thanks WHERE post_id = ? AND author_id = ?'
    ).get(post.id, authorId);
    const nowIso = clock().toISOString();
    if (existing) {
      if (!stillWithin(existing.created_at, THANKS_EDIT_MS)) {
        throw new AppError('超過 24 小時就不能再改這則感謝。');
      }
      db.prepare('UPDATE thanks SET body = ?, updated_at = ? WHERE id = ?').run(body, nowIso, existing.id);
      return { id: existing.id, updated: true };
    }
    if (!stillWithin(post.settled_at, THANKS_WINDOW_MS)) {
      throw new AppError('結算超過 7 天就不能再留感謝。');
    }
    const info = db.prepare(`
      INSERT INTO thanks (post_id, author_id, recipient_id, body, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(post.id, authorId, recipientId, body, nowIso, nowIso);
    return { id: Number(info.lastInsertRowid), updated: false };
  }

  function removeOwnThanks(postId, authorId) {
    const existing = db.prepare(
      'SELECT * FROM thanks WHERE post_id = ? AND author_id = ?'
    ).get(postId, authorId);
    if (!existing) throw new AppError('找不到這則感謝。');
    if (!stillWithin(existing.created_at, THANKS_EDIT_MS)) {
      throw new AppError('超過 24 小時就不能刪這則感謝。');
    }
    db.prepare('DELETE FROM thanks WHERE id = ?').run(existing.id);
  }

  function hideThanks(actorId, thanksId) {
    const row = db.prepare('SELECT * FROM thanks WHERE id = ?').get(thanksId);
    if (!row) throw new AppError('找不到這則感謝。');
    if (row.recipient_id !== actorId) throw new AppError('只有收到的人可以不公開這則感謝。');
    if (!row.hidden_at) {
      db.prepare('UPDATE thanks SET hidden_at = ? WHERE id = ?').run(clock().toISOString(), thanksId);
    }
  }

  function deleteThanks(actorId, thanksId) {
    assertFounder(actorId);
    const row = db.prepare('SELECT id FROM thanks WHERE id = ?').get(thanksId);
    if (!row) throw new AppError('找不到這則感謝。');
    db.prepare('DELETE FROM thanks WHERE id = ?').run(thanksId);
  }

  function mapThanks(row) {
    return {
      id: row.id,
      postId: row.post_id,
      body: row.body,
      createdAt: row.created_at,
      hidden: !!row.hidden_at,
      authorId: row.author_id,
      authorName: row.author_name,
      category: row.category,
    };
  }

  function listReceivedThanks(recipientId, { includeHidden = false, all = false } = {}) {
    const rows = db.prepare(`
      SELECT t.id, t.post_id, t.body, t.created_at, t.hidden_at, t.author_id,
             u.display_name AS author_name, p.category
      FROM thanks t
      JOIN users u ON u.id = t.author_id
      JOIN posts p ON p.id = t.post_id
      WHERE t.recipient_id = ?
      ORDER BY t.created_at DESC, t.id DESC
    `).all(recipientId);
    const visible = rows.filter((row) => includeHidden || !row.hidden_at);
    return {
      notes: (all ? visible : visible.slice(0, 5)).map(mapThanks),
      noteTotal: visible.length,
    };
  }

  function topRatingTags(userId) {
    return db.prepare(`
      SELECT t.tag AS tag, COUNT(*) AS count
      FROM rating_tags t
      JOIN ratings r ON r.id = t.rating_id
      WHERE r.ratee_id = ?
      GROUP BY t.tag
      ORDER BY count DESC, t.tag ASC
      LIMIT 3
    `).all(userId);
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

  function inspectHide(actorId, targetId) {
    const actor = mustUser(actorId);
    const target = db.prepare('SELECT id, display_name, role FROM users WHERE id = ?').get(targetId);
    if (!target) return { ok: false, message: '找不到這位使用者。' };
    if (actor.id === target.id) return { ok: false, message: '不能把自己列入不想再遇到。' };
    if (actor.role !== 'user') return { ok: false, message: '只有一般使用者可以設定不想再遇到。' };
    if (target.role !== 'user') return { ok: false, message: '創辦人與福利機構不能列入不想再遇到。' };
    const already = !!db.prepare(
      'SELECT 1 FROM user_hides WHERE user_id = ? AND hidden_user_id = ?'
    ).get(actor.id, target.id);
    return { ok: true, already, target };
  }

  function assertCanHide(actorId, targetId) {
    const check = inspectHide(actorId, targetId);
    if (!check.ok) throw new AppError(check.message);
    return check;
  }

  function hideUser(actorId, targetId) {
    const check = assertCanHide(actorId, targetId);
    if (!check.already) {
      db.prepare(
        'INSERT INTO user_hides (user_id, hidden_user_id, created_at) VALUES (?, ?, ?)'
      ).run(actorId, targetId, clock().toISOString());
    }
    return check.target;
  }

  function unhideUser(actorId, targetId) {
    const changed = db.prepare(
      'DELETE FROM user_hides WHERE user_id = ? AND hidden_user_id = ?'
    ).run(actorId, targetId);
    if (changed.changes !== 1) throw new AppError('這個人不在你的清單裡。');
  }

  function pairHidden(leftId, rightId) {
    if (!leftId || !rightId || leftId === rightId) return false;
    return !!db.prepare(`
      SELECT 1 FROM user_hides
      WHERE (user_id = ? AND hidden_user_id = ?)
         OR (user_id = ? AND hidden_user_id = ?)
    `).get(leftId, rightId, rightId, leftId);
  }

  function hideRelation(viewerId, targetId) {
    if (!viewerId || !targetId) return { canHide: false };
    const check = inspectHide(viewerId, targetId);
    return { canHide: !!(check.ok && !check.already) };
  }

  function hiddenPeople(userId) {
    return db.prepare(`
      SELECT u.id, u.display_name, h.created_at
      FROM user_hides h
      JOIN users u ON u.id = h.hidden_user_id
      WHERE h.user_id = ?
      ORDER BY h.created_at DESC, u.id DESC
    `).all(userId);
  }

  function hiddenByCount(userId) {
    return db.prepare(
      'SELECT COUNT(*) AS count FROM user_hides WHERE hidden_user_id = ?'
    ).get(userId).count;
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

  function priceHint(category, city) {
    if (!CATEGORIES[category]) return null;
    const rows = city
      ? db.prepare(`
          SELECT settled_amount FROM posts
          WHERE status = 'settled' AND category = ? AND city = ? AND settled_amount > 0
          ORDER BY id DESC LIMIT 20
        `).all(category, city)
      : [];
    if (rows.length) {
      const amounts = rows.map((row) => row.settled_amount).sort((a, b) => a - b);
      return {
        source: 'history',
        count: amounts.length,
        low: amounts[0],
        high: amounts[amounts.length - 1],
        typical: amounts[Math.floor((amounts.length - 1) / 2)],
      };
    }
    const items = TEMPLATES.filter((item) => item.category === category);
    if (!items.length) return null;
    return {
      source: 'template',
      low: Math.min(...items.map((item) => item.min)),
      high: Math.max(...items.map((item) => item.max)),
    };
  }

  const MERIT_PAGE = 20;
  const MERIT_TYPES = {
    signup: '註冊起始',
    settle_receive: '招待別人收到',
    settle_spend: '被招待付出',
    founder_seed: '創辦人或機構發放',
    founder_endow: '創辦人或機構發放',
    org_create: '創辦人或機構發放',
    org_endow: '創辦人或機構發放',
  };

  function meritHistory(userId, options = {}) {
    const user = mustUser(userId);
    const bounds = taipeiMonthRange(options.month);
    const before = Number.isInteger(options.before) && options.before > 0 ? options.before : null;
    const where = ['l.user_id = ?'];
    const params = [user.id];
    if (bounds) {
      where.push('l.created_at >= ? AND l.created_at < ?');
      params.push(bounds.start, bounds.end);
    }
    if (before) {
      where.push('l.id < ?');
      params.push(before);
    }
    const rows = db.prepare(`
      SELECT l.id, l.created_at, l.delta_merit, l.delta_quota, l.merit_after, l.reason,
             l.counterparty_id, c.display_name AS counterparty_name
      FROM ledger l
      LEFT JOIN users c ON c.id = l.counterparty_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.id DESC
      LIMIT ?
    `).all(...params, MERIT_PAGE + 1);
    const hasMore = rows.length > MERIT_PAGE;
    const items = rows.slice(0, MERIT_PAGE).map((row) => ({
      id: row.id,
      at: row.created_at,
      type: MERIT_TYPES[row.reason] || '其他',
      reason: row.reason,
      deltaMerit: row.delta_merit,
      deltaQuota: row.delta_quota,
      meritAfter: row.merit_after,
      counterpartyId: row.counterparty_id,
      counterpartyName: row.counterparty_name || '',
    }));
    const current = taipeiMonthRange(taipeiMonth(clock()));
    const sums = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN reason = 'settle_receive' AND delta_merit > 0 THEN delta_merit ELSE 0 END), 0) AS received,
        COALESCE(SUM(CASE WHEN reason = 'settle_spend' AND delta_merit < 0 THEN -delta_merit ELSE 0 END), 0) AS paid
      FROM ledger
      WHERE user_id = ? AND created_at >= ? AND created_at < ?
    `).get(user.id, current.start, current.end);
    const months = [...new Set(
      db.prepare('SELECT created_at FROM ledger WHERE user_id = ?').all(user.id)
        .map((row) => taipeiMonth(row.created_at)),
    )].sort().reverse();
    return {
      merit: user.merit,
      quota: user.quota,
      received: sums.received,
      paid: sums.paid,
      month: bounds ? bounds.month : '',
      months,
      items,
      hasMore,
      nextBefore: hasMore ? items[items.length - 1].id : null,
    };
  }

  function weeklySummary(userId) {
    const range = weekRange(clock());
    const spent = db.prepare(`
      SELECT COALESCE(SUM(settled_amount), 0) AS total
      FROM posts
      WHERE seeker_id = ? AND status = 'settled' AND settled_on >= ? AND settled_on <= ?
    `).get(userId, range.start, range.end).total;
    const received = db.prepare(`
      SELECT COALESCE(SUM(settled_amount), 0) AS total
      FROM posts
      WHERE host_id = ? AND status = 'settled' AND settled_on >= ? AND settled_on <= ?
    `).get(userId, range.start, range.end).total;
    const quotaGained = db.prepare(`
      SELECT COALESCE(SUM(settled_amount), 0) AS total
      FROM posts
      WHERE status = 'settled' AND settled_on >= ? AND settled_on <= ?
        AND (host_id = ? OR seeker_id = ?)
    `).get(range.start, range.end, userId, userId).total;
    return { ...range, spent, received, quotaGained };
  }

  function cleanSearchQuery(raw) {
    const value = Array.isArray(raw) ? raw[0] : raw;
    const text = String(value || '').replace(/[\u0000-\u001F]/g, '').trim();
    if (!text) return '';
    return [...text].slice(0, 40).join('');
  }

  function likeContains(text) {
    return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  }

  function listOpenPosts(filter = {}) {
    const where = ['p.status = \'open\'', 'u.blocked = 0', '(p.expires_at IS NULL OR p.expires_at > ?)'];
    const params = [filter.viewerId || 0, clock().toISOString()];
    if (filter.city) {
      where.push('p.city = ?');
      params.push(filter.city);
    }
    if (filter.district) {
      where.push('p.district = ?');
      params.push(filter.district);
    }
    if (filter.localCity && filter.localDistrict) {
      where.push('p.city = ? AND p.district = ?');
      params.push(filter.localCity, filter.localDistrict);
    }
    if (filter.category && CATEGORIES[filter.category]) {
      where.push('p.category = ?');
      params.push(filter.category);
    }
    if (filter.publicMeeting) {
      where.push(`p.meeting_mode IN (${PUBLIC_MEETING_MODES.map(() => '?').join(', ')})`);
      params.push(...PUBLIC_MEETING_MODES);
    }
    const query = cleanSearchQuery(filter.query);
    if (query) {
      const pattern = likeContains(query);
      where.push(`(IFNULL(p.title, '') LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern);
    }
    if (filter.viewerId) {
      where.push(`NOT EXISTS (
        SELECT 1 FROM user_hides h
        WHERE (h.user_id = ? AND h.hidden_user_id = p.author_id)
           OR (h.hidden_user_id = ? AND h.user_id = p.author_id)
      )`);
      params.push(filter.viewerId, filter.viewerId);
    }
    return db.prepare(`
      SELECT EXISTS(SELECT 1 FROM bookmarks b WHERE b.user_id = ? AND b.post_id = p.id) AS bookmarked,
             p.id, p.kind, p.category, p.title, p.description, p.amount, p.created_at, p.city, p.district,
             p.meeting_mode,
             u.id AS author_id, u.display_name AS author_name, u.role AS author_role,
             u.availability AS author_availability,
             u.last_seen_at AS author_last_seen, u.hide_last_seen AS author_hide_last_seen,
             (SELECT ROUND(AVG(stars), 1) FROM ratings WHERE ratee_id = u.id) AS author_avg,
             (SELECT COUNT(*) FROM ratings WHERE ratee_id = u.id) AS author_count,
             (SELECT COUNT(*) FROM posts WHERE host_id = u.id AND status = 'settled') AS author_helped,
             (SELECT COUNT(*) FROM posts c WHERE c.status = 'settled' AND (c.host_id = u.id OR c.seeker_id = u.id)) AS author_completed,
             (SELECT COUNT(*) FROM ratings fr WHERE fr.ratee_id = u.id AND fr.stars = 5) AS author_fives
      FROM posts p
      JOIN users u ON u.id = p.author_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${({
        amount_desc: 'p.amount DESC, p.id DESC',
        amount_asc: 'p.amount ASC, p.id DESC',
        expiry: '(p.expires_at IS NULL), p.expires_at ASC, p.id DESC',
      })[filter.sort] || 'p.id DESC'}
      LIMIT 50
    `).all(...params).map((post) => {
      const authorSeen = lastSeenFor({
        id: post.author_id,
        last_seen_at: post.author_last_seen,
        hide_last_seen: post.author_hide_last_seen,
      }, filter.viewerId);
      delete post.author_last_seen;
      delete post.author_hide_last_seen;
      return {
        ...post,
        author_seen: authorSeen,
        author_badge: milestoneBoard(post.author_completed, post.author_fives).highest,
      };
    });
  }

  function taskFor(post, userId) {
    const party = userId === post.host_id || userId === post.seeker_id;
    if (!party) return '';
    if (post.status === 'matched') {
      const mine = userId === post.host_id ? post.host_value : post.seeker_value;
      const other = userId === post.host_id ? post.seeker_value : post.host_value;
      if (mine == null) return '待填估價';
      if (other == null) return '等對方填';
      return '';
    }
    if (post.status === 'settled' && !post.i_rated) return '待評分';
    return '';
  }

  function pendingActions(userId) {
    return db.prepare(`
      SELECT COUNT(*) AS count
      FROM posts p
      WHERE (p.host_id = ? OR p.seeker_id = ?)
        AND (
          (
            p.status = 'matched' AND (
              (p.host_id = ? AND p.host_value IS NULL)
              OR (p.seeker_id = ? AND p.seeker_value IS NULL)
            )
          )
          OR (
            p.status = 'settled'
            AND NOT EXISTS (
              SELECT 1 FROM ratings r WHERE r.post_id = p.id AND r.rater_id = ?
            )
          )
        )
    `).get(userId, userId, userId, userId, userId).count;
  }

  function pendingRatings(userId) {
    const since = new Date(clock().getTime() - RATING_REMIND_MS).toISOString();
    const rows = db.prepare(`
      SELECT p.id, p.title, p.description, p.settled_at,
             CASE WHEN p.host_id = ? THEN seeker.display_name ELSE host.display_name END AS other_name
      FROM posts p
      JOIN users host ON host.id = p.host_id
      JOIN users seeker ON seeker.id = p.seeker_id
      WHERE p.status = 'settled'
        AND p.settled_at IS NOT NULL
        AND p.settled_at >= ?
        AND (p.host_id = ? OR p.seeker_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM ratings r WHERE r.post_id = p.id AND r.rater_id = ?
        )
      ORDER BY p.settled_at DESC, p.id DESC
    `).all(userId, since, userId, userId, userId);
    const items = rows.map((row) => ({
      id: row.id,
      title: row.title || String(row.description || '').slice(0, 42),
      otherName: row.other_name,
      settledAt: row.settled_at,
      href: `/posts/${row.id}#rate`,
    }));
    return { total: items.length, items, day: taipeiDate(clock()) };
  }

  function dashboard(userId) {
    const user = mustUser(userId);
    const nowIso = clock().toISOString();
    const posts = db.prepare(`
      SELECT p.id, p.kind, p.category, p.title, p.description, p.amount, p.status,
             p.settled_amount, p.created_at, p.expires_at, p.author_id,
             p.host_id, p.seeker_id, p.host_value, p.seeker_value,
             a.display_name AS author_name, b.display_name AS accepter_name,
             (SELECT COUNT(*) FROM posts c WHERE c.status = 'settled' AND (c.host_id = a.id OR c.seeker_id = a.id)) AS author_completed,
             (SELECT COUNT(*) FROM ratings fr WHERE fr.ratee_id = a.id AND fr.stars = 5) AS author_fives,
             (SELECT COUNT(*) FROM posts c WHERE b.id IS NOT NULL AND c.status = 'settled' AND (c.host_id = b.id OR c.seeker_id = b.id)) AS accepter_completed,
             (SELECT COUNT(*) FROM ratings fr WHERE b.id IS NOT NULL AND fr.ratee_id = b.id AND fr.stars = 5) AS accepter_fives,
             EXISTS(SELECT 1 FROM ratings r WHERE r.post_id = p.id AND r.rater_id = ?) AS i_rated
      FROM posts p
      JOIN users a ON a.id = p.author_id
      LEFT JOIN users b ON b.id = p.accepter_id
      WHERE p.author_id = ? OR p.accepter_id = ?
      ORDER BY p.id DESC
    `).all(userId, userId, userId).map((post) => ({
      ...post,
      author_badge: milestoneBoard(post.author_completed, post.author_fives).highest,
      accepter_badge: post.accepter_name
        ? milestoneBoard(post.accepter_completed, post.accepter_fives).highest
        : '',
      expired: post.status === 'open' && post.expires_at && post.expires_at <= nowIso,
      task: taskFor(post, userId),
    })).sort((a, b) => {
      const rank = (post) => (post.task === '待填估價' || post.task === '待評分' ? 0 : 1);
      return rank(a) - rank(b) || b.id - a.id;
    });
    const actionCount = posts.filter((post) => post.task === '待填估價' || post.task === '待評分').length;
    return {
      user,
      posts,
      actionCount,
      hidden: hiddenPeople(userId),
      bookmarks: listBookmarks(userId),
      ...ratingSummary(userId),
      application: latestApplication(userId),
    };
  }

  function getProfile(userId, viewerId, options = {}) {
    const user = db.prepare(`
      SELECT id, display_name, role, blocked, created_at, city, district, availability,
             last_seen_at, hide_last_seen
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
    const thanks = listReceivedThanks(userId, {
      includeHidden: viewerId === userId,
      all: options.all === true,
    });
    const lastSeen = lastSeenFor(user, viewerId);
    const hideLastSeen = Number(user.hide_last_seen) === 1;
    delete user.last_seen_at;
    delete user.hide_last_seen;
    return {
      user,
      lastSeen,
      hideLastSeen,
      ratings,
      tags: topRatingTags(userId),
      reputation: reputation(userId),
      milestones: milestoneCounts(userId),
      notes: thanks.notes,
      noteTotal: thanks.noteTotal,
      thanksAll: options.all === true,
      ...ratingSummary(userId),
    };
  }

  function lineShareFor(viewer, row) {
    const otherId = viewer.id === row.host_id ? row.seeker_id : row.host_id;
    const other = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(otherId);
    if (!other) return null;
    const summary = reputation(other.id);
    const text = meetingShareText({
      nickname: other.display_name,
      ratingAvg: summary.ratingAvg,
      ratingCount: summary.ratingCount,
      helped: summary.helped,
      place: row.meeting_place,
      time: row.meeting_time,
    });
    return { text, url: lineShareUrl(text) };
  }

  function postPage(postId, viewerId) {
    const row = db.prepare(`
      SELECT p.*,
        a.display_name AS author_name, a.role AS author_role,
        a.blocked AS author_blocked, a.merit AS author_merit, a.availability AS author_availability,
        a.last_seen_at AS author_last_seen, a.hide_last_seen AS author_hide_last_seen,
        b.display_name AS accepter_name, b.role AS accepter_role
      FROM posts p
      JOIN users a ON a.id = p.author_id
      LEFT JOIN users b ON b.id = p.accepter_id
      WHERE p.id = ?
    `).get(postId);
    if (!row) return null;

    const viewer = viewerId ? db.prepare('SELECT * FROM users WHERE id = ?').get(viewerId) : null;
    const summary = reputation(row.author_id);
    const settled = row.status === 'settled';
    const isParty = !!(viewer && (viewer.id === row.host_id || viewer.id === row.seeker_id));
    const seeker = row.seeker_id
      ? db.prepare('SELECT id, display_name, role, merit, last_seen_at, hide_last_seen FROM users WHERE id = ?').get(row.seeker_id)
      : null;
    const host = row.host_id
      ? db.prepare('SELECT id, display_name, role, last_seen_at, hide_last_seen FROM users WHERE id = ?').get(row.host_id)
      : null;

    let canAccept = false;
    let acceptHint = null;
    const expired = isExpired(row);
    if (row.status === 'open' && !expired && viewer && viewer.id !== row.author_id) {
      if (viewer.blocked) {
        acceptHint = '你的帳號已被封鎖，不能接下。';
      } else if (row.author_blocked) {
        acceptHint = '發布者已被封鎖，不能接下。';
      } else if (pairHidden(viewer.id, row.author_id)) {
        acceptHint = '你們已設定不想再遇到，不能接下這則。';
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
    const myThanks = viewer && isParty
      ? db.prepare('SELECT id, body, created_at FROM thanks WHERE post_id = ? AND author_id = ?').get(row.id, viewer.id)
      : null;
    const receivedRow = viewer && isParty
      ? db.prepare(`
          SELECT t.id, t.body, t.hidden_at, u.display_name AS author_name
          FROM thanks t
          JOIN users u ON u.id = t.author_id
          WHERE t.post_id = ? AND t.recipient_id = ?
        `).get(row.id, viewer.id)
      : null;

    return {
      id: row.id,
      kind: row.kind,
      category: row.category,
      title: row.title,
      description: row.description,
      city: row.city,
      district: row.district,
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
        availability: row.author_availability,
        ratingAvg: summary.ratingAvg,
        ratingCount: summary.ratingCount,
        helped: summary.helped,
        badges: summary.badges,
        badge: milestoneCounts(row.author_id).highest,
        seen: lastSeenFor({
          id: row.author_id,
          last_seen_at: row.author_last_seen,
          hide_last_seen: row.author_hide_last_seen,
        }, viewerId),
      },
      accepter: row.accepter_id
        ? { id: row.accepter_id, name: row.accepter_name, role: row.accepter_role }
        : null,
      host: host ? {
        id: host.id,
        name: host.display_name,
        role: host.role,
        badge: milestoneCounts(host.id).highest,
        seen: lastSeenFor(host, viewerId),
      } : null,
      seeker: seeker
        ? {
          id: seeker.id,
          name: seeker.display_name,
          role: seeker.role,
          merit: isParty && row.status === 'matched' ? seeker.merit : null,
          badge: milestoneCounts(seeker.id).highest,
          seen: lastSeenFor(seeker, viewerId),
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
      canHideAuthor: hideRelation(viewer && viewer.id, row.author_id).canHide,
      expiresAt: row.expires_at,
      expired,
      canCancel: !!(viewer && viewer.id === row.author_id && row.status === 'open' && !expired),
      canRepost: !!(viewer && viewer.id === row.author_id && row.status === 'open' && expired),
      canSubmitValue: !!(isParty && row.status === 'matched'),
      canRetrySettle: !!(isParty && row.status === 'matched' && row.host_value != null && row.seeker_value != null),
      meetingPlace: row.meeting_place,
      meetingTime: row.meeting_time,
      meetingMode: row.meeting_mode,
      lineShare: isParty && (row.status === 'matched' || settled) && row.host_id && row.seeker_id
        ? lineShareFor(viewer, row)
        : null,
      canRate: !!(isParty && settled && !myRating),
      myStars: myRating ? myRating.stars : null,
      myThanks: myThanks ? { id: myThanks.id, body: myThanks.body } : null,
      canWriteThanks: !!(isParty && settled && !myThanks && stillWithin(row.settled_at, THANKS_WINDOW_MS)),
      canEditThanks: !!(myThanks && stillWithin(myThanks.created_at, THANKS_EDIT_MS)),
      receivedThanks: receivedRow ? {
        id: receivedRow.id,
        body: receivedRow.body,
        authorName: receivedRow.author_name,
        hidden: !!receivedRow.hidden_at,
      } : null,
      loggedIn: !!viewer,
      bookmarked: !!(viewer && db.prepare(
        'SELECT 1 FROM bookmarks WHERE user_id = ? AND post_id = ?'
      ).get(viewer.id, row.id)),
      canBookmark: !!(viewer && viewer.blocked !== 1 && !pairHidden(viewer.id, row.author_id)),
    };
  }

  function toggleBookmark(userId, postId) {
    const actor = mustUser(userId);
    if (actor.blocked) throw new AppError('你的帳號已被封鎖，不能收藏。');
    const post = db.prepare('SELECT id, author_id FROM posts WHERE id = ?').get(postId);
    if (!post) throw new AppError('找不到這則互助。');
    if (pairHidden(actor.id, post.author_id)) {
      throw new AppError('你們已設定不想再遇到，不能收藏這則。');
    }
    const existing = db.prepare(
      'SELECT 1 FROM bookmarks WHERE user_id = ? AND post_id = ?'
    ).get(actor.id, post.id);
    if (existing) {
      db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?').run(actor.id, post.id);
      return { saved: false };
    }
    db.prepare(
      'INSERT INTO bookmarks (user_id, post_id, created_at) VALUES (?, ?, ?)'
    ).run(actor.id, post.id, clock().toISOString());
    return { saved: true };
  }

  function listBookmarks(userId) {
    const nowIso = clock().toISOString();
    return db.prepare(`
      SELECT p.id, p.title, p.description, p.kind, p.status, p.expires_at,
             u.display_name AS author_name, b.created_at AS saved_at,
             (SELECT COUNT(*) FROM posts c WHERE c.status = 'settled' AND (c.host_id = u.id OR c.seeker_id = u.id)) AS author_completed,
             (SELECT COUNT(*) FROM ratings fr WHERE fr.ratee_id = u.id AND fr.stars = 5) AS author_fives
      FROM bookmarks b
      JOIN posts p ON p.id = b.post_id
      JOIN users u ON u.id = p.author_id
      WHERE b.user_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM user_hides h
          WHERE (h.user_id = ? AND h.hidden_user_id = p.author_id)
             OR (h.hidden_user_id = ? AND h.user_id = p.author_id)
        )
      ORDER BY b.created_at DESC, p.id DESC
    `).all(userId, userId, userId).map((post) => {
      const expired = post.status === 'open' && post.expires_at && post.expires_at <= nowIso;
      return {
        ...post,
        author_badge: milestoneBoard(post.author_completed, post.author_fives).highest,
        expired,
        closed: expired || post.status === 'cancelled' || post.status === 'settled',
      };
    });
  }

  function announcementHours(raw) {
    if (raw == null || String(raw).trim() === '') return 72;
    const hours = Number(raw);
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
      throw new AppError('公告時效請填 1 到 720 小時。沒填就是 72 小時。');
    }
    return hours;
  }

  function cleanAnnouncementBody(raw) {
    const text = String(raw || '').replace(/[\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim();
    if ([...text].length < 1) throw new AppError('公告內文必須填寫。');
    if ([...text].length > 40) throw new AppError('公告內文請不要超過 40 個字，大約一兩行。');
    return text;
  }

  function announcementFields(input) {
    return {
      title: cleanOptional(input.title, '標題', 20),
      body: cleanAnnouncementBody(input.body),
      expiresAt: expiresAt(announcementHours(input.hours)),
    };
  }

  function createAnnouncement(actorId, input) {
    const actor = assertFounder(actorId);
    const fields = announcementFields(input);
    const info = db.prepare(`
      INSERT INTO announcements (author_id, title, body, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(actor.id, fields.title, fields.body, clock().toISOString(), fields.expiresAt);
    return db.prepare('SELECT * FROM announcements WHERE id = ?').get(Number(info.lastInsertRowid));
  }

  function updateAnnouncement(actorId, announcementId, input) {
    assertFounder(actorId);
    const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get(announcementId);
    if (!row) throw new AppError('找不到這則公告。');
    if (row.removed_at) throw new AppError('已撤下的公告不能再改。');
    const fields = announcementFields(input);
    db.prepare(`
      UPDATE announcements SET title = ?, body = ?, expires_at = ? WHERE id = ?
    `).run(fields.title, fields.body, fields.expiresAt, row.id);
    return db.prepare('SELECT * FROM announcements WHERE id = ?').get(row.id);
  }

  function removeAnnouncement(actorId, announcementId) {
    assertFounder(actorId);
    const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get(announcementId);
    if (!row) throw new AppError('找不到這則公告。');
    if (!row.removed_at) {
      db.prepare('UPDATE announcements SET removed_at = ? WHERE id = ?').run(clock().toISOString(), row.id);
    }
    return db.prepare('SELECT * FROM announcements WHERE id = ?').get(row.id);
  }

  function currentAnnouncement(viewerId) {
    const row = db.prepare(`
      SELECT id, title, body, expires_at
      FROM announcements
      WHERE removed_at IS NULL AND expires_at > ?
      ORDER BY id DESC
      LIMIT 1
    `).get(clock().toISOString());
    if (!row) return null;
    if (!viewerId) return row;
    const dismissed = db.prepare(`
      SELECT 1 FROM announcement_dismissals
      WHERE user_id = ? AND announcement_id = ?
    `).get(viewerId, row.id);
    return dismissed ? null : row;
  }

  function dismissAnnouncement(userId, announcementId) {
    const user = mustUser(userId);
    const row = db.prepare('SELECT id FROM announcements WHERE id = ?').get(announcementId);
    if (!row) throw new AppError('找不到這則公告。');
    db.prepare(`
      INSERT OR IGNORE INTO announcement_dismissals (user_id, announcement_id, created_at)
      VALUES (?, ?, ?)
    `).run(user.id, row.id, clock().toISOString());
  }

  function listAnnouncements() {
    const now = clock().toISOString();
    const rows = db.prepare(`
      SELECT id, title, body, created_at, expires_at, removed_at
      FROM announcements
      ORDER BY id DESC
      LIMIT 8
    `).all();
    let showing = false;
    return rows.map((row) => {
      const removed = !!row.removed_at;
      const expired = !removed && row.expires_at <= now;
      const live = !removed && !expired && !showing;
      if (live) showing = true;
      return { ...row, removed, expired, live };
    });
  }

  function cleanReportNote(raw) {
    const text = String(raw || '').replace(/[\u0000-\u001F]/g, '').trim();
    if (!text) return null;
    if ([...text].length > 200) throw new AppError('補充說明請不要超過 200 個字。');
    return text;
  }

  function reportSubject(targetType, targetId) {
    if (targetType === 'post') {
      const post = db.prepare('SELECT id, title, description, author_id FROM posts WHERE id = ?').get(targetId);
      if (!post) return null;
      return {
        type: 'post',
        id: post.id,
        ownerId: post.author_id,
        label: post.title || String(post.description || '').slice(0, 42),
        href: `/posts/${post.id}`,
        action: `/posts/${post.id}/report`,
      };
    }
    if (targetType === 'user') {
      const user = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(targetId);
      if (!user) return null;
      return {
        type: 'user',
        id: user.id,
        ownerId: user.id,
        label: user.display_name,
        href: `/users/${user.id}`,
        action: `/users/${user.id}/report`,
      };
    }
    return null;
  }

  function reportForm(reporterId, targetType, targetId) {
    const reporter = mustUser(reporterId);
    const subject = reportSubject(targetType, targetId);
    if (!subject) return null;
    if (subject.ownerId === reporter.id) {
      throw new AppError(subject.type === 'post' ? '不能檢舉自己的貼文。' : '不能檢舉自己。');
    }
    return subject;
  }

  function fileReport(reporterId, targetType, targetId, input) {
    const subject = reportForm(reporterId, targetType, targetId);
    if (!subject) throw new AppError(targetType === 'post' ? '找不到這則互助。' : '找不到這位會員。');
    const reason = String(input && input.reason || '').trim();
    if (!REPORT_REASONS.includes(reason)) throw new AppError('請選擇列出的原因。');
    const note = cleanReportNote(input && input.note);
    const since = new Date(clock().getTime() - REPORT_WINDOW_MS).toISOString();
    const recent = db.prepare(`
      SELECT 1 FROM reports
      WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND created_at > ?
      LIMIT 1
    `).get(reporterId, subject.type, subject.id, since);
    if (recent) throw new AppError('你已經檢舉過了，請 24 小時後再送。');
    const info = db.prepare(`
      INSERT INTO reports (reporter_id, target_type, target_id, reason, note, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `).run(reporterId, subject.type, subject.id, reason, note, clock().toISOString());
    return { id: Number(info.lastInsertRowid) };
  }

  function openReportCount() {
    return db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`).get().n;
  }

  function listOpenReports() {
    return db.prepare(`
      SELECT r.id, r.target_type, r.target_id, r.reason, r.note, r.created_at,
             reporter.display_name AS reporter_name, reporter.id AS reporter_id,
             (
               SELECT COUNT(*) FROM reports c
               WHERE c.target_type = r.target_type AND c.target_id = r.target_id
             ) AS target_count
      FROM reports r
      JOIN users reporter ON reporter.id = r.reporter_id
      WHERE r.status = 'open'
      ORDER BY r.created_at DESC, r.id DESC
    `).all().map((row) => {
      const subject = reportSubject(row.target_type, row.target_id);
      return {
        ...row,
        targetLabel: subject ? subject.label : (row.target_type === 'post' ? '這則貼文已不存在' : '這位會員已不存在'),
        targetHref: subject ? subject.href : '',
      };
    });
  }

  function handleReport(actorId, reportId, status) {
    const actor = assertFounder(actorId);
    if (status !== 'resolved' && status !== 'dismissed') throw new AppError('無法處理這則檢舉。');
    const changed = db.prepare(`
      UPDATE reports
      SET status = ?, handled_at = ?, handled_by = ?
      WHERE id = ? AND status = 'open'
    `).run(status, clock().toISOString(), actor.id, reportId);
    if (changed.changes !== 1) throw new AppError('這則檢舉已經處理過了。');
  }

  // 含剛好 7 天前的那一刻，更早的不算。只讀，不寫入。
  function readCommunityStats() {
    const nowIso = clock().toISOString();
    const since = new Date(clock().getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const members = db.prepare(`
      SELECT
        COALESCE(SUM(role = 'user'), 0) AS users,
        COALESCE(SUM(role = 'org'), 0) AS orgs,
        COALESCE(SUM(role IN ('user', 'org') AND created_at >= ?), 0) AS signups
      FROM users
    `).get(since);
    const openPosts = db.prepare(`
      SELECT COUNT(*) AS n FROM posts
      WHERE status = 'open' AND (expires_at IS NULL OR expires_at > ?)
    `).get(nowIso).n;
    const newPosts = db.prepare(`
      SELECT COUNT(*) AS n FROM posts WHERE created_at >= ?
    `).get(since).n;
    const settledAll = db.prepare(`
      SELECT COUNT(*) AS n FROM posts WHERE status = 'settled'
    `).get().n;
    const settledWeek = db.prepare(`
      SELECT COUNT(*) AS n FROM posts WHERE status = 'settled' AND settled_at >= ?
    `).get(since).n;
    const meritMembers = db.prepare(`
      SELECT COALESCE(SUM(l.delta_merit), 0) AS n
      FROM ledger l
      JOIN users payer ON payer.id = l.counterparty_id
      JOIN users receiver ON receiver.id = l.user_id
      WHERE l.reason = 'settle_receive' AND l.created_at >= ?
        AND payer.role != 'founder' AND receiver.role != 'founder'
    `).get(since).n;
    const meritFounder = db.prepare(`
      SELECT COALESCE(SUM(l.delta_merit), 0) AS n
      FROM ledger l
      JOIN users payer ON payer.id = l.counterparty_id
      WHERE l.reason = 'settle_receive' AND l.created_at >= ? AND payer.role = 'founder'
    `).get(since).n;
    const ratings = db.prepare(`
      SELECT COUNT(*) AS n, AVG(stars) AS avg FROM ratings
    `).get();
    const cities = db.prepare(`
      SELECT city, COUNT(*) AS count
      FROM posts
      WHERE status = 'open' AND city IS NOT NULL AND city != ''
        AND (expires_at IS NULL OR expires_at > ?)
      GROUP BY city
      ORDER BY count DESC, city ASC
      LIMIT 5
    `).all(nowIso);
    const banned = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE blocked = 1`).get().n;
    const pendingOrgs = db.prepare(`
      SELECT COUNT(*) AS n FROM org_applications WHERE status = 'pending'
    `).get().n;
    return {
      users: members.users,
      orgs: members.orgs,
      signups: members.signups,
      openPosts,
      newPosts,
      settledWeek,
      settledAll,
      meritMembers,
      meritFounder,
      ratingAvg: ratings.n ? Math.round(ratings.avg * 10) / 10 : 0,
      ratingCount: ratings.n,
      cities,
      banned,
      pendingOrgs,
      openReports: openReportCount(),
    };
  }

  function communityStats(actorId) {
    assertFounder(actorId);
    return readCommunityStats();
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
            hiddenBy: hiddenByCount(user.id),
          }
          : { missing: true };
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        lookup = { error: err.message };
      }
    }
    const ledger = db.prepare(`
      SELECT l.id, l.created_at, l.delta_merit, l.delta_quota, l.merit_after, l.quota_after,
             l.reason, l.post_id, u.display_name
      FROM ledger l
      JOIN users u ON u.id = l.user_id
      ORDER BY l.id DESC
      LIMIT 30
    `).all();
    return {
      applications,
      blocked,
      lookup,
      ledger,
      announcements: listAnnouncements(),
      reports: listOpenReports(),
      stats: readCommunityStats(),
      thanks: db.prepare(`
        SELECT t.id, t.body, t.created_at, t.hidden_at, t.post_id,
               a.display_name AS author_name, r.display_name AS recipient_name
        FROM thanks t
        JOIN users a ON a.id = t.author_id
        JOIN users r ON r.id = t.recipient_id
        ORDER BY t.id DESC
        LIMIT 30
      `).all(),
    };
  }

  return {
    requestOtp,
    verifyOtp,
    register,
    registerWithPassword,
    requestPasswordReset,
    resetPassword,
    resetPasswordByFounder,
    loginWithPassword,
    ensureFounderAccount,
    ensureFounderFromEnv,
    seedFounder,
    createPost,
    updateAccountPlace,
    updateAvailability,
    acceptPost,
    repostPost,
    cancelPost,
    submitValue,
    retrySettle,
    rate,
    saveThanks,
    removeOwnThanks,
    hideThanks,
    deleteThanks,
    blockUser,
    unblockUser,
    hideUser,
    unhideUser,
    assertCanHide,
    hideRelation,
    pairHidden,
    hiddenByCount,
    createAnnouncement,
    updateAnnouncement,
    removeAnnouncement,
    currentAnnouncement,
    dismissAnnouncement,
    createOrg,
    applyOrg,
    approveApplication,
    rejectApplication,
    latestApplication,
    listOpenPosts,
    cleanSearchQuery,
    priceHint,
    weeklySummary,
    meritHistory,
    dashboard,
    pendingActions,
    pendingRatings,
    getProfile,
    postPage,
    milestoneCounts,
    toggleBookmark,
    listBookmarks,
    acknowledgeRules,
    onboardingFor,
    dismissOnboarding,
    adminSnapshot,
    communityStats,
    reportForm,
    fileReport,
    openReportCount,
    listOpenReports,
    handleReport,
    findByMobile,
    touchLastSeen,
    setHideLastSeen,
  };
}

module.exports = { createServices };
