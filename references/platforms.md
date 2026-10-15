# 平台條件

本技能使用「各平台內建的瀏覽器工具」，不是 Browser Use 套件。共用 `SKILL.md` 與 Node.js 狀態腳本，不綁定模型或瀏覽器供應商。

## 必要能力

1. 能在原工作階段觀察及操作蝦皮頁面。
2. 使用者可接手相同瀏覽器，登入或處理驗證後，代理可恢復原分頁。
3. 可執行 Node.js 22 以上腳本並保存工作目錄。
4. 若提供頁面腳本，須清楚辨別唯讀與讀寫權限；不提供時改用正式瀏覽器操作工具。

| 平台 | 技能載入與宿主條件 |
| --- | --- |
| ChatGPT | 由實際介面的技能、檔案或受支援工具載入；須確認該介面同時提供腳本執行、內建瀏覽器與接管。官方有雲端瀏覽器接手說明，但不是每個聊天介面皆保證具備完整條件 |
| Claude Code | 整份資料夾可放入 `.claude/skills/shopee-shopping-skill/`；瀏覽器與接管由使用者環境正式工具提供 |
| Claude 網頁 / API | 官方支援自訂 Agent Skills，但技能載入不等於已有可接管的瀏覽器；執行環境另有網路與套件限制 |
| Grok / 其他機器人 | 宿主載入技能與執行工具；xAI function calling 由宿主執行功能，未確認一般 Grok 聊天介面可直接安裝技能或接管瀏覽器 |
| Hermes | 依目前 Profile 的正式技能機制安裝；使用 Hermes 現有瀏覽器與 terminal 工具，確認與使用者接手的工作階段相同，不修改核心或另外建立瀏覽器 |

這是相容條件，不是各平台實測完成清單。沒有宿主原生接管能力時，技能不能自行創造接管介面。代理也不能只回報「已交接」而沒有讓使用者接觸原瀏覽器的方式。

## 對接規約

`plan` 輸出操作、原分頁識別與唯一操作識別。宿主依正式工具執行一次，再以 `record` 回報來源分頁、目前網址與結果。分頁識別不符時拒絕套用結果。外部工具呼叫使用固定操作列舉與參數陣列，不提供任意 shell 字串。

若宿主的唯讀腳本介面限制全域物件或語法，可以使用該介面允許的等價讀取方式，或改用正式觀察工具；不得降低限制。操作選項必須以最新頁面證據取得。

2026-10-15 在既有 Codex 瀏覽器確認：蝦皮首頁可讀取，唯讀頁面腳本可取得登入連結與網址。當時未登入，未測試加入與結帳。這個介面的頁面 `evaluate` 為唯讀，因此應使用 `readonly` 模式，輸入及點擊用正式操作工具。

官方參考：

- [Claude Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Hermes Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [ChatGPT 瀏覽器接手](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt)
- [xAI function calling](https://docs.x.ai/developers/tools/function-calling)
