# 商品網址解析

給定蝦皮臺灣站商品網址後，由宿主在既有瀏覽器分頁開啟，再執行 CLI 產生的商品讀取腳本。CLI 不會自行向蝦皮發送 HTTP 請求；它仍須有宿主瀏覽器配合。登入或驗證未完成時，回報實際阻擋，不輸出猜測商品資料。

1. `plan open --url '商品網址'`，宿主開啟並 `record` 實際導航結果。
2. `plan product --url '商品網址'`，在同一分頁執行 `action.script` 並 `record`。
3. 比對網址中的賣場與商品識別，避免讀錯商品；支援 `-i.賣場.商品` 與 `/product/賣場/商品`。
4. 檢查 `missingFields` 與 `truncatedFields`。有缺漏時由宿主讀取對應區塊、校準 selector，再以技能腳本驗證；不能把讀取成功的 `ok` 當作資料必定完整。

## 重要欄位

| 欄位 | 內容 |
| --- | --- |
| `title`、`shopId`、`productId`、`url` | 商品標題、賣場與商品識別、當次頁面網址 |
| `price` | 當前規格價格或未選規格的價格範圍 |
| `description` | 商品描述原文；最多 20,000 字元，超出時明確標記截斷 |
| `specifications` | 商品規格原文，保留原頁面的資訊 |
| `attributes` | 逐欄的 `{ name, value }`，例如品牌、二手／全新、容量、保固、出貨地、認證；頁面沒提供的欄位不補填 |
| `variantGroups` | 顏色、容量等分組，包含各選項的文字、停用與選取狀態 |
| `variantOptions`、`availableVariants` | 全部選項及可操作的選項；可操作不代表實際下單一定獲准 |
| `selectedVariants`、`quantity` | 當前已選規格及數量輸入值；數量輸入值不是庫存 |
| `stock` | 有貨／售罄／未知、頁面顯示的剩餘數量、來源文字及所屬範圍 |
| `purchase` | 加入按鈕是否可操作、購買限制提示與目前狀態 |
| `missingFields`、`truncatedFields` | 缺失或被截斷的資料，不隱藏缺漏 |

## 庫存與購買狀態

`stock.status` 為 `in_stock`、`out_of_stock` 或 `unknown`。只有明確庫存文字才判斷有貨或售罄；按鈕停用或數量不能增加，不直接當作缺貨。

`stock.scope` 為 `product`、`selected_variant` 或 `unselected_variants`。未選完全部規格時，頁面的總庫存不能視為任一顏色／容量的庫存。商品規格區的「商品數量」仍保存在 `attributes`，不覆蓋所選規格剩餘數量。

`purchase.status` 為：

- `needs_selection`：還有規格組未選完。
- `quantity_limited`：頁面有「已達到購買上限」等數量提示；仍保留按鈕狀態，不能據此斷言商品不能購買。
- `restricted`：有明確無法購買／配送提示，或目前加入按鈕停用。
- `unavailable`：頁面明確顯示缺貨或零庫存。
- `ready`：頁面顯示有庫存、已選規格且按鈕可操作，僅代表頁面狀態，不保證後端接受。
- `unknown`：證據不足。

## 現場驗證

2026-10-15，商品 42758482693 的「金」規格：

```json
{
  "price": "$2,500",
  "selectedVariants": ["金"],
  "stock": {
    "status": "in_stock",
    "quantity": 1,
    "scope": "selected_variant",
    "text": "數量\n還剩1件"
  },
  "purchase": {
    "status": "quantity_limited",
    "addButtonEnabled": true,
    "messages": ["已達到購買上限"]
  },
  "missingFields": [],
  "truncatedFields": []
}
```

同頁的規格區顯示商品數量 5，所選金色庫存顯示 1；兩者範圍不同，已分開保留。腳本讀到的價格、庫存、描述、結構化規格及限制提示均與原生瀏覽器內容一致。

商品頁有巢狀 `section`，規格選項與庫存只讀最內層相符區塊，避免把外層運送區錯當規格組或因多個相符節點漏讀庫存。

這是可見商品資訊解析，不承諾取得所有規格組合的價格／庫存、隱藏資料或實際硬體機況。需完整規格組合時，另行逐項選取、等待頁面更新再讀取，不能從單一已選規格推算其他組合。平台改版導致缺漏時，依 `missingFields` 回報並校準。
