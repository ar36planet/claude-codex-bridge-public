# 安裝與設定

_English: [SETUP.en.md](SETUP.en.md) · 設計理由與驗證紀錄見 [README.md](README.md)_

這份文件只講「怎麼把它跑起來」。跑起來之後的樣子是：你有一個看得到的 Codex TUI
視窗，Claude Code 送的話會直接出現在那個畫面上。

---

## 1. 你需要什麼

| | 說明 |
|---|---|
| **Node.js `>=22`** | 建議 v24 LTS。v20 跑得動主程式，但測試會有兩個被 test runner 取消 |
| **Codex CLI** | 驗證於 `0.147.0`。`codex --version` 確認，並且已經 `codex login` |
| **Claude Code** | 正方向的發話端 |

`codex app-server` 這組協定在 Codex 內部標著 `[experimental]`，升版可能會漂移。
遇到怪事先對一次 `codex --version`。

<details>
<summary>macOS：node 與 codex 版本不一致的常見狀況</summary>

`codex` 常被裝成某個 nvm 版本底下的全域套件，那個版本可能低於 22，於是預設的
`node` 就跟著變成舊版。讓兩者待在同一個 LTS 最省事：

```bash
nvm install 24 && nvm alias default 24
nvm reinstall-packages 20        # 把 codex 等全域套件搬過去（20 換成你原本的版本）
```

`codex` 的執行檔是 `#!/usr/bin/env node` 的 shim，它跟著 `PATH` 上的 node 跑，
不綁安裝當下的版本。

</details>

## 2. 取得專案

```bash
git clone https://github.com/ar36planet/claude-codex-bridge-public.git
cd claude-codex-bridge-public
npm install
```

確認裝好了：

```bash
npm test        # 21 個測試，不呼叫模型、不連網
```

## 3. 最小可用設定（三個視窗）

### 視窗 1 — 共用 server（開著不要關）

```bash
node scripts/serve.mjs --cwd /path/to/你的專案
```

`--cwd` 是 **Codex 實際工作的目錄**。不給的話會停在你啟動腳本的地方，也就是這個
repo 自己的資料夾 —— 通常不是你要的。

port 預設 8787，用 `--port` 或 `CODEX_BRIDGE_PORT` 改。endpoint 會寫進
`.bridge.json`，後面的指令自己會讀。

### 視窗 2 — 你要看的 Codex TUI

```bash
codex --remote ws://127.0.0.1:8787
```

**接上之後，先在 TUI 裡自己打一句話，等它回完。**

這步不能跳過。thread 要有第一輪對話「跑完」才能被 bridge 加入；在那之前
`talk.mjs list` **已經看得到那條 thread 了**，但送話進去會收不到回覆，只會等到
逾時。「list 看得到」不等於「可以送話」。

要讓這個視窗指向別的專案，加 `-C /path/to/另一個專案`。不加的話它跟著視窗 1 的
`--cwd` 走 —— **跟你在哪個目錄下敲這行指令無關**。

### 視窗 3 — Claude Code 這側

```bash
node scripts/talk.mjs list                      # 列出活著的 thread（含各自的 cwd）
node scripts/talk.mjs say "請只回覆一個詞：OK"    # 送話，你會在視窗 2 看到它出現
node scripts/talk.mjs read                      # 讀完整 thread（結構化 JSON）
```

看到 TUI 畫面上長出這則訊息、Codex 回覆、回覆串流回視窗 3，就成功了。

多開 TUI 時要用 `--thread <id>` 指定 —— 它不會猜你在跟哪個 session 講話。
`list` 印出的 cwd 就是拿來認人的。

## 4.（選用）裝成 MCP

CLI 已經夠用；MCP 提供的是同樣能力的結構化 tools，讓 Claude Code 或 Codex 可以
自己決定什麼時候發話。

**只裝你需要的那個方向：**

| 你想要的 | 裝哪個 |
|---|---|
| Claude Code 主動對 Codex 發話 | `--role claude`（裝在 Claude Code） |
| Codex 主動對 Claude Code 留話 | `--role codex`（裝在 Codex） |
| 雙向 | 兩個都裝 |

```bash
# Claude Code 端
claude mcp add --scope project claude-codex-bridge -- \
  node /path/to/claude-codex-bridge/scripts/mcp.mjs --role claude

# Codex 端
codex mcp add claude-codex-bridge -- \
  node /path/to/claude-codex-bridge/scripts/mcp.mjs --role codex
```

三件事要知道：

1. **路徑用絕對路徑，但在哪個目錄啟動不影響。** 狀態檔都是從模組位置解析的，
   不看 cwd，所以一份安裝就夠，不必每個專案各裝一次。
2. **裝完要重開。** `mcp add` 只是改設定檔，已經在跑的 session 不會載入新的 MCP
   server。
3. **MCP 不是傳輸層。** 它照樣需要視窗 1 的 server 和視窗 2 的 TUI。

Codex 端建議在 `~/.codex/config.toml` 加上：

```toml
[mcp_servers.claude-codex-bridge]
tool_timeout_sec = 360                    # codex_message_send 會等完整個 turn
default_tools_approval_mode = "writes"
```

確認裝好：重開後叫 `bridge_status`，`ok: true` 且 `role` 正確就對了。

## 5.（選用）反方向：讓 Codex 回話給 Claude Code

Claude Code 沒有 socket 可以推東西進去，所以走 **Stop hook + 具名信箱**：Claude
要收工前 hook 會執行，把信箱裡的訊息當成新輸入交回去。

這個 repo 的 `.claude/settings.json` 已經掛好了（信箱名 `bridge`）。要讓**別的**
專案也能收信，在那個專案的 `.claude/settings.json` 加：

```json
{
  "hooks": {
    "Stop": [{ "matcher": "*", "hooks": [{
      "type": "command",
      "command": "node \"/path/to/claude-codex-bridge/scripts/inbox.mjs\" hook --as 你的信箱名"
    }]}]
  }
}
```

命令列**不能用 `$CLAUDE_PROJECT_DIR`** —— 那指向那個專案，不是這座橋。

留話與查看：

```bash
node scripts/inbox.mjs push --to 你的信箱名 "順便幫我看一下 auth 那段"
node scripts/inbox.mjs list          # 現在有誰在聽、在哪個目錄
node scripts/inbox.mjs peek --as 你的信箱名   # 看但不消耗
```

信箱是具名的，因為可能同時有好幾個 Claude Code session 在聽；共用一個檔案的話，
誰先收工誰就把別人的信一起吞了。

## 6. 出問題時

| 症狀 | 原因與處理 |
|---|---|
| `no rollout found for thread id` | TUI 接上後沒先自己講一句話。回視窗 2 送一句、等它回完 |
| 送出去了但等到逾時 | 同上。訊息其實有送到、Codex 也回了，只是 bridge 沒加入 thread 所以聽不到 |
| `no app-server endpoint` | 視窗 1 的 `serve.mjs` 沒在跑，或 `.bridge.json` 不見了。也可以直接設 `CODEX_BRIDGE_URL` |
| `AMBIGUOUS_THREAD` | 有多條 thread。用 `--thread <id>` 指定，`list` 會印出各自的 cwd 給你認 |
| `(no live threads)` | TUI 還沒接上，或接到別的 port |
| port 被佔用 | `--port` 換一個，兩邊都要改 |
| Codex 動手改檔案時 TUI 沒跳出核准提示 | 見下方 |
| `npm test` 有 2 個 cancelled | Node 版本低於 22。見第 1 節 |

### 關於核准

預設情況下，Codex 要跑指令或改檔案時會發核准請求，app-server 把它**廣播給所有
連著的 client**，誰先回誰算數。這座橋刻意保持沉默，所以決定權在**你眼前那個 TUI
的提示**。沒人回的話會逾時 fail-closed，turn 不會永遠卡著。

但有兩個使用者層的設定會在請求到達任何 client **之前**就先把它接走，這時候你的
TUI 不會跳出提示：

| 設定 | 位置 |
|---|---|
| `PermissionRequest` hook | `~/.codex/hooks.json` |
| `approvals_reviewer = "auto_review"` | `~/.codex/config.toml` |

兩者都是合理的個人設定，這個專案不會去動它們。只是要知道：**開著它們的時候，
決定的人不是你。**

沒有 TUI 可以問人的場合，明確指定拒絕：

```bash
node scripts/talk.mjs say --approvals decline "..."
```
