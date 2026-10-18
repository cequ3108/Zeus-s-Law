const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { AppError } = require('./errors');
const { createServices } = require('./services');
const { isDevMode } = require('./sms');
const { ROLES, KINDS, CATEGORIES, STATUSES } = require('./constants');
const { formatMerit, formatTaipei } = require('./time');

function safeReturn(url) {
  if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\')) {
    return url;
  }
  return '';
}

function settlementFlash(result) {
  if (result.status === 'waiting') {
    return { type: 'ok', message: '已記下你填的金額。等對方也填好就會結算。結算前看不到對方的數字。' };
  }
  if (result.status === 'daily' || result.status === 'insufficient') {
    return { type: 'err', message: result.message };
  }
  if (result.status === 'settled') {
    if (result.amount === 0) {
      return {
        type: 'ok',
        message: '已結算為 0 功德，因為有一方填了 0。雙方餘額不變，但今天這對帳號不能再結算。',
      };
    }
    return {
      type: 'ok',
      message: `已結算 ${formatMerit(result.amount)} 功德（雙方填 ${formatMerit(result.hostValue)} 與 ${formatMerit(result.seekerValue)}，取較低者）。雙方功德額度各增加 ${formatMerit(result.amount)}。接受幫助的人支出功德，提供幫助的人獲得功德。`,
    };
  }
  return { type: 'err', message: '無法結算。' };
}

function createApp(options = {}) {
  if (!options.db) throw new Error('createApp 需要資料庫');
  const services = createServices(options.db, { now: options.now });
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.locals.formatMerit = formatMerit;
  app.locals.formatTaipei = formatTaipei;
  app.locals.roleLabel = (role) => ROLES[role] || role;
  app.locals.kindLabel = (kind) => KINDS[kind] || kind;
  app.locals.categoryLabel = (category) => CATEGORIES[category] || category;
  app.locals.statusLabel = (status) => STATUSES[status] || status;
  app.locals.starGlyph = (value) => {
    if (value == null) return '';
    const full = Math.max(0, Math.min(5, Math.round(Number(value))));
    return '★'.repeat(full) + '☆'.repeat(5 - full);
  };

  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(session({
    name: 'zeus.sid',
    secret: options.sessionSecret || process.env.SESSION_SECRET || 'zeus-dev-session',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: options.cookieSecure ?? process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'"
    );
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
    res.locals.csrf = req.session.csrf;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.devSms = isDevMode();
    res.locals.currentPath = req.path;
    res.locals.user = null;
    if (req.session.userId) {
      res.locals.user = options.db.prepare(`
        SELECT id, mobile, display_name, role, merit, quota, blocked, block_reason
        FROM users WHERE id = ?
      `).get(req.session.userId) || null;
      if (!res.locals.user) delete req.session.userId;
    }
    next();
  });

  function asyncRoute(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  }

  function requireCsrf(req, res, next) {
    if (!req.body || req.body._csrf !== req.session.csrf) {
      res.status(403).render('error', { title: '表單過期', message: '表單已過期，請回上一頁重新送出。' });
      return;
    }
    next();
  }

  function requireLogin(req, res, next) {
    if (!res.locals.user) {
      const nextUrl = safeReturn(req.originalUrl);
      if (nextUrl) req.session.returnTo = nextUrl;
      req.session.flash = { type: 'err', message: '請先用手機號碼登入。' };
      res.redirect('/login');
      return;
    }
    next();
  }

  function requireFounder(req, res, next) {
    if (!res.locals.user) {
      res.redirect('/login');
      return;
    }
    if (res.locals.user.role !== 'founder') {
      res.status(403).render('error', { title: '沒有權限', message: '只有創辦人可以進入管理頁。' });
      return;
    }
    next();
  }

  function redirectWith(req, res, url, flash) {
    if (flash) req.session.flash = flash;
    res.redirect(url);
  }

  function handle(err, req, res, url) {
    if (!(err instanceof AppError)) throw err;
    redirectWith(req, res, url, { type: 'err', message: err.message });
  }

  function parseId(raw) {
    if (!/^\d+$/.test(String(raw || ''))) return null;
    return Number(raw);
  }

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.get('/', (req, res) => {
    res.render('home', { title: '廣場', posts: services.listOpenPosts() });
  });

  app.get('/rules', (req, res) => {
    res.render('rules', { title: '規範' });
  });

  app.get('/login', (req, res) => {
    if (res.locals.user) {
      res.redirect('/me');
      return;
    }
    const nextUrl = safeReturn(req.query.next);
    if (nextUrl) req.session.returnTo = nextUrl;
    res.render('login', { title: '登入' });
  });

  app.post('/login/password', requireCsrf, (req, res) => {
    try {
      const user = services.loginWithPassword(req.body.mobile, req.body.password);
      req.session.userId = user.id;
      const dest = safeReturn(req.session.returnTo) || '/me';
      delete req.session.returnTo;
      redirectWith(req, res, dest, { type: 'ok', message: '已登入。' });
    } catch (err) {
      handle(err, req, res, '/login');
    }
  });

  app.post('/join', requireCsrf, (req, res) => {
    if (!isDevMode()) {
      redirectWith(req, res, '/login', { type: 'err', message: '已接上簡訊時，請用驗證碼建立帳號。' });
      return;
    }
    try {
      const user = services.registerWithPassword(
        req.body.mobile,
        req.body.display_name,
        req.body.password,
        req.body.password_confirm,
      );
      req.session.userId = user.id;
      const dest = safeReturn(req.session.returnTo) || '/me';
      delete req.session.returnTo;
      redirectWith(req, res, dest, {
        type: 'ok',
        message: '帳號已建立。功德額度 100，功德 100。之後用手機號碼與密碼登入。',
      });
    } catch (err) {
      handle(err, req, res, '/login');
    }
  });

  app.post('/login', requireCsrf, asyncRoute(async (req, res) => {
    try {
      const result = await services.requestOtp(req.body.mobile);
      req.session.otpMobile = result.mobile;
      req.session.devCode = result.devCode;
      res.redirect('/verify');
    } catch (err) {
      handle(err, req, res, '/login');
    }
  }));

  app.get('/verify', (req, res) => {
    if (!req.session.otpMobile) {
      res.redirect('/login');
      return;
    }
    res.render('verify', {
      title: '驗證碼',
      mobile: req.session.otpMobile,
      devCode: req.session.devCode || null,
    });
  });

  app.post('/verify', requireCsrf, (req, res) => {
    const mobile = req.session.otpMobile;
    if (!mobile) {
      res.redirect('/login');
      return;
    }
    try {
      const result = services.verifyOtp(mobile, req.body.code);
      delete req.session.devCode;
      delete req.session.otpMobile;
      if (result.user) {
        req.session.userId = result.user.id;
        const dest = safeReturn(req.session.returnTo) || '/me';
        delete req.session.returnTo;
        redirectWith(req, res, dest, { type: 'ok', message: '已登入。' });
        return;
      }
      req.session.verifiedMobile = result.mobile;
      res.redirect('/register');
    } catch (err) {
      handle(err, req, res, '/verify');
    }
  });

  app.get('/register', (req, res) => {
    if (res.locals.user) {
      res.redirect('/me');
      return;
    }
    if (!req.session.verifiedMobile) {
      res.redirect('/login');
      return;
    }
    res.render('register', { title: '建立帳號', mobile: req.session.verifiedMobile });
  });

  app.post('/register', requireCsrf, (req, res) => {
    const mobile = req.session.verifiedMobile;
    if (!mobile) {
      res.redirect('/login');
      return;
    }
    try {
      const user = services.register(mobile, req.body.display_name);
      delete req.session.verifiedMobile;
      req.session.userId = user.id;
      const dest = safeReturn(req.session.returnTo) || '/me';
      delete req.session.returnTo;
      redirectWith(req, res, dest, {
        type: 'ok',
        message: '帳號已建立。功德額度 100，功德 100。1 功德等於 1 元新台幣。',
      });
    } catch (err) {
      handle(err, req, res, '/register');
    }
  });

  app.post('/logout', requireCsrf, (req, res) => {
    req.session.destroy(() => res.redirect('/'));
  });

  app.get('/me', requireLogin, (req, res) => {
    res.render('me', { title: '我的交易', dash: services.dashboard(res.locals.user.id) });
  });

  app.get('/account', requireLogin, (req, res) => {
    res.render('account', { title: '我的帳號' });
  });

  app.get('/posts/new', requireLogin, (req, res) => {
    res.render('post-new', { title: '發布' });
  });

  app.post('/posts', requireCsrf, requireLogin, (req, res) => {
    try {
      const post = services.createPost(res.locals.user.id, req.body);
      redirectWith(req, res, `/posts/${post.id}`, { type: 'ok', message: '已發布。' });
    } catch (err) {
      handle(err, req, res, '/posts/new');
    }
  });

  app.get('/posts/:id', (req, res) => {
    const id = parseId(req.params.id);
    const model = id ? services.postPage(id, res.locals.user && res.locals.user.id) : null;
    if (!model) {
      res.status(404).render('error', { title: '找不到', message: '找不到這則互助。' });
      return;
    }
    res.render('post', { title: KINDS[model.kind] || '互助', model });
  });

  app.post('/posts/:id/accept', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const back = `/posts/${req.params.id}`;
    if (!id) {
      res.redirect('/');
      return;
    }
    try {
      services.acceptPost(id, res.locals.user.id);
      redirectWith(req, res, back, { type: 'ok', message: '已接下。互助完成後，雙方各自填寫這次值多少。' });
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.post('/posts/:id/cancel', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const back = `/posts/${req.params.id}`;
    try {
      services.cancelPost(id, res.locals.user.id);
      redirectWith(req, res, back, { type: 'ok', message: '已取消。' });
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.post('/posts/:id/value', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const back = `/posts/${req.params.id}`;
    if (req.body.confirm_done !== '1') {
      redirectWith(req, res, back, { type: 'err', message: '請確認互助已完成，而且沒有現金。' });
      return;
    }
    try {
      const result = services.submitValue(id, res.locals.user.id, req.body.value);
      redirectWith(req, res, back, settlementFlash(result));
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.post('/posts/:id/settle', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const back = `/posts/${req.params.id}`;
    try {
      const result = services.retrySettle(id, res.locals.user.id);
      redirectWith(req, res, back, settlementFlash(result));
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.post('/posts/:id/rating', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const back = `/posts/${req.params.id}`;
    try {
      services.rate(id, res.locals.user.id, req.body.stars, req.body.comment);
      redirectWith(req, res, back, { type: 'ok', message: '已送出星等。星等會出現在對方的個人頁，備註不會顯示。' });
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.get('/users/:id', (req, res) => {
    const id = parseId(req.params.id);
    const profile = id ? services.getProfile(id) : null;
    if (!profile) {
      res.status(404).render('error', { title: '找不到', message: '找不到這位使用者。' });
      return;
    }
    const own = res.locals.user && res.locals.user.id === profile.user.id ? res.locals.user : null;
    res.render('profile', { title: profile.user.display_name, profile, own });
  });

  app.get('/org/apply', requireLogin, (req, res) => {
    res.render('org-apply', {
      title: '申請福利機構',
      application: services.latestApplication(res.locals.user.id),
    });
  });

  app.post('/org/apply', requireCsrf, requireLogin, (req, res) => {
    try {
      services.applyOrg(res.locals.user.id, req.body.org_name);
      redirectWith(req, res, '/org/apply', { type: 'ok', message: '已送出申請。創辦人審核通過後，這個帳號才會變成福利機構。' });
    } catch (err) {
      handle(err, req, res, '/org/apply');
    }
  });

  app.get('/admin', requireFounder, (req, res) => {
    res.render('admin', {
      title: '管理',
      data: services.adminSnapshot(res.locals.user.id, String(req.query.mobile || '').trim()),
      queryMobile: String(req.query.mobile || ''),
    });
  });

  app.post('/admin/orgs', requireCsrf, requireFounder, (req, res) => {
    try {
      const result = services.createOrg(res.locals.user.id, req.body.mobile, req.body.display_name);
      const verb = result.created ? '已建立福利機構' : '已升為福利機構';
      redirectWith(req, res, '/admin', {
        type: 'ok',
        message: `${verb}「${result.user.display_name}」。功德與功德額度為 ${formatMerit(result.user.merit)}。請用這個手機號碼登入。`,
      });
    } catch (err) {
      handle(err, req, res, '/admin');
    }
  });

  app.post('/admin/block', requireCsrf, requireFounder, (req, res) => {
    try {
      const user = services.blockUser(res.locals.user.id, req.body.mobile, req.body.reason);
      redirectWith(req, res, '/admin', { type: 'ok', message: `已封鎖 ${user.display_name}。被封鎖的人不能發布或接下。` });
    } catch (err) {
      handle(err, req, res, '/admin');
    }
  });

  app.post('/admin/unblock', requireCsrf, requireFounder, (req, res) => {
    try {
      const user = services.unblockUser(res.locals.user.id, req.body.mobile);
      redirectWith(req, res, '/admin', { type: 'ok', message: `已解除 ${user.display_name} 的封鎖。` });
    } catch (err) {
      handle(err, req, res, '/admin');
    }
  });

  app.post('/admin/applications/:id/approve', requireCsrf, requireFounder, (req, res) => {
    try {
      const user = services.approveApplication(res.locals.user.id, parseId(req.params.id));
      redirectWith(req, res, '/admin', {
        type: 'ok',
        message: `已通過「${user.display_name}」。功德與功德額度為 ${formatMerit(user.merit)}。`,
      });
    } catch (err) {
      handle(err, req, res, '/admin');
    }
  });

  app.post('/admin/applications/:id/reject', requireCsrf, requireFounder, (req, res) => {
    try {
      services.rejectApplication(res.locals.user.id, parseId(req.params.id));
      redirectWith(req, res, '/admin', { type: 'ok', message: '已拒絕這份申請。' });
    } catch (err) {
      handle(err, req, res, '/admin');
    }
  });

  app.use((req, res) => {
    res.status(404).render('error', { title: '找不到', message: '找不到這個頁面。' });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).render('error', { title: '錯誤', message: '系統發生錯誤，請再試一次。' });
  });

  return app;
}

module.exports = { createApp, safeReturn };
