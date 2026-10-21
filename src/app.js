const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { SqliteStore } = require('./sessions');
const { asset, publicDir, manifestBody, swBody } = require('./assets');
const { contentSecurityPolicy } = require('./large-text-boot');
const { AppError } = require('./errors');
const { cleanPassword } = require('./password');
const { createServices } = require('./services');
const { isDevMode } = require('./sms');
const {
  ROLES, KINDS, CATEGORIES, STATUSES, RATING_TAGS,
  MEETING_MODES, HOME_VISIT_MODE, HOME_VISIT_NOTE, REPORT_REASONS,
} = require('./constants');
const { RULES_HIGHLIGHTS, RULES_PAGE } = require('./rules-copy');
const { CITIES, DISTRICTS, normalizeCity, normalizeDistrict, placeLabel } = require('./places');
const { SLOTS, parseSlots } = require('./slots');
const { templatesFor, findTemplate } = require('./templates');
const { formatMerit, formatTaipei } = require('./time');

const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const MOBILE_COOKIE = 'zeus.mobile';
const COMPACT_PATHS = new Set([
  '/login', '/login/code', '/join', '/forgot', '/forgot/reset', '/verify', '/register',
]);

function safeReturn(url) {
  if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\')) {
    return url;
  }
  return '';
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const index = trimmed.indexOf('=');
    if (index === -1 || trimmed.slice(0, index) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(index + 1));
    } catch {
      return '';
    }
  }
  return '';
}

function typedMobile(raw) {
  const mobile = String(raw ?? '').replace(/[\s-]/g, '');
  return /^09\d{8}$/.test(mobile) ? mobile : '';
}

function applyRemember(req, remember) {
  req.session.cookie.maxAge = remember ? REMEMBER_MS : null;
}

function rememberPhone(req, res, mobile, remember) {
  const options = {
    path: '/',
    sameSite: 'lax',
    secure: req.session.cookie.secure === true,
    httpOnly: true,
  };
  if (remember && /^09\d{8}$/.test(mobile)) {
    res.cookie(MOBILE_COOKIE, mobile, { ...options, maxAge: REMEMBER_MS });
    return;
  }
  res.clearCookie(MOBILE_COOKIE, options);
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
  app.set('trust proxy', options.trustProxy ?? 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.locals.formatMerit = formatMerit;
  app.locals.formatTaipei = formatTaipei;
  app.locals.roleLabel = (role) => ROLES[role] || role;
  app.locals.kindLabel = (kind) => KINDS[kind] || kind;
  app.locals.categoryLabel = (category) => CATEGORIES[category] || category;
  app.locals.statusLabel = (status) => STATUSES[status] || status;
  app.locals.ratingTags = RATING_TAGS;
  app.locals.meetingModes = MEETING_MODES;
  app.locals.homeVisitMode = HOME_VISIT_MODE;
  app.locals.homeVisitNote = HOME_VISIT_NOTE;
  app.locals.reportReasons = REPORT_REASONS;
  app.locals.rulesHighlights = RULES_HIGHLIGHTS;
  app.locals.rulesPage = RULES_PAGE;
  app.locals.ledgerReason = (reason) => ({
    signup: '註冊',
    founder_seed: '建立創辦人',
    org_create: '建立機構',
    founder_endow: '升為創辦人',
    org_endow: '升為機構',
    settle_spend: '結算支出',
    settle_receive: '結算收入',
    reserve: '預留功德',
    reserve_refund: '退回預留',
    reserve_release: '預留轉入結算',
  }[reason] || reason);
  app.locals.starGlyph = (value) => {
    if (value == null) return '';
    const full = Math.max(0, Math.min(5, Math.round(Number(value))));
    return '★'.repeat(full) + '☆'.repeat(5 - full);
  };
  app.locals.asset = asset;
  app.locals.placeLabel = placeLabel;
  app.locals.slots = SLOTS;
  app.locals.parseSlots = parseSlots;

  app.get('/manifest.webmanifest', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(manifestBody);
  });
  app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(swBody);
  });
  app.get('/sw-policy.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(fs.readFileSync(path.join(publicDir, 'sw-policy.js')));
  });

  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use(express.static(publicDir, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    immutable: true,
  }));
  app.use(session({
    name: 'zeus.sid',
    secret: options.sessionSecret || process.env.SESSION_SECRET || 'zeus-dev-session',
    resave: false,
    saveUninitialized: false,
    proxy: true,
    store: options.sessionStore || new SqliteStore(options.db),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: options.cookieSecure ?? 'auto',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', contentSecurityPolicy());
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
    res.locals.csrf = req.session.csrf;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.devSms = isDevMode();
    res.locals.compactAuth = COMPACT_PATHS.has(req.path);
    const remembered = readCookie(req, MOBILE_COOKIE);
    res.locals.rememberedMobile = /^09\d{8}$/.test(remembered) ? remembered : '';
    res.locals.currentPath = req.path;
    services.releaseExpiredReservations();
    res.locals.user = null;
    if (req.session.userId) {
      res.locals.user = options.db.prepare(`
        SELECT id, mobile, display_name, role, merit, quota, blocked, block_reason, city, district, availability, slots,
               rules_acknowledged_at, last_seen_at, hide_last_seen
        FROM users WHERE id = ?
      `).get(req.session.userId) || null;
      if (!res.locals.user) delete req.session.userId;
      else services.touchLastSeen(res.locals.user.id, res.locals.user.last_seen_at);
    }
    res.locals.actionCount = res.locals.user ? services.pendingActions(res.locals.user.id) : 0;
    res.locals.expiringCount = res.locals.user ? services.expiringSoonCount(res.locals.user.id) : 0;
    res.locals.watchNew = res.locals.user ? services.watchNewCount(res.locals.user.id) : 0;
    res.locals.ratingReminders = res.locals.user
      ? services.pendingRatings(res.locals.user.id)
      : { total: 0, items: [], day: '' };
    res.locals.openReports = res.locals.user && res.locals.user.role === 'founder'
      ? services.openReportCount()
      : 0;
    res.locals.clearDraft = '';
    if (req.method === 'GET' && req.session.clearDraft) {
      const flag = String(req.session.clearDraft);
      if (/^[0-9]+$/.test(flag)) res.locals.clearDraft = flag;
      delete req.session.clearDraft;
    }
    next();
  });

  function asyncRoute(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  }

  function formReturn(req) {
    const referer = req.get('referer') || '';
    try {
      const url = new URL(referer, 'http://localhost');
      if (safeReturn(url.pathname)) return url.pathname + url.search;
    } catch {
      // 來源不是網址時，改回這個動作對應的頁面。
    }
    const reportPost = String(req.path || '').match(/^\/posts\/(\d+)\/report$/);
    if (reportPost) return `/posts/${reportPost[1]}/report`;
    const reportUser = String(req.path || '').match(/^\/users\/(\d+)\/report$/);
    if (reportUser) return `/users/${reportUser[1]}/report`;
    const post = String(req.path || '').match(/^\/posts\/(\d+)/);
    if (post) return `/posts/${post[1]}`;
    if (req.path === '/account' || req.path.startsWith('/account/')) return '/account';
    if (req.path === '/watch/check') return '/';
    if (req.path.startsWith('/admin')) return '/admin';
    if (req.path.startsWith('/announcements/')) return '/';
    const personalHide = String(req.path || '').match(/^\/users\/(\d+)\/(?:hide|unhide)$/);
    if (personalHide) {
      return req.path.endsWith('/unhide') ? '/me' : `/users/${personalHide[1]}/hide`;
    }
    if (req.path.startsWith('/org')) return '/org/apply';
    if (req.path === '/posts' || req.path === '/posts/new') return '/posts/new';
    if (req.path === '/rules/ack') return safeReturn(req.body && req.body.return) || '/me';
    if (req.path === '/onboarding/dismiss') return '/';
    if (req.path === '/forgot' || req.path === '/forgot/reset') return '/forgot';
    if (req.path === '/login/code' || req.path === '/verify') return '/login/code';
    if (req.path === '/join' || req.path === '/register') return '/join';
    return '/login';
  }

  function rejectStaleForm(req, res) {
    const message = '表單已更新，請再送出一次。';
    const again = () => {
      res.locals.flash = { type: 'err', message };
    };
    if (req.path === '/login' || req.path === '/login/password') {
      again();
      res.status(403).render('login', { title: '登入' });
      return;
    }
    if (req.path === '/join') {
      again();
      res.status(403).render('join', { title: '建立帳號' });
      return;
    }
    if (req.path === '/login/code') {
      again();
      res.status(403).render('login-code', { title: '用驗證碼登入' });
      return;
    }
    if (req.path === '/forgot') {
      again();
      res.status(403).render('forgot', { title: '忘記密碼' });
      return;
    }
    if (req.path === '/forgot/reset' && req.session.otpMobile && req.session.otpPurpose === 'reset') {
      again();
      res.status(403).render('forgot-reset', {
        title: '設定新密碼',
        mobile: req.session.otpMobile,
        devCode: req.session.devCode || null,
      });
      return;
    }
    if (req.path === '/verify' && req.session.otpMobile && req.session.otpPurpose !== 'reset') {
      again();
      res.status(403).render('verify', {
        title: '驗證碼',
        mobile: req.session.otpMobile,
        devCode: req.session.devCode || null,
      });
      return;
    }
    if (req.path === '/register' && req.session.verifiedMobile) {
      again();
      res.status(403).render('register', { title: '建立帳號', mobile: req.session.verifiedMobile });
      return;
    }
    req.session.flash = { type: 'err', message };
    res.redirect(303, formReturn(req));
  }

  function requireCsrf(req, res, next) {
    if (!req.session) {
      rejectStaleForm(req, res);
      return;
    }
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
    if (!req.body || req.body._csrf !== req.session.csrf) {
      rejectStaleForm(req, res);
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
    if (req.query['clear-draft'] === '1') res.locals.clearDraft = 'all';
    const watchPrefs = res.locals.user ? services.readWatchPrefs(res.locals.user.id) : null;
    const filterWatch = req.query.watch === '1' && !!(watchPrefs && watchPrefs.active);
    const rawCity = String(req.query.city || '').trim();
    let city = rawCity;
    if (!rawCity && res.locals.user && res.locals.user.city && !filterWatch) city = res.locals.user.city;
    if (rawCity === 'all') city = '';
    let normalized = '';
    if (city) {
      try {
        normalized = normalizeCity(city);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
      }
    }
    const category = CATEGORIES[req.query.category] ? req.query.category : '';
    const publicMeeting = req.query.public === '1';
    const query = services.cleanSearchQuery(req.query.q);
    const sort = ['amount_desc', 'amount_asc', 'expiry'].includes(req.query.sort) ? req.query.sort : 'new';
    const mine = res.locals.user && res.locals.user.city && res.locals.user.district
      ? { city: res.locals.user.city, district: res.locals.user.district }
      : null;
    const filterLocal = req.query.local === '1' && !!mine;
    const fitSlots = res.locals.user ? parseSlots(res.locals.user.slots) : [];
    const filterFit = req.query.fit === '1' && fitSlots.length > 0;
    let district = '';
    const rawDistrict = Array.isArray(req.query.district) ? req.query.district[0] : req.query.district;
    if (normalized && rawDistrict) {
      try {
        district = normalizeDistrict(rawDistrict, normalized) || '';
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
      }
    }
    const kept = new URLSearchParams();
    kept.set('city', normalized || 'all');
    if (district) kept.set('district', district);
    if (category) kept.set('category', category);
    if (publicMeeting) kept.set('public', '1');
    if (filterLocal) kept.set('local', '1');
    if (filterFit) kept.set('fit', '1');
    if (sort !== 'new') kept.set('sort', sort);
    if (filterWatch) kept.set('watch', '1');
    const onboarding = res.locals.user ? services.onboardingFor(res.locals.user.id) : null;
    if (onboarding && onboarding.complete) services.dismissOnboarding(res.locals.user.id);
    res.render('home', {
      title: '廣場',
      posts: services.listOpenPosts({
        city: normalized || null,
        district: district || null,
        localCity: filterLocal ? mine.city : null,
        localDistrict: filterLocal ? mine.district : null,
        fitSlots: filterFit ? fitSlots : null,
        category: category || null,
        watchCategories: filterWatch ? watchPrefs.categories : null,
        watchCounties: filterWatch ? watchPrefs.counties : null,
        publicMeeting,
        query,
        sort,
        viewerId: res.locals.user && res.locals.user.id,
      }),
      cities: CITIES,
      districts: DISTRICTS,
      filterCity: normalized || 'all',
      filterDistrict: district,
      filterLocal,
      filterFit,
      filterWatch,
      filterCategory: category,
      filterPublic: publicMeeting,
      filterQuery: query,
      filterSort: sort,
      searchClearPath: `/?${kept.toString()}`,
      announcement: services.currentAnnouncement(res.locals.user && res.locals.user.id),
      onboarding,
    });
  });

  app.post('/onboarding/dismiss', requireCsrf, requireLogin, (req, res) => {
    services.dismissOnboarding(res.locals.user.id);
    res.redirect('/');
  });

  app.get('/rules', (req, res) => {
    res.render('rules', { title: RULES_PAGE.title });
  });

  app.post('/rules/ack', requireCsrf, requireLogin, (req, res) => {
    services.acknowledgeRules(res.locals.user.id);
    res.redirect(safeReturn(req.body.return) || '/me');
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
    const remember = req.body.remember === '1';
    let user;
    try {
      user = services.loginWithPassword(req.body.mobile, req.body.password);
    } catch (err) {
      const typed = typedMobile(req.body.mobile);
      if (!remember) rememberPhone(req, res, '', false);
      else if (typed) rememberPhone(req, res, typed, true);
      handle(err, req, res, '/login');
      return;
    }
    const dest = safeReturn(req.session.returnTo) || '/me';
    req.session.regenerate((err) => {
      if (err) {
        console.error(err);
        res.status(500).render('error', { title: '錯誤', message: '系統發生錯誤，請再試一次。' });
        return;
      }
      applyRemember(req, remember);
      rememberPhone(req, res, user.mobile, remember);
      req.session.userId = user.id;
      services.touchLastSeen(user.id);
      redirectWith(req, res, dest, { type: 'ok', message: '已登入。' });
    });
  });

  app.get('/join', (req, res) => {
    if (res.locals.user) {
      res.redirect('/me');
      return;
    }
    res.render('join', { title: '建立帳號' });
  });

  app.post('/join', requireCsrf, (req, res) => {
    if (!isDevMode()) {
      redirectWith(req, res, '/join', { type: 'err', message: '已接上簡訊時，請用驗證碼建立帳號。' });
      return;
    }
    try {
      const user = services.registerWithPassword(
        req.body.mobile,
        req.body.display_name,
        req.body.password,
        req.body.password_confirm,
      );
      rememberPhone(req, res, user.mobile, true);
      req.session.userId = user.id;
      services.touchLastSeen(user.id);
      const dest = safeReturn(req.session.returnTo) || '/me';
      delete req.session.returnTo;
      redirectWith(req, res, dest, {
        type: 'ok',
        message: '帳號已建立。功德額度 100，功德 100。之後用手機號碼與密碼登入。',
      });
    } catch (err) {
      handle(err, req, res, '/join');
    }
  });

  app.get('/login/code', (req, res) => {
    if (res.locals.user) {
      res.redirect('/me');
      return;
    }
    res.render('login-code', { title: '用驗證碼登入' });
  });

  app.get('/forgot', (req, res) => {
    res.render('forgot', { title: '忘記密碼' });
  });

  app.post('/forgot', requireCsrf, asyncRoute(async (req, res) => {
    try {
      const result = await services.requestPasswordReset(req.body.mobile);
      req.session.otpMobile = result.mobile;
      req.session.devCode = result.devCode;
      req.session.otpPurpose = 'reset';
      res.redirect('/forgot/reset');
    } catch (err) {
      handle(err, req, res, '/forgot');
    }
  }));

  app.get('/forgot/reset', (req, res) => {
    if (!req.session.otpMobile || req.session.otpPurpose !== 'reset') {
      res.redirect('/forgot');
      return;
    }
    res.render('forgot-reset', {
      title: '設定新密碼',
      mobile: req.session.otpMobile,
      devCode: req.session.devCode || null,
    });
  });

  app.post('/forgot/reset', requireCsrf, (req, res) => {
    const mobile = req.session.otpMobile;
    if (!mobile || req.session.otpPurpose !== 'reset') {
      res.redirect('/forgot');
      return;
    }
    try {
      const password = cleanPassword(req.body.password);
      if (password !== String(req.body.password_confirm ?? '')) throw new AppError('兩次輸入的密碼不一樣。');
      services.verifyOtp(mobile, req.body.code);
      const user = services.resetPassword(mobile, password, password);
      delete req.session.devCode;
      delete req.session.otpMobile;
      delete req.session.otpPurpose;
      applyRemember(req, true);
      rememberPhone(req, res, user.mobile, true);
      req.session.userId = user.id;
      services.touchLastSeen(user.id);
      redirectWith(req, res, '/account', { type: 'ok', message: '密碼已更新。' });
    } catch (err) {
      handle(err, req, res, '/forgot/reset');
    }
  });

  app.post('/login', requireCsrf, asyncRoute(async (req, res) => {
    try {
      const result = await services.requestOtp(req.body.mobile);
      req.session.otpMobile = result.mobile;
      req.session.devCode = result.devCode;
      req.session.otpPurpose = 'login';
      res.redirect('/verify');
    } catch (err) {
      handle(err, req, res, '/login/code');
    }
  }));

  app.get('/verify', (req, res) => {
    if (req.session.otpPurpose === 'reset') {
      res.redirect('/forgot/reset');
      return;
    }
    if (!req.session.otpMobile) {
      res.redirect('/login/code');
      return;
    }
    res.render('verify', {
      title: '驗證碼',
      mobile: req.session.otpMobile,
      devCode: req.session.devCode || null,
    });
  });

  app.post('/verify', requireCsrf, (req, res) => {
    if (req.session.otpPurpose === 'reset') {
      res.redirect('/forgot/reset');
      return;
    }
    const mobile = req.session.otpMobile;
    if (!mobile) {
      res.redirect('/login/code');
      return;
    }
    try {
      const result = services.verifyOtp(mobile, req.body.code);
      delete req.session.devCode;
      delete req.session.otpMobile;
      delete req.session.otpPurpose;
      if (result.user) {
        req.session.userId = result.user.id;
        services.touchLastSeen(result.user.id);
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
      res.redirect('/login/code');
      return;
    }
    res.render('register', { title: '建立帳號', mobile: req.session.verifiedMobile });
  });

  app.post('/register', requireCsrf, (req, res) => {
    const mobile = req.session.verifiedMobile;
    if (!mobile) {
      res.redirect('/login/code');
      return;
    }
    try {
      const user = services.register(mobile, req.body.display_name);
      delete req.session.verifiedMobile;
      req.session.userId = user.id;
      services.touchLastSeen(user.id);
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
    req.session.destroy(() => res.redirect('/?clear-draft=1'));
  });

  app.get('/me', requireLogin, (req, res) => {
    res.render('me', { title: '我的交易', dash: services.dashboard(res.locals.user.id) });
  });

  app.get('/account', requireLogin, (req, res) => {
    const watch = services.readWatchPrefs(res.locals.user.id);
    res.render('account', {
      title: '我的帳號',
      cities: CITIES,
      districts: DISTRICTS,
      week: services.weeklySummary(res.locals.user.id),
      watchCategories: watch.categories,
      watchCounties: watch.active ? watch.counties : (res.locals.user.city ? [res.locals.user.city] : []),
      watchActive: watch.active,
    });
  });

  app.post('/account/watch', requireCsrf, requireLogin, (req, res) => {
    try {
      const saved = services.saveWatchPrefs(res.locals.user.id, req.body.categories, req.body.counties);
      redirectWith(req, res, '/account', {
        type: 'ok',
        message: saved.active ? '已記下你關注的類別與縣市。' : '已清除關注。首頁不會再提醒。',
      });
    } catch (err) {
      handle(err, req, res, '/account');
    }
  });

  app.post('/watch/check', requireCsrf, requireLogin, (req, res) => {
    services.markWatchChecked(res.locals.user.id);
    res.redirect('/?watch=1&city=all');
  });

  app.post('/account/last-seen', requireCsrf, requireLogin, (req, res) => {
    const hide = req.body.hide_last_seen === '1';
    services.setHideLastSeen(res.locals.user.id, hide);
    const back = safeReturn(req.body.return) || '/account';
    redirectWith(req, res, back, {
      type: 'ok',
      message: hide ? '已不對其他人顯示上線狀態。' : '已對其他人顯示上線狀態。',
    });
  });

  app.post('/account', requireCsrf, requireLogin, (req, res) => {
    try {
      services.updateSlots(res.locals.user.id, req.body.slots);
      services.updateAccountPlace(res.locals.user.id, req.body);
      services.updateAvailability(res.locals.user.id, req.body.availability);
      redirectWith(req, res, '/account', { type: 'ok', message: '已記下你的縣市與今日空檔。' });
    } catch (err) {
      handle(err, req, res, '/account');
    }
  });

  app.get('/posts/new', requireLogin, (req, res) => {
    const templates = templatesFor(res.locals.user.role);
    const fromId = parseId(Array.isArray(req.query.from) ? req.query.from[0] : req.query.from);
    const repeat = fromId ? services.repeatSource(fromId, res.locals.user.id) : null;
    const hintCity = (repeat && repeat.city) || res.locals.user.city || null;
    res.render('post-new', {
      title: '發布',
      cities: CITIES,
      districts: DISTRICTS,
      templates,
      selected: repeat ? null : findTemplate(String(req.query.template || ''), res.locals.user.role),
      repeat,
      hints: ['food', 'transport', 'other'].map((category) => ({
        category,
        hint: services.priceHint(category, hintCity),
      })),
    });
  });

  app.post('/posts', requireCsrf, requireLogin, (req, res) => {
    try {
      const post = services.createPost(res.locals.user.id, req.body);
      req.session.clearDraft = String(res.locals.user.id);
      redirectWith(req, res, `/posts/${post.id}`, { type: 'ok', message: '已發布。' });
    } catch (err) {
      handle(err, req, res, '/posts/new');
    }
  });

  function renderReport(req, res, targetType) {
    const id = parseId(req.params.id);
    if (!id) {
      res.redirect(targetType === 'post' ? '/' : '/');
      return;
    }
    try {
      const subject = services.reportForm(res.locals.user.id, targetType, id);
      if (!subject) {
        res.status(404).render('error', {
          title: '找不到',
          message: targetType === 'post' ? '找不到這則互助。' : '找不到這位會員。',
        });
        return;
      }
      res.render('report', { title: '檢舉', subject });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      const back = targetType === 'post' ? `/posts/${id}` : `/users/${id}`;
      redirectWith(req, res, back, { type: 'err', message: err.message });
    }
  }

  function submitReport(req, res, targetType) {
    const id = parseId(req.params.id);
    const form = `/${targetType === 'post' ? 'posts' : 'users'}/${req.params.id}/report`;
    if (!id) {
      res.redirect('/');
      return;
    }
    try {
      services.fileReport(res.locals.user.id, targetType, id, req.body);
      redirectWith(req, res, targetType === 'post' ? `/posts/${id}` : `/users/${id}`, {
        type: 'ok',
        message: '已收到，創辦人會盡快處理',
      });
    } catch (err) {
      handle(err, req, res, form);
    }
  }

  app.get('/posts/:id/report', requireLogin, (req, res) => {
    renderReport(req, res, 'post');
  });

  app.post('/posts/:id/report', requireLogin, requireCsrf, (req, res) => {
    submitReport(req, res, 'post');
  });

  app.post('/posts/:id/questions', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const back = `/posts/${req.params.id}#qa`;
    if (!id) {
      res.redirect('/');
      return;
    }
    try {
      services.askQuestion(id, res.locals.user.id, req.body.question);
      redirectWith(req, res, back, { type: 'ok', message: '已送出提問。' });
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.post('/posts/:id/questions/:qid/answer', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const qid = parseId(req.params.qid);
    const back = `/posts/${req.params.id}#qa`;
    if (!id || !qid) {
      res.redirect(id ? `/posts/${id}` : '/');
      return;
    }
    try {
      services.answerQuestion(id, qid, res.locals.user.id, req.body.answer);
      redirectWith(req, res, back, { type: 'ok', message: '已回覆。' });
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.post('/posts/:id/questions/:qid/hide', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const qid = parseId(req.params.qid);
    const back = `/posts/${req.params.id}#qa`;
    if (!id || !qid) {
      res.redirect('/');
      return;
    }
    try {
      services.hideQuestion(id, qid, res.locals.user.id);
      redirectWith(req, res, back, { type: 'ok', message: '已隱藏這則提問。' });
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.post('/posts/:id/questions/:qid/delete', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const qid = parseId(req.params.qid);
    const back = `/posts/${req.params.id}#qa`;
    if (!id || !qid) {
      res.redirect('/');
      return;
    }
    try {
      services.deleteQuestion(id, qid, res.locals.user.id);
      redirectWith(req, res, back, { type: 'ok', message: '已刪除這則提問。' });
    } catch (err) {
      handle(err, req, res, back);
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
      const joined = services.acceptPost(id, res.locals.user.id);
      const message = joined && joined.group
        ? '已錄取。完成後請到你的那一筆填寫估價。'
        : '已接下。互助完成後，雙方各自填寫這次值多少。';
      redirectWith(req, res, back, { type: 'ok', message });
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.post('/posts/:id/extend', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const back = req.body && req.body.return === '/me' ? '/me' : (id ? `/posts/${id}` : '/me');
    if (!id) {
      res.redirect('/me');
      return;
    }
    try {
      const result = services.extendPost(id, res.locals.user.id, req.body.days);
      redirectWith(req, res, back, { type: 'ok', message: `已延長 ${result.days} 天。` });
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.post('/posts/:id/repost', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const back = `/posts/${req.params.id}`;
    if (!id) {
      res.redirect('/me');
      return;
    }
    try {
      const post = services.repostPost(id, res.locals.user.id);
      redirectWith(req, res, `/posts/${post.id}`, { type: 'ok', message: '已重發。原來那則已取消。' });
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.post('/posts/:id/slots/:slotId/remove', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const slotId = parseId(req.params.slotId);
    const back = id ? `/posts/${id}` : '/me';
    if (!id || !slotId) {
      res.redirect(back);
      return;
    }
    try {
      services.removeSlot(id, slotId, res.locals.user.id);
      redirectWith(req, res, back, { type: 'ok', message: '已移出。這個名額重新開放，沒用到的預留已退回。' });
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
      if (result.status === 'settled') {
        redirectWith(req, res, `${back}#rate`, { type: 'ok', message: '結算完成，給對方星等吧。' });
        return;
      }
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

  app.post('/posts/:id/bookmark', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const back = safeReturn(req.body.return) || (id ? `/posts/${id}` : '/');
    if (!id) {
      res.redirect('/');
      return;
    }
    try {
      services.toggleBookmark(res.locals.user.id, id);
      res.redirect(back);
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.post('/posts/:id/rating', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const back = `/posts/${req.params.id}`;
    try {
      services.rate(id, res.locals.user.id, req.body.stars, req.body.comment, req.body.tags);
    } catch (err) {
      handle(err, req, res, back);
      return;
    }
    const thanks = String(req.body.thanks || '').trim();
    if (!thanks) {
      redirectWith(req, res, back, { type: 'ok', message: '已送出星等。星等會出現在對方的個人頁，備註不會顯示。' });
      return;
    }
    try {
      services.saveThanks(id, res.locals.user.id, thanks);
      redirectWith(req, res, back, { type: 'ok', message: '已送出星等和感謝。感謝會出現在對方的個人頁。' });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      redirectWith(req, res, back, {
        type: 'err',
        message: `已送出星等。感謝留言沒有留下。${err.message}`,
      });
    }
  });

  app.post('/posts/:id/thanks', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const back = `/posts/${req.params.id}`;
    try {
      const saved = services.saveThanks(id, res.locals.user.id, req.body.body);
      redirectWith(req, res, back, {
        type: 'ok',
        message: saved.updated ? '已更新感謝。' : '已留下感謝。',
      });
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.post('/posts/:id/thanks/delete', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const back = `/posts/${req.params.id}`;
    try {
      services.removeOwnThanks(id, res.locals.user.id);
      redirectWith(req, res, back, { type: 'ok', message: '已刪除感謝。' });
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.post('/thanks/:id/hide', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const back = safeReturn(req.body.return) || '/me';
    try {
      services.hideThanks(res.locals.user.id, id);
      redirectWith(req, res, back, { type: 'ok', message: '這則感謝已不公開。' });
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  function renderHideConfirm(req, res, person) {
    res.render('hide-confirm', { title: '不想再遇到', person });
  }

  app.get('/users/:id/hide', requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const profile = id ? services.getProfile(id) : null;
    const back = `/users/${req.params.id}`;
    if (!profile) {
      res.status(404).render('error', { title: '找不到', message: '找不到這位使用者。' });
      return;
    }
    try {
      const check = services.assertCanHide(res.locals.user.id, id);
      if (check.already) {
        redirectWith(req, res, '/me', { type: 'ok', message: '這個人已經在你的清單裡。' });
        return;
      }
    } catch (err) {
      handle(err, req, res, back);
      return;
    }
    renderHideConfirm(req, res, profile.user);
  });

  app.post('/users/:id/hide', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    const back = `/users/${req.params.id}`;
    if (!id) {
      res.redirect('/me');
      return;
    }
    const profile = services.getProfile(id);
    if (!profile) {
      res.status(404).render('error', { title: '找不到', message: '找不到這位使用者。' });
      return;
    }
    if (req.body.confirm !== '1') {
      try {
        const check = services.assertCanHide(res.locals.user.id, id);
        if (check.already) {
          redirectWith(req, res, '/me', { type: 'ok', message: '這個人已經在你的清單裡。' });
          return;
        }
      } catch (err) {
        handle(err, req, res, back);
        return;
      }
      renderHideConfirm(req, res, profile.user);
      return;
    }
    try {
      services.hideUser(res.locals.user.id, id);
      redirectWith(req, res, '/me', {
        type: 'ok',
        message: '已列入不想再遇到。對方不會收到通知。進行中的互助不會取消。',
      });
    } catch (err) {
      handle(err, req, res, back);
    }
  });

  app.post('/users/:id/unhide', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      res.redirect('/me');
      return;
    }
    try {
      services.unhideUser(res.locals.user.id, id);
      redirectWith(req, res, '/me', { type: 'ok', message: '已從不想再遇到的清單移除。' });
    } catch (err) {
      handle(err, req, res, '/me');
    }
  });

  app.get('/users/:id/report', requireLogin, (req, res) => {
    renderReport(req, res, 'user');
  });

  app.post('/users/:id/report', requireLogin, requireCsrf, (req, res) => {
    submitReport(req, res, 'user');
  });

  app.get('/users/:id/merit', requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    if (!id || id !== res.locals.user.id) {
      res.status(403).render('error', { title: '沒有權限', message: '只能看自己的功德明細。' });
      return;
    }
    const history = services.meritHistory(res.locals.user.id, {
      month: req.query.month,
      before: parseId(req.query.before),
    });
    res.render('merit', { title: '我的功德明細', history });
  });

  app.get('/users/:id', (req, res) => {
    const id = parseId(req.params.id);
    const profile = id
      ? services.getProfile(id, res.locals.user && res.locals.user.id, { all: req.query.thanks === 'all' })
      : null;
    if (!profile) {
      res.status(404).render('error', { title: '找不到', message: '找不到這位使用者。' });
      return;
    }
    const own = res.locals.user && res.locals.user.id === profile.user.id ? res.locals.user : null;
    const canHide = res.locals.user
      ? services.hideRelation(res.locals.user.id, profile.user.id).canHide
      : false;
    res.render('profile', { title: profile.user.display_name, profile, own, canHide });
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

  function renderAdmin(req, res, extra = {}) {
    const queryMobile = extra.queryMobile || String(req.query.mobile || '');
    res.render('admin', {
      title: '管理',
      data: services.adminSnapshot(res.locals.user.id, queryMobile.trim()),
      queryMobile,
      temporaryPassword: extra.temporaryPassword || null,
      resetName: extra.resetName || '',
    });
  }

  app.get('/admin', requireFounder, (req, res) => {
    renderAdmin(req, res);
  });

  app.post('/admin/reports/:id/resolve', requireCsrf, requireFounder, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      res.redirect('/admin');
      return;
    }
    try {
      services.handleReport(res.locals.user.id, id, 'resolved');
      redirectWith(req, res, '/admin', { type: 'ok', message: '已標成處理完。貼文和帳號都沒有自動變動。' });
    } catch (err) {
      handle(err, req, res, '/admin');
    }
  });

  app.post('/admin/reports/:id/dismiss', requireCsrf, requireFounder, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      res.redirect('/admin');
      return;
    }
    try {
      services.handleReport(res.locals.user.id, id, 'dismissed');
      redirectWith(req, res, '/admin', { type: 'ok', message: '已駁回這則檢舉。' });
    } catch (err) {
      handle(err, req, res, '/admin');
    }
  });

  app.post('/admin/announcements', requireCsrf, requireFounder, (req, res) => {
    try {
      services.createAnnouncement(res.locals.user.id, req.body);
      redirectWith(req, res, '/admin', { type: 'ok', message: '已發布公告。廣場只顯示最新一則。' });
    } catch (err) {
      handle(err, req, res, '/admin');
    }
  });

  app.post('/admin/announcements/:id/remove', requireCsrf, requireFounder, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      res.redirect('/admin');
      return;
    }
    try {
      services.removeAnnouncement(res.locals.user.id, id);
      redirectWith(req, res, '/admin', { type: 'ok', message: '已撤下公告。' });
    } catch (err) {
      handle(err, req, res, '/admin');
    }
  });

  app.post('/admin/announcements/:id', requireCsrf, requireFounder, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      res.redirect('/admin');
      return;
    }
    try {
      services.updateAnnouncement(res.locals.user.id, id, req.body);
      redirectWith(req, res, '/admin', { type: 'ok', message: '已更新公告。' });
    } catch (err) {
      handle(err, req, res, '/admin');
    }
  });

  app.post('/announcements/:id/dismiss', requireCsrf, requireLogin, (req, res) => {
    const id = parseId(req.params.id);
    if (!id) {
      res.redirect('/');
      return;
    }
    try {
      services.dismissAnnouncement(res.locals.user.id, id);
      redirectWith(req, res, '/', { type: 'ok', message: '已知道這則公告。' });
    } catch (err) {
      handle(err, req, res, '/');
    }
  });

  app.post('/admin/password', requireCsrf, requireFounder, (req, res) => {
    try {
      const result = services.resetPasswordByFounder(res.locals.user.id, req.body.mobile);
      renderAdmin(req, res, {
        queryMobile: result.user.mobile,
        temporaryPassword: result.temporary,
        resetName: result.user.display_name,
      });
    } catch (err) {
      handle(err, req, res, '/admin');
    }
  });

  app.post('/admin/name', requireCsrf, requireFounder, (req, res) => {
    try {
      const user = services.renameUser(res.locals.user.id, req.body.mobile, req.body.display_name);
      redirectWith(req, res, '/admin', { type: 'ok', message: `已把名稱改成「${user.display_name}」。` });
    } catch (err) {
      handle(err, req, res, '/admin');
    }
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

  app.post('/admin/thanks/:id/delete', requireCsrf, requireFounder, (req, res) => {
    const id = parseId(req.params.id);
    try {
      services.deleteThanks(res.locals.user.id, id);
      redirectWith(req, res, '/admin', { type: 'ok', message: '已刪除這則感謝。' });
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
