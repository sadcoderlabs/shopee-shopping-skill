import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { Store, Workflow, urlOf, retryTime } from '../scripts/workflow.mjs';
import { makeScript } from '../scripts/browser-script.mjs';

const item = 'https://shopee.tw/product/123/456';
const session = 'host:existing-tab:1';
const intent = { url: item, title: '滑鼠', variants: ['黑色'], quantity: 1, authorized: true };
const stopped = code => e => { assert.equal(e.code, code); return true; };
async function fixture(t, mode = 'readonly') {
  const dir = await mkdtemp(join(tmpdir(), 'shopee-skill-')); const store = await new Store(dir).open();
  let now = 1_000_000;
  const flow = new Workflow(store, {}, () => now);
  await flow.bind(session, mode, true);
  const login = await flow.plan('login');
  await flow.record(login.id, { session, url: 'https://shopee.tw/', outcome: 'ok' });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  return { flow, store, dir, tick: (ms = 15000) => { now += ms; } };
}

test('綁定必須有原分頁與接手能力，不能重綁另一分頁', async t => {
  const { flow } = await fixture(t);
  await assert.rejects(flow.bind('other', 'readonly', true), stopped('ALREADY_BOUND'));
  const empty = new Workflow({ state: { actions: {} }, save: async () => {} });
  await assert.rejects(empty.bind('', 'readonly', true), stopped('CAPABILITY_REQUIRED'));
  await assert.rejects(empty.bind(session, 'readonly', false), stopped('CAPABILITY_REQUIRED'));
});

test('未確認登入前不能搜尋', async () => {
  const flow = new Workflow({ state: { session, mode: 'none', actions: {} }, save: async () => {} });
  await assert.rejects(flow.plan('search', { query: '滑鼠' }), stopped('LOGIN_REQUIRED'));
});

test('readonly 模式只對讀取產生腳本，寫入走宿主工具', async t => {
  const { flow, tick } = await fixture(t);
  const read = await flow.plan('product'); assert.equal(read.action.type, 'browser_script'); assert.equal(read.action.access, 'readonly');
  await flow.record(read.id, { session, url: item, outcome: 'ok' });
  tick(); const select = await flow.plan('select', { ...intent });
  assert.equal(select.action.type, 'native_browser'); assert.equal(select.action.operation, 'select');
});

test('沒有腳本介面的宿主仍用原生觀察，沒有啟動新瀏覽器', async t => {
  const { flow } = await fixture(t, 'none');
  const plan = await flow.plan('product');
  assert.equal(plan.action.type, 'native_browser'); assert.equal(plan.session, session);
});

test('操作未回報不可再次規劃；分頁與操作識別須相符', async t => {
  const { flow } = await fixture(t);
  const plan = await flow.plan('search', { query: '滑鼠' });
  await assert.rejects(flow.plan('search', { query: '滑鼠' }), stopped('PENDING'));
  await assert.rejects(flow.record('old-id', { session, url: 'https://shopee.tw/', outcome: 'navigated' }), stopped('STALE_RESULT'));
  await assert.rejects(flow.record(plan.id, { session: 'other-tab', url: 'https://shopee.tw/search?keyword=滑鼠', outcome: 'navigated' }), stopped('SESSION_MISMATCH'));
  await assert.rejects(flow.record(plan.id, { session, url: 'https://shopee.tw/search?keyword=鍵盤', outcome: 'navigated' }), stopped('PAGE_MISMATCH'));
  assert.equal(flow.state.pending.id, plan.id);
});

test('搜尋降速與次數上限跨 Workflow 保留', async t => {
  const { flow, store, tick } = await fixture(t);
  const first = await flow.plan('search', { query: '滑鼠' });
  await flow.record(first.id, { session, url: 'https://shopee.tw/search?keyword=滑鼠', outcome: 'navigated' });
  await assert.rejects(flow.plan('search', { query: '鍵盤' }), stopped('WAIT'));
  tick();
  const next = new Workflow(store, {}, flow.now);
  store.state.searchCount = 10;
  assert.equal((await next.plan('search', { query: '鍵盤' })).code, 'SEARCH_LIMIT');
  await assert.rejects(next.plan('product'), stopped('HUMAN_REQUIRED'));
});

test('驗證交接必須等使用者明確回覆及原分頁確認', async t => {
  const { flow } = await fixture(t);
  const plan = await flow.plan('product');
  assert.equal((await flow.record(plan.id, { session, url: item, outcome: 'verification' })).status, 'human_required');
  await assert.rejects(flow.resume(session, false), stopped('HUMAN_CONFIRMATION_REQUIRED'));
  await assert.rejects(flow.resume('other', true), stopped('HUMAN_CONFIRMATION_REQUIRED'));
  assert.equal((await flow.resume(session, true)).status, 'resumed');
});

test('429 冷卻會落盤，時間未到不能恢復', async t => {
  const { flow, dir, tick } = await fixture(t);
  const plan = await flow.plan('product');
  await flow.record(plan.id, { session, url: item, outcome: 'blocked', httpStatus: 429, retryAfter: '120' });
  const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  assert.equal(saved.blockedUntil, 1_120_000);
  await assert.rejects(flow.resume(session, true), stopped('COOLDOWN'));
  tick(120_000); await flow.resume(session, true);
});

test('加入先記錄意圖，成功後相同意圖不得重送', async t => {
  const { flow, tick, dir } = await fixture(t);
  const add = await flow.plan('add', { ...intent });
  assert.ok(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).cartUncertain);
  await flow.record(add.id, { session, url: item, outcome: 'submitted' });
  await assert.rejects(flow.plan('cart'), stopped('CART_UNCERTAIN'));
  const verify = await flow.plan('verify-add'); // 唯讀觀察不受互動間隔限制。
  await flow.record(verify.id, { session, url: item, outcome: 'added' });
  tick(); await assert.rejects(flow.plan('add', { ...intent }), stopped('DUPLICATE'));
});

test('加入結果不明不得重送，須人工核對', async t => {
  const { flow } = await fixture(t);
  const add = await flow.plan('add', { ...intent });
  await flow.record(add.id, { session, url: item, outcome: 'submitted' });
  const verify = await flow.plan('verify-add');
  await flow.record(verify.id, { session, url: item, outcome: 'uncertain' });
  await assert.rejects(flow.resume(session, true), stopped('RESOLUTION_REQUIRED'));
  await flow.resume(session, true, 'applied');
  assert.equal(Object.values(flow.state.actions)[0], 'confirmed-by-user');
});

test('程序中斷後先交接，再由使用者確認完全未加入才可解除', async t => {
  const { flow, tick } = await fixture(t);
  await flow.plan('add', { ...intent });
  await assert.rejects(flow.resume(session, true, 'not-applied'), stopped('PENDING'));
  await flow.handoff('INTERRUPTED', '原操作結果不明');
  await flow.resume(session, true, 'not-applied');
  tick(); assert.equal((await flow.plan('add', { ...intent })).status, 'planned');
});

test('寫入須授權，結帳入口執行後一律交接，沒有送單步驟', async t => {
  const { flow } = await fixture(t);
  await assert.rejects(flow.plan('add', { ...intent, authorized: false }), stopped('AUTHORIZATION_REQUIRED'));
  await assert.rejects(flow.plan('submit-order'), stopped('INVALID_STEP'));
  const checkout = await flow.plan('checkout', { authorized: true });
  const result = await flow.record(checkout.id, { session, url: 'https://shopee.tw/checkout', outcome: 'before_order' });
  assert.equal(result.code, 'BEFORE_ORDER');
  await assert.rejects(flow.plan('product'), stopped('HUMAN_REQUIRED'));
});

test('同一目錄排他鎖，損壞狀態不會被覆寫', async t => {
  const { store, dir } = await fixture(t);
  await assert.rejects(new Store(dir).open(), stopped('BUSY'));
  await store.close(); await writeFile(join(dir, 'state.json'), '{broken');
  await assert.rejects(new Store(dir).open(), SyntaxError);
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), '{broken');
});

test('網址白名單及 Retry-After', () => {
  for (const raw of [undefined, '/cart', 'https://evil.example', 'https://shopee.tw.evil.example/', 'https://x:secret@shopee.tw/']) assert.throws(() => urlOf(raw), stopped('INVALID_URL'));
  assert.throws(() => urlOf('https://shopee.tw/cart', true), stopped('INVALID_PRODUCT'));
  assert.equal(retryTime('120', 1000), 121000);
  assert.equal(retryTime(null, 1000), 61000);
  assert.equal(retryTime('Thu, 15 Oct 2026 05:00:00 GMT', 1000), Date.parse('2026-10-15T05:00:00Z'));
});

function domFixture({ authenticated = true, challenge = false, pathname = '/product/123/456' } = {}) {
  let clicks = 0;
  const element = label => ({ innerText: label, getClientRects: () => [1], getAttribute: () => null, click: () => { clicks++; } });
  const account = element('我的帳戶'); const title = element('滑鼠'); const qty = { ...element(''), value: '1' };
  const black = element('黑色'); const add = element('加入購物車'); const checkout = element('去買單');
  const selectors = { account: '#account', productTitle: '#title', quantity: '#qty', selectedVariants: '#selected', variantOptions: '#variants', add: '#add', added: '#added', checkout: '#checkout' };
  const map = { '#account': authenticated ? [account] : [], '#title': [title], '#qty': [qty], '#selected': [black], '#variants': [black], '#add': [add], '#added': [], '#checkout': [checkout],
    'h1,h2,p,[role="alert"]': challenge ? [element('請完成驗證')] : [] };
  const location = new URL(`https://shopee.tw${pathname}`);
  const context = { document: { querySelectorAll: selector => map[selector] ?? [] }, location, URL };
  return { context, selectors, map, add, checkout, clicks: () => clicks };
}

test('頁面腳本：未登入或驗證時無操作', () => {
  for (const options of [{ authenticated: false }, { challenge: true }]) {
    const f = domFixture(options);
    const result = runInNewContext(makeScript('add', intent, f.selectors), f.context);
    assert.equal(result.outcome, options.challenge ? 'verification' : 'needs_login'); assert.equal(f.clicks(), 0);
  }
});

test('頁面腳本：加入核對網址、規格、數量與按鈕，成功只點一次', () => {
  const f = domFixture();
  assert.equal(runInNewContext(makeScript('add', intent, f.selectors), f.context).outcome, 'submitted'); assert.equal(f.clicks(), 1);
  const wrong = domFixture({ pathname: '/product/999/456' });
  assert.equal(runInNewContext(makeScript('add', intent, wrong.selectors), wrong.context).outcome, 'page_changed'); assert.equal(wrong.clicks(), 0);
  f.map['#qty'][0].value = '2';
  assert.equal(runInNewContext(makeScript('add', intent, f.selectors), f.context).outcome, 'page_changed'); assert.equal(f.clicks(), 1);
});

test('頁面腳本：結帳只能在購物車，不會誤點最後下單按鈕', () => {
  const f = domFixture({ pathname: '/cart' });
  assert.equal(runInNewContext(makeScript('checkout', {}, f.selectors), f.context).outcome, 'before_order'); assert.equal(f.clicks(), 1);
  f.checkout.innerText = '下訂單';
  assert.equal(runInNewContext(makeScript('checkout', {}, f.selectors), f.context).outcome, 'page_changed'); assert.equal(f.clicks(), 1);
  const final = domFixture({ pathname: '/checkout' });
  assert.equal(runInNewContext(makeScript('checkout', {}, final.selectors), final.context).outcome, 'page_changed'); assert.equal(final.clicks(), 0);
});

test('接受蝦皮實際使用的商品短橫線與數字網址', () => {
  assert.equal(urlOf('https://shopee.tw/Steam-Controller-i.158021068.53465028544?extraParams=test', true), 'https://shopee.tw/Steam-Controller-i.158021068.53465028544');
});

test('結果腳本能讀取一般商品連結並去除追蹤與重複', () => {
  const f = domFixture({ pathname: '/search' });
  f.selectors.results = '#results';
  const link = (href, label) => ({ href, innerText: label, getClientRects: () => [1] });
  f.map['#results'] = [link('https://shopee.tw/Steam-Controller-i.123.456?tracking=1', 'Steam Controller\n$\n5,500'), link('https://shopee.tw/Steam-Controller-i.123.456?tracking=2', '重複'), link('https://evil.example/Steam-Controller-i.123.456', '站外')];
  const result = runInNewContext(makeScript('results', { limit: 30 }, f.selectors), f.context);
  assert.equal(result.outcome, 'ok'); assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, 'https://shopee.tw/Steam-Controller-i.123.456');
});

test('結果腳本保留 display contents 的可見子元素，排除真正隱藏商品', () => {
  const f = domFixture({ pathname: '/search' });
  f.selectors.results = '#results';
  const link = (id, childVisible) => ({ href: `https://shopee.tw/Steam-Controller-i.123.${id}`, innerText: 'Steam Controller\n$\n6,000', getClientRects: () => [], querySelectorAll: () => [{ getClientRects: () => childVisible ? [1] : [] }] });
  f.map['#results'] = [link(456, true), link(789, false)];
  const result = runInNewContext(makeScript('results', { limit: 30 }, f.selectors), f.context);
  assert.equal(result.outcome, 'ok'); assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, 'https://shopee.tw/Steam-Controller-i.123.456');
});

test('CLI 可綁定與規劃，不需要瀏覽器套件', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shopee-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = args => spawnSync(process.execPath, ['scripts/shop.mjs', ...args, '--state-dir', dir], { encoding: 'utf8' });
  const bind = cli(['bind', '--session', session, '--script-mode', 'readonly', '--takeover-ready']);
  assert.equal(bind.status, 0, bind.stdout);
  const plan = cli(['plan', 'login']); assert.equal(plan.status, 0, plan.stdout);
  assert.equal(JSON.parse(plan.stdout).action.access, 'readonly');
  const blocked = cli(['plan', 'login']); assert.equal(blocked.status, 2); assert.equal(JSON.parse(blocked.stdout).code, 'PENDING');
});
