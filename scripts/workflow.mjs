import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { makeScript } from './browser-script.mjs';

export class Stop extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
export function urlOf(raw, product = false) {
  let url; try { url = new URL(raw); } catch { throw new Stop('INVALID_URL', '請提供蝦皮臺灣站完整網址。'); }
  if (url.origin !== 'https://shopee.tw' || url.username || url.password) throw new Stop('INVALID_URL', '只接受蝦皮臺灣站網址。');
  if (product && !/-i\.\d+\.\d+$/.test(url.pathname) && !/^\/product\/\d+\/\d+\/?$/.test(url.pathname)) throw new Stop('INVALID_PRODUCT', '請提供商品頁網址。');
  url.search = ''; url.hash = ''; return url.href;
}
export function retryTime(value, now) {
  const seconds = value == null ? NaN : Number(value);
  return Number.isFinite(seconds) ? now + Math.max(60_000, seconds * 1000) : Math.max(now + 60_000, Date.parse(value) || 0);
}
export class Store {
  constructor(dir) { this.dir = dir; this.state = { version: 1, actions: {}, searchCount: 0 }; }
  async open() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try { await mkdir(join(this.dir, 'lock'), { mode: 0o700 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; throw new Stop('BUSY', '同一工作目錄已有程序執行。'); }
    this.locked = true;
    try { this.state = JSON.parse(await readFile(join(this.dir, 'state.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') { await this.close(); throw e; } }
    if (this.state.version !== 1 || !this.state.actions || typeof this.state.actions !== 'object') { await this.close(); throw new Stop('INVALID_STATE', '工作階段資料格式錯誤。'); }
    return this;
  }
  async save() { await writeFile(join(this.dir, 'state.tmp'), JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 }); await rename(join(this.dir, 'state.tmp'), join(this.dir, 'state.json')); }
  async close() { if (this.locked) await rm(join(this.dir, 'lock'), { recursive: true }); this.locked = false; }
}
const writes = ['select', 'add', 'checkout'];
const steps = ['login', 'search', 'results', 'open', 'product', 'select', 'add', 'verify-add', 'cart', 'cart-read', 'checkout'];
export class Workflow {
  constructor(store, selectors = {}, now = Date.now) { this.store = store; this.state = store.state; this.selectors = selectors; this.now = now; }
  async bind(session, mode, takeover) {
    if (!session?.trim() || !['readwrite', 'readonly', 'none'].includes(mode) || !takeover) throw new Stop('CAPABILITY_REQUIRED', '須提供既有分頁識別、腳本能力，並確認使用者能接手同一瀏覽器。');
    if (this.state.session) throw new Stop('ALREADY_BOUND', '此工作階段已綁定分頁，請勿更換。');
    this.state.session = session; this.state.mode = mode; await this.store.save();
    return { status: 'bound', session, mode, note: '只記錄宿主觀察到的能力，不會建立或連接瀏覽器。' };
  }
  async handoff(code, message) { this.state.handoff = { code, message }; await this.store.save(); return { status: 'human_required', code, message, session: this.state.session }; }
  async plan(step, args = {}) {
    if (!steps.includes(step)) throw new Stop('INVALID_STEP', '未知步驟。');
    if (!this.state.session) throw new Stop('SESSION_REQUIRED', '請先綁定宿主目前的瀏覽器分頁。');
    if (this.state.handoff) throw new Stop('HUMAN_REQUIRED', this.state.handoff.message);
    if (this.state.pending) throw new Stop('PENDING', '前次操作尚未回報，請觀察原分頁或交接，勿再次送出。');
    if (step !== 'login' && !this.state.authenticated) throw new Stop('LOGIN_REQUIRED', '請先在原分頁執行登入檢查，完成後再繼續。');
    if (this.state.cartUncertain && step !== 'verify-add') throw new Stop('CART_UNCERTAIN', '加入結果未確認，只能觀察成功提示或交接人工核對。');
    if (step === 'verify-add' && !this.state.cartUncertain) throw new Stop('NO_ADD_PENDING', '目前沒有待確認的加入操作。');
    const now = this.now();
    const traffic = [...writes, 'search', 'open', 'cart'].includes(step);
    const until = Math.max(this.state.blockedUntil ?? 0, traffic ? (this.state.lastAction ?? 0) + 5000 : 0, step === 'search' ? (this.state.lastSearch ?? 0) + 15000 : 0);
    if (until > now) throw new Stop('WAIT', '尚未到下一次操作時間；等待後重新規劃，勿對網站重試。', { until });
    if (step === 'search') {
      if (!args.query?.trim() || args.query.length > 200) throw new Stop('INVALID_QUERY', '搜尋文字須為 1 至 200 字。');
      if (this.state.searchCount >= 10) return this.handoff('SEARCH_LIMIT', '本輪已搜尋 10 次，請使用者確認是否開始新一輪。');
    }
    if (step === 'results') { args.limit ??= 10; if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 30) throw new Stop('INVALID_LIMIT', '最多讀取 1 至 30 件商品。'); }
    if (step === 'open') args.url = urlOf(args.url, true);
    if (writes.includes(step) && !args.authorized) throw new Stop('AUTHORIZATION_REQUIRED', '須先取得使用者對指定操作的授權。');
    if (['select', 'add'].includes(step)) {
      args.url = urlOf(args.url, true); args.variants ??= []; args.quantity ??= 1;
      if (!args.title?.trim() || !Array.isArray(args.variants) || args.variants.some(v => typeof v !== 'string' || !v.trim()) || !Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 99) throw new Stop('INVALID_PRODUCT', '請提供完整標題、規格與 1 至 99 的數量。');
    }
    if (step === 'add') {
      args.key = createHash('sha256').update(JSON.stringify([args.url, args.title, [...args.variants].sort(), args.quantity])).digest('hex');
      if (this.state.actions[args.key]) throw new Stop('DUPLICATE', '此加入意圖已送出或結果未明，不得重送。');
    }
    let action;
    if (['search', 'open', 'cart'].includes(step)) {
      const url = step === 'search' ? `https://shopee.tw/search?keyword=${encodeURIComponent(args.query)}` : step === 'cart' ? 'https://shopee.tw/cart' : args.url;
      action = { type: 'native_browser', operation: 'navigate', url };
    } else if (this.state.mode === 'none' || (writes.includes(step) && this.state.mode !== 'readwrite')) {
      action = { type: 'native_browser', operation: step, parameters: args, note: '先觀察原分頁，再使用宿主正式操作工具；不要執行未允許的腳本。' };
    } else {
      action = { type: 'browser_script', script: makeScript(step, args, this.selectors), access: writes.includes(step) ? 'readwrite' : 'readonly' };
    }
    const id = randomUUID();
    this.state.pending = { id, step, args }; if (traffic) this.state.lastAction = now;
    if (step === 'search') { this.state.searchCount++; this.state.lastSearch = now; }
    if (step === 'add') { this.state.actions[args.key] = 'issued'; this.state.cartUncertain = args.key; }
    await this.store.save();
    return { status: 'planned', id, step, session: this.state.session, action,
      next: '在綁定的原分頁執行一次，再用 record 回報實際觀察；若失敗，不重送，改用 handoff。' };
  }
  async record(id, result) {
    const pending = this.state.pending;
    if (!pending || pending.id !== id) throw new Stop('STALE_RESULT', '操作識別不符，不能套用此結果。');
    if (result.session !== this.state.session) throw new Stop('SESSION_MISMATCH', '結果不是來自原分頁，保留待處理狀態。');
    urlOf(result.url);
    const outcomes = {
      login: ['ok', 'needs_login'], search: ['navigated'], open: ['navigated'], cart: ['navigated'],
      results: ['ok'], product: ['ok'], select: ['submitted'], add: ['submitted'], 'verify-add': ['added', 'uncertain'],
      'cart-read': ['ok'], checkout: ['before_order'],
    };
    if (![...outcomes[pending.step], 'verification', 'page_changed', 'needs_login', 'blocked'].includes(result.outcome)) throw new Stop('INVALID_RESULT', '觀察結果不符合目前步驟。');
    const path = new URL(result.url).pathname;
    if (result.outcome === 'navigated') {
      const expected = pending.step === 'search' ? '/search' : pending.step === 'cart' ? '/cart' : new URL(pending.args.url).pathname;
      if (path !== expected) throw new Stop('PAGE_MISMATCH', '導航後不是預期頁面，請人工檢查。');
      if (pending.step === 'search' && new URL(result.url).searchParams.get('keyword') !== pending.args.query) throw new Stop('PAGE_MISMATCH', '搜尋文字與實際頁面不同。');
    }
    delete this.state.pending;
    if (result.outcome === 'blocked' || [403, 429, 503].includes(result.httpStatus)) {
      this.state.blockedUntil = retryTime(result.retryAfter, this.now());
      return this.handoff('BLOCKED', '網站阻擋，停止自動操作；冷卻後仍須使用者處理並明確恢復。');
    }
    if (result.outcome === 'needs_login') this.state.authenticated = false;
    if (['verification', 'needs_login', 'page_changed', 'uncertain'].includes(result.outcome)) return this.handoff(result.outcome.toUpperCase(), '請使用者在原分頁處理；完成後告知再恢復。');
    if (pending.step === 'login' && result.outcome === 'ok') this.state.authenticated = true;
    if (pending.step === 'verify-add' && result.outcome === 'added') { this.state.actions[this.state.cartUncertain] = 'observed-success'; delete this.state.cartUncertain; }
    if (pending.step === 'checkout') return this.handoff('BEFORE_ORDER', '已執行結帳入口，請先觀察是否抵達結帳頁，再讓使用者接手核對商品、規格、數量、總額、運費、收件與付款方式，最後親自確認下單。');
    await this.store.save();
    return { status: 'recorded', step: pending.step, outcome: result.outcome, next: pending.step === 'add' ? 'verify-add；只觀察，不再次加入。' : '依原分頁實際狀態繼續。' };
  }
  async resume(session, humanConfirmed, resolution, newRound = false) {
    if (!humanConfirmed || session !== this.state.session) throw new Stop('HUMAN_CONFIRMATION_REQUIRED', '須等使用者明確回覆，並確認仍是原分頁。');
    if ((this.state.blockedUntil ?? 0) > this.now()) throw new Stop('COOLDOWN', '網站冷卻時間尚未結束。', { until: this.state.blockedUntil });
    if (this.state.pending && !this.state.handoff) throw new Stop('PENDING', '先回報原步驟結果或以 handoff 交接，再恢復。');
    if (this.state.cartUncertain) {
      if (!['applied', 'not-applied'].includes(resolution)) throw new Stop('RESOLUTION_REQUIRED', '須請使用者檢查購物車，回覆是否已加入。');
      if (resolution === 'applied') this.state.actions[this.state.cartUncertain] = 'confirmed-by-user';
      else delete this.state.actions[this.state.cartUncertain];
      delete this.state.cartUncertain;
    }
    delete this.state.pending; delete this.state.handoff; delete this.state.blockedUntil;
    if (newRound) this.state.searchCount = 0;
    await this.store.save(); return { status: 'resumed', next: '先重新觀察原分頁，不會自動重送操作。' };
  }
}
