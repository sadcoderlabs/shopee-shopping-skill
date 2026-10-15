// 此函式只在宿主提供的既有瀏覽器工具內執行，不會啟動或連接瀏覽器。
function browserStep({ step, args, selectors }) {
  const url = location.href;
  const answer = (outcome, extra = {}) => ({ outcome, url, ...extra });
  // display: contents 的連結本身沒有版面方塊，商品內容仍可能可見。
  const visible = el => Boolean(el && (el.getClientRects().length || [...el.querySelectorAll('*')].some(child => child.getClientRects().length)));
  const all = key => selectors[key] ? [...document.querySelectorAll(selectors[key])].filter(visible) : [];
  const one = key => { const els = all(key); return els.length === 1 ? els[0] : null; };
  const text = el => (el?.innerText ?? el?.textContent ?? '').trim();
  if (location.origin !== 'https://shopee.tw') return answer('page_changed', { reason: '目前不是蝦皮臺灣站。' });
  const challenges = document.querySelectorAll('iframe[src*="captcha" i], iframe[src*="challenge" i], input[autocomplete="one-time-code"]');
  const blockedText = [...document.querySelectorAll('h1,h2,p,[role="alert"]')].filter(visible).some(el => /^(請完成驗證|驗證您是人類|Verify you are human|Access Denied|Too Many Requests|異常活動|帳號已被凍結)$/i.test(text(el)));
  if (/captcha|challenge|verify|security|traffic|ban/.test(location.pathname) || [...challenges].some(visible) || blockedText) return answer('verification');
  if (!one('account')) return answer('needs_login');
  const title = () => text(one('productTitle'));
  const selected = () => all('selectedVariants').map(text);
  const quantity = () => one('quantity')?.value;
  const correctPage = () => location.pathname === new URL(args.url).pathname;
  const checkProduct = () => correctPage() && title() === args.title && quantity() === String(args.quantity) && selected().length === args.variants.length && args.variants.every(v => selected().includes(v));
  if (step === 'login') return answer('ok');
  if (step === 'search-ready') {
    const input = one('searchInput'); const button = one('searchButton');
    if (!input || !button || button.disabled || button.getAttribute('aria-disabled') === 'true') return answer('page_changed', { reason: '無法唯一確認搜尋欄與搜尋按鈕。' });
    return answer('ready', { query: args.query, currentQuery: input.value, inputSelector: selectors.searchInput, buttonSelector: selectors.searchButton });
  }
  if (step === 'results') {
    const seen = new Set(); const items = [];
    for (const el of all('results')) {
      const link = new URL(el.href, url);
      if (link.origin !== location.origin || !/-i\.\d+\.\d+$/.test(link.pathname)) continue;
      link.search = ''; link.hash = '';
      if (seen.has(link.href)) continue;
      seen.add(link.href); items.push({ url: link.href, text: text(el).slice(0, 700) });
      if (items.length >= args.limit) break;
    }
    return items.length ? answer('ok', { items }) : answer('page_changed', { reason: '無法讀取商品結果。' });
  }
  if (step === 'product') {
    if (!one('productTitle') || (selectors.price && !one('price'))) return answer('page_changed', { reason: '商品標題或價格無法唯一確認。' });
    const section = heading => all('productSections').filter(el => text(el.querySelector('h2')) === heading);
    const sectionText = heading => { const els = section(heading); return els.length === 1 ? text(els[0]).replace(new RegExp(`^${heading}\\s*`), '').slice(0, 6000) : null; };
    const variantOptions = all('variantOptions').map(el => ({ label: text(el), disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'), selected: selected().includes(text(el)) }));
    return answer('ok', { title: title(), price: text(one('price')) || null, description: sectionText('商品描述'), specifications: sectionText('商品規格'), variantOptions, availableVariants: variantOptions.filter(option => !option.disabled).map(option => option.label), selectedVariants: selected(), quantity: quantity() });
  }
  if (step === 'select') {
    if (!correctPage() || title() !== args.title || !one('quantity') || (!args.variants.length && all('variantOptions').length)) return answer('page_changed', { reason: '商品、規格或數量欄位無法核對。' });
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
    const choices = args.variants.map(name => buttons.filter(el => text(el) === name));
    if (choices.some(els => els.length !== 1 || els[0].disabled || els[0].getAttribute('aria-disabled') === 'true')) return answer('page_changed', { reason: '規格無法唯一確認。' });
    // 分次規格選擇可能需要等待框架更新；由下一次 product 讀取核對，不在此假定成功。
    for (const [index, els] of choices.entries()) if (!selected().includes(args.variants[index])) els[0].click();
    const input = one('quantity');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(args.quantity));
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    return answer('submitted');
  }
  if (step === 'add') {
    const button = one('add');
    if (!checkProduct() || (!args.variants.length && all('variantOptions').length) || !button || button.disabled || button.getAttribute('aria-disabled') === 'true') return answer('page_changed', { reason: '商品、規格、數量或加入按鈕無法核對。' });
    if (!/^(加入購物車|加入購物車\s*)$/.test(text(button))) return answer('page_changed', { reason: '按鈕不是加入購物車。' });
    button.click(); return answer('submitted');
  }
  if (step === 'verify-add') return one('added') ? answer('added') : answer('uncertain');
  if (step === 'cart-read') {
    if (location.pathname !== '/cart' || !selectors.cartRows || !all('cartRows').length) return answer('page_changed');
    return answer('ok', { items: all('cartRows').map(el => text(el).slice(0, 700)) });
  }
  if (step === 'checkout') {
    const button = one('checkout');
    if (location.pathname !== '/cart' || !button || button.disabled || button.getAttribute('aria-disabled') === 'true' || !/^(去買單|結帳)$/.test(text(button))) return answer('page_changed', { reason: '無法確認購物車上的結帳入口。' });
    button.click(); return answer('before_order');
  }
  return answer('page_changed', { reason: '未知步驟。' });
}

export function makeScript(step, args, selectors) {
  return `(${browserStep.toString()})(${JSON.stringify({ step, args, selectors })})`;
}
