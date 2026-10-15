# 操作流程

## 準備

先透過宿主正式瀏覽器工具觀察目前蝦皮分頁，取得穩定的分頁識別，確認使用者可接手同一工作階段。不要自行安裝瀏覽器工具、啟動瀏覽器或另接 CDP。

在技能根目錄複製 `config.example.json` 成 `config.local.json`，觀察實際 DOM 後校準 CSS selector。範例並非實站驗證完成的設定；`add`、`added`、`cartRows`、`checkout` 預設留空，不能隨意猜測。`checkout` 必須是購物車的「去買單」或「結帳」，不得指向「下訂單」。選擇商品列時排除個人資料，不以 `body` 代替。

```sh
node scripts/shop.mjs bind --session '原分頁識別' --script-mode readonly --takeover-ready
```

三種模式：`readwrite` 代表宿主明確允許頁面腳本操作；`readonly` 只產生唯讀腳本，點擊與輸入使用宿主正式工具；`none` 全程由宿主正式工具觀察與操作。瀏覽器工具即使把操作介面命名為 `playwright`，也不代表需要安裝 Playwright 套件。

## 規劃、執行、回報

```sh
node scripts/shop.mjs plan login
```

輸出包含 `id`、`session`、`step` 及 `action`：

- `browser_script`：將 `action.script` 交給宿主正式允許的頁面腳本介面。唯讀腳本不能用於點擊或輸入。
- `native_browser`：依 `operation` 使用宿主正式的導航、觀察、輸入或點擊工具。先取得最新元素證據，不沿用過時索引。

搜尋的原生操作可能帶有 `action.preflight`，須先執行其中的唯讀技能腳本。它核對登入、驗證狀態及唯一的搜尋欄與按鈕，回傳 `ready` 後才可輸入及點擊。宿主的頁面腳本僅允許唯讀時，這些輸入與點擊是必要的原生操作；結果解析與商品描述／規格仍執行 CLI 產生的技能腳本，不改用臨時解析程式。

`product` 輸出 `price`、`description`、`specifications`、`availableVariants` 等欄位。`price` selector 須依實際主商品價格校準，避免讀到推薦商品或運費；保留整個價格範圍，不能把搜尋卡最低價視為所有規格的價格。描述與規格只讀取 `productSections` 中標題相符的區塊。欄位缺失或不唯一時不臆測內容。

`variantOptions` 同時輸出各選項的 `label`、`disabled`、`selected`；`availableVariants` 排除停用選項。須比較原生瀏覽器的停用與選取狀態，不能只看選項文字；蝦皮可能用 `selection-box-selected`，沒有 `aria-pressed`。同一賣場可能混有機身和配件，列出價格範圍後仍須核對選定規格的價格。

**一次操作只執行一次。** `plan` 會先落盤，結果未回報時不會再次產生操作。宿主失敗、超時或結果不明時，保留原分頁並 `handoff`，不能重送。

唯讀解析有狹窄例外：若已用宿主觀察確認原頁面存在商品、沒有 CAPTCHA 或存取阻擋，且問題只在 selector 或版面判斷，可修正讀取腳本後重讀同一頁，將實際結果回報原本的讀取操作。這不允許再次導航、搜尋、加入、規格點擊或結帳。保留失敗紀錄，不以空結果推定沒有商品。

宿主將實際觀察存入 `.local/result.json`；`session` 由宿主補上原分頁識別，不由頁面產生：

```json
{
  "session": "原分頁識別",
  "url": "https://shopee.tw/",
  "outcome": "needs_login"
}
```

```sh
node scripts/shop.mjs record --id 'plan 回傳的識別' --result-file .local/result.json
```

結果檔只保留必要欄位，不能填寫假資料來推進流程，也不要保存完整工具回應。腳本可能回傳 `items` 或商品資訊，供代理向使用者比較；狀態檔只保留必要操作資訊。

## 購物步驟

所有下列命令之間都須由宿主實際執行操作並 `record`，不是可直接連續貼上的全自動命令。

| 步驟 | 命令及核對 |
| --- | --- |
| 登入檢查 | `plan login`；未登入就交接，使用者完成並告知後才恢復 |
| 搜尋 | `plan search --query '無線滑鼠'`；以原頁面觀察到的搜尋欄或搜尋連結導航至預期網址，確認輸入後再送出，不直接假定已完成 |
| 讀取結果 | `plan results --limit 10`；保留可見價格、評價及運費文字，不假定完整性 |
| 開啟商品 | `plan open --url '實際商品網址'` |
| 核對商品 | `plan product --url '實際商品網址'`；腳本核對商品識別並讀取重要資訊，缺漏才由宿主觀察校準，詳見 [商品解析](product-parsing.md) |
| 選規格與數量 | `plan select --url '實際商品網址' --title '完整標題' --variant '黑色' --quantity 1`；多個規格重複指定 `--variant` |
| 再次核對 | `plan product`；確認網址、標題、選取規格及數量皆正確 |
| 加入一次 | `plan add`，參數同 `select`；依購物需求核對商品後直接執行，不需要額外授權或確認 |
| 確認加入 | `plan verify-add`；立即觀察成功提示，沒有提示就交接人工檢查，不重送 |
| 開啟購物車 | `plan cart`，再 `plan cart-read`；由使用者勾選本次商品、處理優惠及配送 |
| 進入結帳 | `plan checkout --authorized`；只在購物車且確認本次商品後執行 |
| 最後下單 | 立即交接使用者，沒有自動下單命令 |

導航後以目前網址核對。`record` 的導航成功值為 `navigated`；只代表抵達該頁，下一步仍須觀察登入或驗證狀態。原生工具讀取成功用 `ok`，規格操作與加入送出用 `submitted`，加入成功提示用 `added`，進入結帳用 `before_order`。這些值必須有當次工具證據。

`select` 可能觸發前端框架更新，因此不能將規格點擊完成視為規格核對完成。購物車有其他既有商品時，不自動全選。

## 阻擋與恢復

看到風控、驗證或失敗時：

```sh
node scripts/shop.mjs handoff --reason '原分頁顯示驗證，等待使用者處理'
node scripts/shop.mjs status
```

若工具有 HTTP 證據，在結果檔附 `httpStatus` 與可選 `retryAfter`；403、429、503 會記錄冷卻。沒有網路觀察能力時不得假稱已檢查 HTTP；仍根據可見頁面停止。

等使用者明確回覆完成後，先重新觀察同一分頁，再恢復：

```sh
node scripts/shop.mjs resume --session '原分頁識別' --human-confirmed
# 加入結果不明，且使用者確認已加入：
node scripts/shop.mjs resume --session '原分頁識別' --human-confirmed --resolution applied
# 或使用者確認完全沒有加入：
node scripts/shop.mjs resume --session '原分頁識別' --human-confirmed --resolution not-applied
```

`resume` 不會重送。搜尋上限需使用者同意後加 `--new-round`。冷卻尚未結束不能恢復。每次會產生網站互動的規劃至少間隔 5 秒，搜尋至少間隔 15 秒；唯讀 DOM 觀察不需要延遲，以免錯過成功提示。規格群組操作仍應由宿主按頁面更新節奏分次執行。

離開碼：`0` 表示規劃或紀錄成功，`2` 表示需要等待或人工處理，`1` 表示環境或資料錯誤。`BEFORE_ORDER` 是正常交接，不是訂單已成立。

`.local/` 不上傳。若程序中斷留下 `lock`，先確認原程序完全結束，再移除工作目錄下的 `lock`；保留 `state.json`。同一帳號與分頁不能以多個狀態目錄並行操作。
