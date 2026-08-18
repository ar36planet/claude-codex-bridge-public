# 反方向：Codex → Claude Code

正方向（Claude Code → Codex）有 socket 可用：兩邊掛在同一個 `codex app-server`
上，訊息走 JSON-RPC。反方向沒有這種東西 —— **Claude Code 沒有對等的 app-server**，
沒有 endpoint 可以連、沒有 thread 可以 join。

所以問題不是「怎麼傳」，是「傳進去之後，誰去戳 Claude Code 讓它看到」。

## 三個候選

| 機制 | 送達時機 | 需要人介入嗎 | 問題 |
|---|---|---|---|
| 檔案 + 使用者手動貼 | 隨時 | 要 | 就是沒有橋 |
| MCP server 工具 | Claude 想到要讀的時候 | 不要 | 是 pull 不是 push；Claude 沒理由去讀就永遠不讀 |
| **Stop hook** | Claude 要收工的那一刻 | 不要 | 只在收工點送達，中途插不了話 |

選了 Stop hook。理由是它是唯一**真的能把文字塞進 Claude 當前輸入**的注入點：

> Stop hook 回 `{"decision": "block", "reason": "<文字>"}`
> → Claude Code 不收工，並把 `reason` 當成新的輸入繼續做。

MCP 工具那條路看起來更彈性，但它是 pull：Claude 不主動呼叫就什麼都不會發生，
而「Codex 有話要說」這件事 Claude 根本無從得知。那不是通道，是留言板。

## 實作

```
Codex 那側                    .bridge-inbox/web.jsonl            Claude Code (web)
─────────                     ──────────────────────            ─────────────────
push --to web "…" ──append──▶ {"id":…,"to":"web","text":…}
                                          │
                                          │  Claude 要收工
                                          ▼
                          hook --as web  ──drain──▶  {"decision":"block",
                                                      "reason":"…"}
                                                            │
                                                            ▼
                                                     Claude 繼續做
```

信箱**具名**：`.bridge-inbox/<name>.jsonl`。`--to` 是收件人，`--as` 是誰在讀。
沒有名字的話，兩個 Claude Code session 同時掛 hook，先收工的會把另一個的信一起
drain 走 —— 那不是延遲，是丟失。

- **JSONL 而不是 socket**：兩端不同時在線。Codex 想寫就寫，Claude 收工才讀。
- **`drain()` 先 rename 再讀**：這是「剛好送達一次」的來源。同時在 append 的人
  要嘛落在被搬走的那份、要嘛落在新開的那份，不會被讀到一半。
- **`stop_hook_active` 防迴圈**：一個每次都 block 的 Stop hook 會讓 session 永遠
  停不下來。Claude Code 在第二輪會把這個旗標設起來，看到就放行。
  注意這時候**不 drain** —— 訊息留著，下次收工再送。
- **hook 永不失敗**：`inbox.mjs` 在 `hook` 模式下即使拋錯也 `exit 0`。壞掉的信箱
  不該有能力卡住別人的 turn。

掛載設定在 `.claude/settings.json`（專案層級，跟著 repo 走）：

```json
{ "hooks": { "Stop": [ { "matcher": "*", "hooks": [
  { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/scripts/inbox.mjs\" hook --as bridge" }
] } ] } }
```

用 `node` 而不是 `pwsh`，`$CLAUDE_PROJECT_DIR` 而不是絕對路徑 —— 這份設定在
macOS 上一樣能用。

## 已知限制

- **只在收工點送達。** Claude 正在跑一個長任務時 Codex 留的話，要等它做完才會被
  看到。要中途插話沒有辦法 —— Claude Code 沒有對應的注入點。
- **沒有回執。** Codex push 完不知道 Claude 何時讀到、有沒有照做。要的話得讓
  Claude 用 `talk.mjs say` 回一句，繞回正方向。
- **要自己記得取名。** 名字打錯 = 信永遠躺在一個沒人讀的信箱裡。
  `inbox.mjs list` 會列出登記過的名字與各自的 cwd，但一個 session 要**收工過
  至少一次**（Stop hook 跑過）才會出現在名單上。
- **信箱目錄全域共用。** 預設在 bridge repo 底下的 `.bridge-inbox/`，跨專案共用。
  要完全隔開就設 `CODEX_BRIDGE_INBOX_DIR`。
