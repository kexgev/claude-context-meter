# Claude Context Meter

A minimal VS Code extension that shows your Claude Code token usage as an ASCII progress bar directly in the status bar — updates instantly via file watcher, zero polling.

## Status bar

```
🤖 my-project ███░░ 156k/200k (78%) in:140k out:16k
```

The bar fills as your context fills. Color changes automatically:
- Default — under warning threshold
- **Yellow** — above warning (default 50%)
- **Red** — above danger threshold (default 75%)

## Tooltip (hover)

```
my-project

`claude-sonnet-4-6`  ·  🟡 warn · 78%

████████████████░░░░  78%
156,121 / 200,000 tokens

───────────────────────────────────
in: 140,000  ·  out: 16,000  ·  cr: 0  ·  cw: 121

Updated 9:42:15 PM
```

## How it works

Claude Code writes session logs as `.jsonl` files under `~/.claude/projects/`. This extension watches that directory with VS Code's file system watcher — no polling interval, no delay. The moment Claude writes a response, the meter updates.

Token limit is auto-detected from the model name (Sonnet 4.5/4.6 → 1M tokens, everything else uses the `contextLimit` setting).

## Install

### From VSIX

1. Download the latest `.vsix` from [Releases](https://github.com/asjalik/claude-context-bar/releases)
2. In VS Code: `Extensions` → `···` → `Install from VSIX`

Or via terminal:
```bash
code --install-extension claude-context-meter-1.0.0.vsix
```

### Build from source

```bash
git clone https://github.com/asjalik/claude-context-bar.git
cd claude-context-bar
npm install
npx vsce package --allow-missing-repository
code --install-extension claude-context-meter-1.0.0.vsix
```

## Requirements

- VS Code 1.74+
- [Claude Code](https://claude.ai/code) CLI

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeContextBar.contextLimit` | `200000` | Fallback token limit when model is not auto-detected |
| `claudeContextBar.idleTimeout` | `180` | Seconds of inactivity before hiding a session |
| `claudeContextBar.warningThreshold` | `50` | % at which the bar turns yellow |
| `claudeContextBar.dangerThreshold` | `75` | % at which the bar turns red |
| `claudeContextBar.compactMode` | `false` | Abbreviate long project names (e.g. `my-cool-project` → `MCP`) |
| `claudeContextBar.showEmoji` | `true` | Show project emoji prefix |
| `claudeContextBar.autoColor` | `true` | Auto-assign a unique pastel color per project |
| `claudeContextBar.shortNames` | `{}` | Custom name overrides e.g. `{ "my-project": "MP" }` |

## License

MIT
