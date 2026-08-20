# Claude Context Meter

A minimal VS Code extension that shows your Claude Code token usage as an ASCII progress bar directly in the status bar — updates instantly via file watcher, zero polling. Also shows live cost and burn rate per session.

## What's new in 1.5.0

**Pricing is now correct for current Claude models.** The old rate table billed Opus at `$15/$75` per MTok — the current Opus tier (4.5 through 5) is `$5/$25`, so costs were overstated roughly **3x**. Haiku and the new Fable 5 / Mythos 5 tier were wrong too. If you've been reading this extension's cost figures, they were high.

Also added:
- **Spend Summary** — total cost across every session for Today / This Week / All Time, per project, copyable as markdown
- **Daily budget alerts** — one warning when the day's spend crosses a threshold you set
- **Claude Opus 5, Sonnet 5, Fable 5, Mythos 5, Haiku 4.5** explicitly supported
- **Bedrock / Vertex AI / Foundry model IDs** display cleanly
- **Show Diagnostics** command — confirms which version is actually running and why a cost looks the way it does

Full history in the [changelog](CHANGELOG.md).

## Status bar

```
🤖 my-project ███░░ 156k/200k (78%) ~$1.20 🔥2.1k/m
```

The bar fills as your context fills. After the percentage it shows the running session **cost** (`~$1.20`) and the recent **burn rate** (`🔥2.1k/m` = ~2,100 tokens/min). Color changes automatically:
- Default — under warning threshold
- **Yellow** — above warning (default 50%)
- **Red** — above danger threshold (default 75%)

You also get a warning/critical notification the first time a session crosses each threshold.

## Click actions

Click a meter to open a quick menu for that session:
- **Hide** — dismiss this meter until the session has new activity
- **Open transcript** — open the session's `.jsonl` log
- **Copy stats** — copy this session's stats as a markdown row

## Tooltip (hover)

```
my-project

`claude-sonnet-4-6`  ·  🟡 warn · 78%

████████████████░░░░  78%
156,121 / 200,000 tokens

───────────────────────────────────
in: 140,000  ·  out: 16,000  ·  cr: 0  ·  cw: 121

🔥 recent: ~2.1k/min  ·  avg: ~2.1k/min
⏳ ~21 min to full

💰 cost: $1.20  (in: $0.42 · out: $0.24)

Updated 9:42:15 PM
```

## Commands

Available from the Command Palette (`Ctrl/Cmd+Shift+P`):
- **Claude Context Meter: Copy Context Stats** — copy a markdown table of all active sessions to the clipboard
- **Claude Context Meter: Show Spend Summary** — pick Today / This Week / All Time and see total cost across every session (active or idle), with a per-project breakdown you can copy as markdown
- **Claude Context Meter: Show Session Detail** — same quick menu you get by clicking a status bar item (Hide / Open transcript / Copy stats)
- **Claude Context Meter: Show Diagnostics** — running version, detected model, resolved pricing tier and rates, context limit, and transcript paths. Handy when reporting an issue

## Budget alerts

Set `claudeContextMeter.dailyBudget` to a USD amount and you'll get a one-time warning notification the first time that day's total spend (across all sessions) crosses it. Re-arms automatically at midnight. Default `0` disables it.

## How it works

Claude Code writes session logs as `.jsonl` files under `~/.claude/projects/`. This extension watches that directory with VS Code's file system watcher — no polling interval, no delay. The moment Claude writes a response, the meter updates.

Token limit is auto-detected from the model name:

| Model | Context |
|---|---|
| Claude Opus 5, Claude Fable 5 / Mythos 5, Opus 4.5/4.6/4.7/4.8, Sonnet 5, Sonnet 4.5/4.6/4.7, and any future Opus/Sonnet | 1M tokens |
| All Haiku models (4.5, 3.5, 3) | 200k tokens |
| Legacy Claude 3 / 3.5 Sonnet & Opus | 200k tokens |

New Claude releases default to 1M unless they are Haiku — no extension update required. Cost is priced per model tier and kept current as Anthropic ships new pricing.

Also works with Bedrock, Vertex AI, and Foundry-style model IDs (e.g. `anthropic.claude-opus-5-v1:0`, `claude-opus-4-5@20251101`) — pricing, context detection, and the tooltip's cleaned-up model name all handle the provider prefixes/suffixes.

Unrecognized non-Claude models fall back to the `contextLimit` setting.

## Install

### From the Marketplace (recommended)

Install **[Claude Context Meter](https://marketplace.visualstudio.com/items?itemName=Kexgev.claude-context-meter)** from the VS Code Marketplace, or search "Claude Context Meter" in the Extensions panel (`Ctrl/Cmd+Shift+X`). Updates arrive automatically.

### From VSIX

Use this if you're on VSCodium, Cursor, or another build without Marketplace access — or if you're testing a pre-release build.

1. Download the latest `.vsix` from [Releases](https://github.com/kexgev/claude-context-meter/releases)
2. In VS Code: `Extensions` → `···` → `Install from VSIX`
3. **Click "Reload Now"** when prompted, or run `Developer: Reload Window`. Without a reload the old version keeps running and the install looks like it did nothing.

Or via terminal:
```bash
code --install-extension claude-context-meter-1.5.0.vsix --force
```

> **Heads up:** VS Code *pins* extensions installed from a `.vsix`, which turns off
> automatic updates for them. You'll stay on that exact version until you update by
> hand. To go back to automatic updates, install the Marketplace copy instead — note
> this is the extension **ID**, not a file path:
>
> ```bash
> code --install-extension kexgev.claude-context-meter
> ```

Run **Claude Context Meter: Show Diagnostics** from the Command Palette at any time to confirm which version is actually active.

### Build from source

```bash
git clone https://github.com/kexgev/claude-context-meter.git
cd claude-context-meter
npm install
npx vsce package --allow-missing-repository
code --install-extension claude-context-meter-1.5.0.vsix --force
```

On Windows, `./scripts/install-local.ps1` does the build, install, registration check, and stale-folder cleanup in one step.

## Requirements

- VS Code 1.74+
- [Claude Code](https://claude.ai/code) CLI

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeContextMeter.contextLimit` | `200000` | Fallback token limit when model is not auto-detected |
| `claudeContextMeter.idleTimeout` | `180` | Seconds of inactivity before hiding a session |
| `claudeContextMeter.warningThreshold` | `50` | % at which the bar turns yellow |
| `claudeContextMeter.dangerThreshold` | `75` | % at which the bar turns red |
| `claudeContextMeter.compactMode` | `false` | Abbreviate long project names (e.g. `my-cool-project` → `MCP`) |
| `claudeContextMeter.showEmoji` | `true` | Show project emoji prefix |
| `claudeContextMeter.autoColor` | `true` | Auto-assign a unique pastel color per project |
| `claudeContextMeter.shortNames` | `{}` | Custom name overrides e.g. `{ "my-project": "MP" }` |
| `claudeContextMeter.dailyBudget` | `0` | Daily spend alert threshold in USD across all sessions (`0` = disabled) |

## License

MIT
