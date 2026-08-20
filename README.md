# Claude Context Meter

A minimal VS Code extension that shows your Claude Code token usage as an ASCII progress bar directly in the status bar — updates instantly via file watcher, zero polling. Also shows live cost and burn rate per session.

## What's new in 1.6.0

**Subscription usage.** The meter now shows your Claude session (5-hour) and weekly limits right in the status bar — the same numbers `/usage` reports in Claude Code.

```
⏱ Usage 45% · 6%w        🤖 my-project ███░░ 16% ~$1.20 🔥2.1k/m
```

It reads Claude Code's own local usage cache, so there is **no account access, no sign-in, and no network requests**. Hover for every limit with its reset time. See [Subscription usage](#subscription-usage) below.

Earlier in 1.5.0: corrected pricing for current Claude models, spend summaries, and daily budget alerts — full history in the [changelog](CHANGELOG.md).

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

## Subscription usage

```
⏱ Usage 45% · 6%w
```

Shows how much of your Claude plan you've used: the session (5-hour) window and the weekly limit, matching what `/usage` reports in Claude Code. The item colors yellow then red as you approach your limits, and hovering shows every limit your plan reports:

```
Claude subscription usage

Session  ·  🟡 warn

█████████░░░░░░░░░░░  45%
Resets 7:39pm

Week (all models)  ·  🟢 safe

█░░░░░░░░░░░░░░░░░░░  6%
Resets Aug 24, 3:59pm

───────────────────────────────────
Updated 2 min ago
```

**How it works.** Claude Code keeps a local cache of your usage in `~/.claude.json`; this extension reads that file. There is no sign-in, no token, no account access, and no network request — it is the same local-file approach used for the context meter itself.

Because it is a cache, it only refreshes while Claude Code is running. If a reading gets old it is marked stale (`⚠`) rather than shown as though it were current; `usageStaleMinutes` controls that cutoff.

If you use an API key rather than a Claude subscription, there is no usage data and the item simply doesn't appear. Set `claudeContextMeter.showUsage` to `false` to hide it.

## Commands

Available from the Command Palette (`Ctrl/Cmd+Shift+P`):
- **Claude Context Meter: Copy Context Stats** — copy a markdown table of all active sessions to the clipboard
- **Claude Context Meter: Show Spend Summary** — pick Today / This Week / All Time and see total cost across every session (active or idle), with a per-project breakdown you can copy as markdown
- **Claude Context Meter: Show Session Detail** — same quick menu you get by clicking a status bar item (Hide / Open transcript / Copy stats)
- **Claude Context Meter: Show Subscription Usage** — list every plan limit with its reset time
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
code --install-extension claude-context-meter-1.6.0.vsix --force
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
code --install-extension claude-context-meter-1.6.0.vsix --force
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
| `claudeContextMeter.showUsage` | `true` | Show Claude subscription usage (session and weekly limits) |
| `claudeContextMeter.usageWarningThreshold` | `50` | Subscription usage % at which the meter turns yellow |
| `claudeContextMeter.usageDangerThreshold` | `75` | Subscription usage % at which the meter turns red |
| `claudeContextMeter.usageStaleMinutes` | `30` | Minutes after which a cached usage reading is marked stale |

## License

MIT
