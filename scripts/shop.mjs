import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Store, Workflow, Stop } from './workflow.mjs';

process.umask(0o077);
let store; let code = 0;
try {
  const { values: v, positionals: p } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, session: { type: 'string' }, 'script-mode': { type: 'string' },
    'takeover-ready': { type: 'boolean' }, authorized: { type: 'boolean' }, 'human-confirmed': { type: 'boolean' }, 'new-round': { type: 'boolean' },
    query: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' }, variant: { type: 'string', multiple: true }, quantity: { type: 'string' }, limit: { type: 'string' },
    id: { type: 'string' }, 'result-file': { type: 'string' }, resolution: { type: 'string' }, reason: { type: 'string' },
    config: { type: 'string', default: 'config.local.json' }, 'state-dir': { type: 'string', default: '.local' },
  } });
  if (!p.length || v.help) {
    console.log(`蝦皮購物技能：使用宿主既有瀏覽器，不安裝或啟動瀏覽器。
bind --session 原分頁識別 --script-mode readwrite|readonly|none --takeover-ready
plan login|search|results|open|product|select|add|verify-add|cart|cart-read|checkout
     [--query 關鍵字] [--url 商品網址] [--title 完整標題] [--variant 規格] [--quantity 1] [--limit 10] [--authorized]
record --id 操作識別 --result-file .local/result.json
handoff --reason 原因
resume --session 原分頁識別 --human-confirmed [--resolution applied|not-applied] [--new-round]
status
共用：--config config.local.json --state-dir .local
選規格與加入購物車不需要 --authorized；此參數僅供實驗性的結帳入口使用。
plan 只產生操作內容，由宿主瀏覽器工具執行。沒有最後下單命令。`);
  } else {
    if (!['bind', 'plan', 'record', 'handoff', 'resume', 'status'].includes(p[0]) || p.length !== (p[0] === 'plan' ? 2 : 1)) throw new Stop('INVALID_COMMAND', '命令無效，請使用 --help。');
    let config = {}; try { config = JSON.parse(await readFile(resolve(v.config), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    store = await new Store(resolve(v['state-dir'])).open(); const flow = new Workflow(store, config.selectors);
    let result;
    switch (p[0]) {
      case 'bind': result = await flow.bind(v.session, v['script-mode'], v['takeover-ready']); break;
      case 'plan': result = await flow.plan(p[1], { query: v.query, url: v.url, title: v.title, variants: v.variant ?? [], quantity: Number(v.quantity ?? 1), limit: Number(v.limit ?? 10), authorized: v.authorized ?? false }); break;
      case 'record':
        if (!v['result-file']) throw new Stop('RESULT_REQUIRED', '請提供實際瀏覽器觀察結果檔案。');
        result = await flow.record(v.id, JSON.parse(await readFile(resolve(v['result-file']), 'utf8'))); break;
      case 'handoff': result = await flow.handoff('HUMAN_REQUIRED', v.reason ?? '操作結果不明，請使用者接手原分頁。'); break;
      case 'resume': result = await flow.resume(v.session, v['human-confirmed'], v.resolution, v['new-round']); break;
      case 'status': result = { status: 'state', ...store.state }; break;
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'human_required') code = 2;
  }
} catch (e) {
  code = e instanceof Stop ? 2 : 1;
  console.log(JSON.stringify({ status: 'stopped', code: e instanceof Stop ? e.code : 'UNEXPECTED_ERROR', message: e instanceof Stop ? e.message : '資料或環境錯誤，請人工檢查；勿重送原操作。', ...(e.details ?? {}) }, null, 2));
} finally { await store?.close(); }
process.exitCode = code;
