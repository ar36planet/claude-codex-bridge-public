# claude-codex-bridge

讓 **Claude Code** 對 **你眼前那個 Codex TUI** 說話 —— 而你全程看得到。
反過來，Codex 也能把話送進 Claude Code 正在跑的那個 session。

不是螢幕抓字、不是檔案輪詢、不是 headless subagent。兩邊掛在同一個
`codex app-server` 的**同一條 thread** 上：Claude Code 送進去的訊息，會即時
出現在你正在看的 TUI 畫面裡。

> **要安裝的話看這裡：[SETUP.md](SETUP.md)（中文）· [SETUP.en.md](SETUP.en.md)（English）**
>
> 這份 README 講的是**設計理由與驗證紀錄** —— 為什麼是這個做法、哪些事實已經
> 量過、哪些還沒。想直接跑起來的話 SETUP 比較快。

驗證環境：codex-cli `0.147.0`，**Windows 11 與 macOS 26 都實測過**，
兩邊都跑在 **Node 24 LTS**（Krypton）上。程式碼不綁平台（路徑一律走
`node:path`，`resolveCodex()` 只有 Windows 分支是特例）。兩邊的差異與各自跑出來
的結果見下方「已驗證 / 未驗證」。

Node 需求是 `>=22`（`package.json` 的 `engines`），建議直接用 **v24 LTS**。

<details>
<summary>Node 20 會有兩個測試被取消（不是 bug）</summary>

`node --test` 在 Node 20 底下會把
`src/bridge.mjs` 與 `src/mcp/threadQueue.mjs` 裡刻意 `unref()` 過的逾時計時器
判成「event loop already resolved」，於是取消掉兩個測試：

```
#4  say times out with started turn metadata and cleans listeners
#20 a timed-out queue waiter cannot let later work pass an active turn
```

那兩個 `unref()` 是對的 —— 一個待中的 timeout 不該把 MCP server／CLI 的 process
吊著不退出。Node 22+ 的 test runner 會自己保住 handle，計時器照樣 fire。主程式在
Node 20 也跑得動（inbox hook 實測過），純粹是 test runner 的行為差異。

**macOS 上容易踩到的原因**：`codex` 常是某個 nvm 版本底下的全域套件，而那個版本
可能就是 Node 20，於是 `node` 預設就是 20。最乾淨的解法是讓 node 與 codex 待在
同一個 LTS 版本：

```bash
nvm install 24 && nvm alias default 24
nvm reinstall-packages 20        # 把 codex 等全域套件搬過去
```

（`codex` 的 bin 是 `#!/usr/bin/env node` 的 shim，它跟著 `PATH` 上的 node 跑，
不綁安裝時的版本。）

</details>

## 架構

```
        ┌──────────────────────────────┐
        │  codex app-server            │   ← 真正持有 thread 的地方
        │  --listen ws://127.0.0.1:8787│
        └───────┬──────────────┬───────┘
                │              │
   codex --remote ws://…       │  JSON-RPC over ws
                │              │
        ┌───────┴──────┐  ┌────┴─────────────┐
        │  Codex TUI   │  │  Claude Code     │
        │ （你在看）    │  │ （scripts/talk） │
        └──────┬───────┘  └────┬─────────────┘
               │               ▲
               └───────────────┘
        .bridge-inbox/<name>.jsonl → Stop hook
             （反方向：Codex → Claude Code）
```

正方向的關鍵在 `thread/resume` 的語意：

> *If thread_id identifies a running thread, app-server **rejoins** that thread.*

所以第二個 client 不是開新對話，也不是把存檔重播一次 —— 是**加入同一條正在跑
的 thread**。加入之後才收得到那條 thread 的通知串流；只是連上 endpoint 不夠。

## 用法

三個視窗。

**1. 共用 server**（開著不要關）

```powershell
node scripts/serve.mjs --cwd C:\path\to\你的專案
```

`--cwd` 是 **Codex 實際工作的目錄**。thread 沒自己指定 cwd 時會沿用
app-server 的，所以不給這個參數就會停在你啟動腳本的地方（也就是 bridge 自己的
資料夾）。也可以用環境變數 `CODEX_BRIDGE_CWD`。
port 用 `--port` 或 `CODEX_BRIDGE_PORT`（預設 8787）。endpoint 與 workspace
會寫進 `.bridge.json`，`talk.mjs` 自己會讀。

**2. 你要看的 Codex TUI**

```powershell
codex --remote ws://127.0.0.1:8787 -C C:\path\to\你的專案
```

`-C` 釘住那個視窗的 workspace；不給就沿用上面 `--cwd` 設的。

**先在 TUI 裡跟它講一句話、等它回完。** thread 要有第一輪對話「跑完」才
resumable，在那之前 `thread/resume` 會回 `no rollout found for thread id`。

注意這個陷阱：**`talk.mjs list` 在那之前就已經看得到那條 thread 了** —— TUI 一連
上就會建好 thread 並出現在 `thread/loaded/list`。所以「list 看得到」不等於「可以
送話」。跳過這步的話，`say` 送得出去、Codex 也會在 TUI 回覆，但 bridge 收不到
回覆串流，只會等到逾時（macOS 實測過這個症狀）。

**3. Claude Code 這側**

```powershell
node scripts/talk.mjs list               # 列出活著的 thread（含各自的 cwd）
node scripts/talk.mjs say "跑一下測試"     # 送話進去，你會在 TUI 看到
node scripts/talk.mjs read               # 讀完整 thread（結構化 JSON）
```

只有一條 thread 時 `say` / `read` 會自動選它；多條時要 `--thread <id>` 指定 ——
不猜你在跟哪個 session 講話。`list` 會一併印出每條 thread 的 cwd，多開時靠這個
分辨。

`say` 另外收 `--cwd <dir>`（只改這一輪之後的工作目錄）與 `--approvals`（見下）。

## MCP 介面

CLI 仍可直接使用；MCP 介面提供相同核心能力的結構化 tools。兩個方向共用同一套程式，
但主動發話端各自啟動一個 STDIO process：

- `--role claude`：Claude Code 主動對 Codex thread 發話。
- `--role codex`：Codex 主動把訊息排入 Claude mailbox。

### 安裝步驟

**0. 先確認前提**

- Node `>=22`（見開頭的版本說明）。
- 這個 repo 已經 `npm install` 過。
- **MCP 只是介面，不是傳輸層。** 它照樣要有一個跑著的 `serve.mjs` 和一個接上去的
  TUI 才會有東西可以講話 —— 見上面「用法」。

```bash
cd <這個 repo>
npm install
```

**1. 決定要裝哪一邊**

| 你想要的 | 裝什麼 |
|---|---|
| 只要 Claude Code 能對 Codex 發話 | 只裝 `--role claude`（Claude Code 端） |
| 只要 Codex 能對 Claude Code 留話 | 只裝 `--role codex`（Codex 端） |
| 雙向 | 兩邊都裝 |

只需要單向時**不要兩邊都裝**。被動接收那一半不靠 MCP —— 分別走 app-server/TUI
與 Claude 的 Stop hook。

**2. 安裝**

Claude Code 端（`--role claude`）：

```bash
# macOS / Linux
claude mcp add --scope project claude-codex-bridge -- \
  node /path/to/claude-codex-bridge/scripts/mcp.mjs --role claude
```

```powershell
# Windows
claude mcp add --scope project claude-codex-bridge -- `
  node "C:/path/to/claude-codex-bridge/scripts/mcp.mjs" --role claude
```

Codex 端（`--role codex`）：

```bash
# macOS / Linux
codex mcp add claude-codex-bridge -- \
  node /path/to/claude-codex-bridge/scripts/mcp.mjs --role codex
```

```powershell
# Windows
codex mcp add claude-codex-bridge -- `
  node "C:/path/to/claude-codex-bridge/scripts/mcp.mjs" --role codex
```

`--scope project` 會寫進該專案的 `.mcp.json`；要跨專案共用就換成 `--scope user`。

**路徑用絕對路徑，但「在哪個目錄啟動」不影響結果** —— 所有狀態檔
（`.bridge.json`、`.bridge-inbox/`、`.bridge-output/`）都是從模組位置解析的，
不看 cwd。所以一份安裝就夠，不需要每個專案各裝一次。

**3. 重開**

`claude mcp add` / `codex mcp add` 只是改設定檔，**已經在跑的 session 不會載入新的
MCP server**。裝完要把那個 session 關掉重開，tools 才叫得到。

**4. 確認裝好了**

在重開後的 session 裡叫 `bridge_status`。`ok: true` 且 `role` 正確就成功。
接著 `codex_threads_list` 應該看得到你的 TUI 那條 thread（含它的 cwd）。

不想開 session 也可以直接從命令列驗證同一條路：

```bash
npm run test:e2e:mcp-send        # 需要 serve + 已跑完第一輪的 TUI
```

### Tools

| Role | Tools |
|---|---|
| 共用 | `bridge_status`、`bridge_output_read` |
| Claude | `codex_threads_list`、`codex_thread_read`、`codex_message_send` |
| Codex | `claude_mailboxes_list`、`claude_mailbox_peek`、`claude_message_send` |

`codex_message_send` 會等整個 turn，因此 Codex 的 MCP 設定建議把 timeout 拉長，並讓 write
tools 需要核准：

```toml
[mcp_servers.claude-codex-bridge]
tool_timeout_sec = 360
default_tools_approval_mode = "writes"
```

MCP 模式只允許 `CODEX_BRIDGE_APPROVALS=tui`（預設）或 `decline`，不接受自動 `accept`。
短回覆直接 inline；超過 64 KiB 時寫到 `.bridge-output/`，回傳有 TTL 的 opaque artifact ID，
再用 `bridge_output_read` 分頁讀取。單一 capture 預設最多 10 MiB，不會把無上限 reply 塞進
一次 tool result 或 Node heap。

本機驗證：

```bash
npm test                         # 語法、unit、in-memory MCP、真實 STDIO smoke；不呼叫模型
npm run test:integration:mcp-app-server  # 真實 app-server 連線，不建立模型 turn
npm run test:spikes              # 真實 app-server regression，可能使用模型
npm run test:e2e:mcp-send        # 完整 MCP → 真實 TUI；需要 serve + 已跑完第一輪的 TUI
```

`test:e2e:mcp-send` 跟其他 spike 不同：它**不會**另起 app-server，而是照 `.bridge.json`
連上你眼前那個 TUI，在你正在看的 thread 裡建立一個真的 turn。所以它不在
`test:spikes` 裡，要自己主動跑。

## 反方向：Codex → Claude Code

Claude Code 沒有對等的 app-server，沒有 socket 可以推東西進去。它有的是
**Stop hook**：Claude 要收工前會跑，hook 回 `{"decision":"block","reason":...}`
就能叫它別停、並把 `reason` 當成新的輸入繼續做。

所以中間放一個信箱。信箱是**具名的** —— 因為可能同時有好幾個 Claude Code
session 在聽，共用一個檔案的話誰先收工誰就把別人的信也吞了：

```powershell
# Codex 那側（或任何地方）留話
node scripts/inbox.mjs push --to bridge "順便幫我看一下 auth 那段"

# 現在有誰在聽（含各自的工作目錄）
node scripts/inbox.mjs list

# 看某個信箱（不消耗）
node scripts/inbox.mjs peek --as bridge
```

`--to` 是「這封信要給誰」，`--as` 是「我是誰在讀」，都預設 `$CODEX_BRIDGE_MAILBOX`
再退回 `default`。

這個 repo 的 `.claude/settings.json` 已經掛好 Stop hook（信箱名 `bridge`），
Claude Code 在這個專案裡收工時會自動把信箱清空並接著做。訊息**只會送達一次**：
`drain()` 先 rename 再讀，所以同時在寫的人不會被讀到一半。

細節與取捨見 [`docs/reverse-channel.md`](docs/reverse-channel.md)。

## 讓別的 Claude Code session 也用這座橋

server 只要起一份，其他 session 共用。腳本的狀態（`.bridge.json`、信箱）都是
用**模組自身位置**解析的，不看 cwd，所以在任何目錄下用絕對路徑呼叫都對。

**正方向（那個 session → Codex）**：不用設定，直接呼叫。

```powershell
$bridge = "C:\path\to\claude-codex-bridge"
node "$bridge\scripts\talk.mjs" list
node "$bridge\scripts\talk.mjs" say --thread <threadId> "..."
```

多開 TUI 時務必帶 `--thread` —— `list` 會印出每條 thread 的 cwd 給你認。
（或者設 `CODEX_BRIDGE_URL`，就不必依賴 `.bridge.json`。）

**反方向（Codex → 那個 session）**：要在**那個專案**的
`.claude/settings.json` 掛 Stop hook，並給它一個**自己的信箱名**：

```json
{ "hooks": { "Stop": [ { "matcher": "*", "hooks": [
  { "type": "command",
    "command": "node \"C:/path/to/claude-codex-bridge/scripts/inbox.mjs\" hook --as web" }
] } ] } }
```

注意這裡**不能用 `$CLAUDE_PROJECT_DIR`** —— 那會指到那個專案自己，不是 bridge。
路徑要寫死到 bridge。信箱名（上例的 `web`）自己取，每個 session 一個。

之後 Codex 那側就能指名送信：

```powershell
node scripts/inbox.mjs push --to web "先把 CORS 那條修掉"
node scripts/inbox.mjs list       # 確認名字沒打錯、對方還活著
```

`list` 的資料來自每個 session 的 Stop hook 每次執行時的自我登記，所以**那個
session 至少要收工過一次**才會出現在名單上。

## 核准（Codex 要動手改東西時）

Claude Code 送進去的 turn 如果要跑指令、改檔案，Codex 會發核准請求。
app-server 把這種請求**廣播給所有連上的 client**，誰先回誰算數（沒搶到的會收到
`serverRequest/resolved`）。所以預設策略是 **`tui`：bridge 保持沉默，讓你眼前那
個視窗的提示去決定**。

沒人回會卡住整個 turn，所以有保險：超過 `CODEX_BRIDGE_APPROVAL_TIMEOUT_MS`
（預設 300 秒）還沒人回，bridge 自己 fail-closed 拒絕，turn 才能往下走。

```powershell
node scripts/talk.mjs say --approvals decline "..."   # 沒開 TUI 時用
node scripts/talk.mjs say --approvals accept  "..."   # 只用在你已經信任的環境
```

也可以用 `CODEX_BRIDGE_APPROVALS` 設預設值。

**廣播路由已在 macOS 實測定案**（`spike-approvals.mjs` 11/11）：一個 client
按下核准，另一個保持沉默的 client 會收到同一則請求、接著收到
`serverRequest/resolved`，turn 照常走完。所以「bridge 沉默 = 讓人決定」成立。

### 會讓「交給 TUI 的人決定」悄悄失效的兩個設定

核准請求在到達任何 client 之前，會先經過使用者自己的 codex 設定。以下兩者任一
生效時，**你眼前的 TUI 根本不會被問**，bridge 沉默也就不等於人在決定：

| 設定 | 位置 | 效果 |
|---|---|---|
| `PermissionRequest` hook | `~/.codex/hooks.json` | hook 先接走核准請求。macOS 實測：hook 掛著時，兩個 client **一則核准請求都收不到**，檔案照樣被寫出來 |
| `approvals_reviewer = "auto_review"` | `~/.codex/config.toml` | 交給 subagent 依風險自動決定，不問人 |

這兩個都是合理的個人設定，本專案不會去動它們；只是要知道：**開著它們的時候，
`--approvals tui` 的「人」其實是它們。** 想確認自己這台機器是哪一種，跑
`spike-approvals.mjs` —— 那支 spike 起自己的 app-server 時會用
`--disable hooks -c approvals_reviewer=user` 把這兩者關掉，量的是協定本身。

各種核准請求的**回覆格式並不一致** —— 只有兩個 `item/*/requestApproval` 吃
`{decision:"decline"}`；`item/permissions/requestApproval` 要的是一份（空的）
權限 profile，舊的 `execCommandApproval` / `applyPatchApproval` 要的是
`{decision:{denied:{rejection}}}`。回錯形狀是 schema error，不是禮貌的拒絕。
對照表在 `src/appServerWsClient.mjs` 的 `DEFAULT_SERVER_REQUEST_RESPONSES`。

## 為什麼不是別的做法

| 做法 | 問題 |
|---|---|
| `wezterm cli send-text` / `get-text` | 抓的是 TUI 渲染後的畫面：框線字元、spinner、換行截斷；判斷「回完了沒」只能靠輪詢畫面變化 |
| 共用檔案信箱（正方向） | 可行但看不到即時狀態，且觸發要人工介入 |
| `/codex:rescue` subagent | 每次冷啟動、獨立 session，**接不到你眼前那個 TUI** |
| 本方案 | 結構化事件；`turn/steer` 還能對執行中的 turn 插話 |

反方向仍然是檔案信箱 —— 但那是因為 Claude Code 沒有可掛的 socket，而 Stop hook
讓「觸發」不必人工介入。

## 安全

- Listener 綁 loopback。`--ws-auth` 只對 non-loopback 生效，所以本機免 token。
- 核准預設交給人（`tui`），逾時 fail-closed。非核准類的 server→client 請求
  （工具呼叫、MCP elicitation）一律 fail-closed —— bridge 沒有能問人的 UI。

## 已驗證 / 未驗證

三個 spike，各自起自己的 app-server（ephemeral port），不會碰到你正在看的 thread：

```powershell
node scripts/spike-multiclient.mjs   # 9/9   兩個 client 共用一條 thread
node scripts/spike-multithread.mjs   # 7/7   兩條 thread 同時跑，回覆不串味
node scripts/spike-approvals.mjs     # 11/11 於 macOS；Windows 上 3 項 SKIP，見下
```

macOS（26.5.1，Node v24.19.0 LTS，codex-cli 0.147.0）實跑結果：三支 spike 全過、
`npm test` 21/21、`npm run test:integration:mcp-app-server` PASS。
`scripts/serve.mjs --cwd`、`scripts/talk.mjs list`、`scripts/inbox.mjs`
（push / list / peek / hook，含中文）也都在 macOS 手測過；
inbox hook 連 Node 20 都跑得動，所以 Stop hook 不必挑 node 版本。

另外以**真實 TUI**（`codex --remote`）實測確認：Claude Code 送的訊息會在 TUI 上
渲染成 user message、Codex 正常回覆、回覆串流回 Claude Code。

已釐清（codex-cli 0.147.0）：

- **通知一律帶 `threadId`**，串流類（`item/agentMessage/delta`）另帶 `turnId`，
  且 `turn/start` 回傳的 `turn.id` 與串流上的完全一致。
  早期以為「通知不帶 threadId」，實際上是 **client 沒 join 到 thread** 的症狀。
- **thread 必須先 `thread/resume` 加入**才收得到通知；而 thread 要**第一輪對話
  跑完**才 resumable。
- **`historyMode: "paginated"`**（TUI 建立的 thread）→ `thread/read` 帶
  `includeTurns` 會失敗（`list_turns is not supported yet`）。事後撈歷史這條路
  目前是斷的；回覆靠即時串流接。

- **核准會廣播給所有 client，第一個回答的算數**（macOS 定案）。沉默的那個
  client 同樣收得到請求，事後收到 `serverRequest/resolved`，turn 不會卡死。
  在 OS sandbox helper 起不來的機器上（某些受管企業 Windows 會出現
  `ShellExecuteExW failed to launch setup helper: 1223`），寫檔在「問人」之前就先
  失敗，核准請求根本不會發出，所以那三項會標成 **SKIP** —— 環境限制，不是協定問題。
- **使用者層的 `PermissionRequest` hook 會整個攔掉核准請求**，client 一則都收不到
  （macOS 實測）。細節見上方「核准」章節。

尚未驗證：

- `turn/steer`（對執行中的 turn 插話）只讀過 schema，沒實測。
- ~~`-C` 沒實跑~~ → **已實測**：TUI 不帶 `-C` 連上時，thread 的 cwd 是
  **app-server 的 cwd**，跟你在哪個目錄下敲 `codex --remote` 無關；帶 `-C <dir>`
  才會換成那個目錄。（macOS，用 pty 起 TUI、另一個 client 讀 `thread/read`。）
- 整組協定標著 `[experimental]`，codex 升版可能會漂移。

## 參考

反方向為什麼是 Stop hook、而不是別的機制：
[`docs/reverse-channel.md`](docs/reverse-channel.md)

協定 schema：`codex app-server generate-json-schema --out <dir>`
