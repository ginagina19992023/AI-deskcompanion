# AI activity integration

The pet uses one provider-neutral activity shape for Claude, Codex, DeepSeek, Kimi, OpenAI-compatible agents and local models.

```json
{
  "provider": "deepseek",
  "sessionId": "my-agent-1",
  "status": "working",
  "toolName": "shell",
  "detail": "运行测试",
  "taskTitle": "修复登录流程"
}
```

Supported status values are `working`, `review`, `waiting`, `error`, `celebrate`, and `idle`. Common aliases such as `thinking`, `tool_start`, `permission`, `completed`, and `failed` are normalized automatically.

## Local endpoint

While the pet is running, send JSON to:

```text
POST http://127.0.0.1:47811/activity
```

The listener binds to loopback only. It does not accept remote network connections.

## Command-line bridge

The dependency-free bridge works with clients that support lifecycle hooks:

```powershell
node tools/ai-activity.cjs --provider deepseek --session agent-1 --status working --tool shell --detail "运行测试"
node tools/ai-activity.cjs --provider kimi --session agent-2 --status review --tool web_search --detail "搜索资料"
node tools/ai-activity.cjs --provider kimi --session agent-2 --status celebrate --detail "任务完成"
```

It can also read the payload from stdin. If the pet is not running, it writes the latest event under `~/.ai-activity/sessions/`; the pet reads it after the next start.

## DeepSeek and Kimi tool-call loop

Both providers expose OpenAI-compatible `tool_calls`. In the agent code:

1. Emit `working` before sending the model request.
2. When `finish_reason` is `tool_calls`, emit one activity for each `tool_call.function.name`.
3. Emit `review` for read/search tools and `working` for write/shell tools.
4. Emit `error` if the tool or model request throws.
5. Emit `celebrate` when the final answer completes, then `idle` when the session closes.

The model API decides which tool to call; the client still executes that tool. Therefore the activity event belongs immediately around the client's real tool execution, not merely around the model request.

## Built-in adapters

- Claude Code: command hooks provide live tool names, status, failures and approval waits.
- Codex: the app reads the local rollout stream to show live reasoning and tool calls. Codex's configured notify command remains in place for completed-turn records.
- DeepSeek/Kimi/other agents: use the loopback endpoint or the CLI from the client that executes the tools.

Ordinary provider web pages do not expose their private internal tool events to other desktop applications. They require a client hook, extension, or API-based agent loop to report activity honestly.
