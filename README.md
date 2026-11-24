# Claude Code Usage Meter

A VS Code extension that puts your Claude Code usage in the status bar: subscription 5-hour and weekly limits, context window fill, cost, and burn rate — updating live via file watcher, no polling.

## What's new in 2.1.3

**The usage meter stays current.** A single failed refresh no longer drops the meter back to a day-old cached reading: it keeps the newest reading it has and shows its real age. Rate-limited requests (HTTP 429) back off instead of retrying every minute, all open VS Code windows share one request, and the tooltip says why a live refresh is failing. See the [changelog](CHANGELOG.md#213--2026-11-24).

### 2.1.2

**Current models, priced and sized correctly.** Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5 are all supported, with their own prices and 1M context windows. Cost now accounts for 1-hour cache writes and fast mode. Context windows for older models match what Claude Code uses. See the [model table](#how-it-works-1) and the [changelog](CHANGELOG.md#212--2026-11-14).

The context percentage now counts input and cache tokens only, matching Claude Code's own figure, and the session limit is labelled **5-hour**, as Claude Code now calls it.

**Subscription usage** shows your Claude 5-hour and weekly limits in the status bar, matching what `/usage` reports in Claude Code:

```
⏱ Usage 45% · 6%w        🤖 my-project ███░░ 16% ~$1.20 🔥2.1k/m
```

Crossing a threshold raises a one-time notification, so a cap that stops your work doesn't arrive unannounced. Full history in the [changelog](CHANGELOG.md).

## Status bar

```
🤖 my-project ████░ 780k/1M (78%) ~$0.39 🔥2.1k/m
```

The bar fills as your context fills. After the percentage it shows the running session **cost** (`~$0.39`) and the recent **burn rate** (`🔥2.1k/m` = ~2,100 tokens/min). Color changes automatically:
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

`claude-opus-5-5`  ·  🟡 warn · 78%

████████████████░░░░  78%
780,002 / 1,000,000 tokens

───────────────────────────────────
in: 2  ·  out: 4,000  ·  cr: 760,000  ·  cw: 20,000

🔥 recent: ~2.1k/min  ·  avg: ~2.1k/min
⏳ ~105 min to full

💰 cost: $0.39  (in: $0.00 · out: $0.08)

Updated 9:42:15 PM
```

## Subscription usage

```
⏱ Usage 45% · 6%w
```

Shows how much of your Claude plan you've used: the 5-hour window and the weekly limit (the `w` figure is your highest weekly limit, including per-model ones like Fable), matching what `/usage` reports in Claude Code. Bars run blue while you have room, amber past `usageWarningThreshold`, and red past `usageDangerThreshold`; the status bar item picks up a matching warning or error background. Hovering shows your plan (Pro, Max (5x), Max (20x), Team, Enterprise) and every limit it reports, including per-model weekly limits such as Fable, labelled with the model name the server sends:

```
Claude subscription usage  ·  Max (5x)

5-hour  ·  🟢 safe

🟦🟦🟦🟦🟦⬜⬜⬜⬜⬜  45% used
Resets 7:39pm

Week (all models)  ·  🟢 safe

🟦⬜⬜⬜⬜⬜⬜⬜⬜⬜  6% used
Resets Aug 24, 3:59pm

Week (Fable)  ·  🟢 safe

🟦⬜⬜⬜⬜⬜⬜⬜⬜⬜  2% used
Resets Aug 24, 3:59pm

───────────────────────────────────
Updated 2 min ago
```

Crossing a threshold raises a one-time notification per limit, so a cap that stops your work doesn't arrive unannounced. Each limit alerts at most once per window and re-arms when that window resets. Alerts only fire on fresh live readings — a stale figure never triggers one.

### How it works

Usage is read from `GET /api/oauth/usage` — the same request Claude Code makes for its own `/usage` command — authenticated with the sign-in token Claude Code already stores on this machine (`~/.claude/.credentials.json`; on macOS, where Claude Code keeps it in the login Keychain, the `Claude Code-credentials` Keychain item — macOS may ask once to allow access). The token is used only as that request's `Authorization` header, is sent only to Anthropic, and is never stored or logged by the extension. The plan name comes from two non-secret fields in the same record (`subscriptionType`, `rateLimitTier`). Refreshes every `usageRefreshInterval` seconds (default 60). All open VS Code windows share one request per interval through a small file in the extension's global storage (usage percentages and timestamps only, never the token). If the endpoint answers HTTP 429, polling pauses for its `Retry-After`, or 5 minutes doubling up to an hour.

When a refresh fails — offline, rate-limited, expired token, proxy or firewall, or the endpoint changing — the meter keeps the newest reading it has: the last live one, or Claude Code's own cache in `~/.claude.json`. **That cache refreshes rarely**: it has been observed sitting over 30 minutes stale, reporting 45% while actual usage was 85%, and newer Claude Code versions may not write it at all. So every reading shows its real age, is flagged with `⚠` once older than `usageStaleMinutes`, and the tooltip and the **Claude Code Usage Meter** output channel say why the live refresh is failing.

> [!WARNING]
> Claude Code 2.1.325 was observed not writing this cache at all. On such versions the meter can only keep its last live reading (marked stale as it ages); if no live request has succeeded yet, the usage item stays hidden until one does.

To avoid network requests entirely, set `claudeContextMeter.usageLiveFetch` to `false`. Usage then comes from the local cache alone — accepting that it will often be out of date, or missing on Claude Code versions that no longer write it.

> **Note:** this endpoint is undocumented. It may change or stop working at Anthropic's discretion, in which case the meter falls back to the cache rather than erroring.

If you use an API key rather than a Claude subscription there is no usage data, and the item simply doesn't appear. Set `claudeContextMeter.showUsage` to `false` to turn it off completely — the extension then neither reads the sign-in token nor makes any request.

## Commands

Available from the Command Palette (`Ctrl/Cmd+Shift+P`):
- **Claude Code Usage Meter: Copy Context Stats** — copy a markdown table of all active sessions to the clipboard
- **Claude Code Usage Meter: Show Spend Summary** — pick Today / This Week / All Time and see total cost across every session (active or idle), with a per-project breakdown you can copy as markdown
- **Claude Code Usage Meter: Show Session Detail** — same quick menu you get by clicking a status bar item (Hide / Open transcript / Copy stats)
- **Claude Code Usage Meter: Show Subscription Usage** — list every plan limit with its reset time
- **Claude Code Usage Meter: Show Diagnostics** — running version, detected model, resolved pricing tier and rates, context limit, and transcript paths. Handy when reporting an issue

## Budget alerts

Set `claudeContextMeter.dailyBudget` to a USD amount and you'll get a one-time warning notification the first time that day's total spend (across all sessions) crosses it. Re-arms automatically at midnight. Default `0` disables it.

## How it works

Claude Code writes session logs as `.jsonl` files under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/` when that variable is set). This extension watches that directory with VS Code's file system watcher — no polling interval, no delay. The moment Claude writes a response, the meter updates.

Token limit is auto-detected from the model name:

| Model | Context |
| :--- | :--- |
| Fable 5.2 / 5.1 / 5 (and Mythos), Opus 5.5 / 5 / 4.8 / 4.7, Sonnet 5.5 / 5, Haiku 5.5, any future Claude model | 1M tokens |
| Opus 4.6, Sonnet 4.6 | 200k tokens (1M with the `[1m]` suffix) |
| Opus 4 / 4.1 / 4.5, Sonnet 4 / 4.5, Haiku 4.5 | 200k tokens |
| Claude 3 / 3.5 / 3.7 (all families) | 200k tokens |

New versions of the Opus, Sonnet, Haiku and Fable families default to 1M — no extension update required. A session that grows past a 200k window is promoted to 1M automatically.

Model IDs that name no known family, such as a gateway alias like `claude-sonnet-latest` or a non-Claude model, use the `contextLimit` setting (default 200k, the window Claude Code assumes for them), or 1M when the ID ends in `[1m]`.

When VS Code was started from an environment that sets Claude Code's context variables, the meter follows the same rules as Claude Code:

| Variable | Effect |
| :--- | :--- |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` | Caps every model at 200k |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Sets the window for unrecognised IDs; for known models only when `DISABLE_COMPACT` is also set |

The context figure counts input, cache-read and cache-write tokens, the same way Claude Code's own context percentage does; output tokens count toward cost only.

Cost is priced per model:

| Model | Input | Output | Cache read | Cache write 5m / 1h |
| :--- | ---: | ---: | ---: | ---: |
| Fable 5.2 / Mythos 5.2 | $8 | $40 | $0.20 | $10 / $16 |
| Opus 5.5 | $4 | $20 | $0.20 | $5 / $8 |
| Sonnet 5.5 | $2 | $10 | $0.10 | $2.50 / $4 |
| Sonnet 5 | $2 | $10 | $0.20 | $2.50 / $4 |
| Haiku 5.5 (prompt ≤ 100k) | $0.10 | $0.50 | $0.01 | $0.125 / $0.20 |
| Haiku 5.5 (prompt > 100k) | $0.50 | $2.50 | $0.05 | $0.625 / $1 |

Prices are USD per million tokens. Older models keep their own rates. Cache writes are split by TTL using the transcript's `cache_creation` breakdown (Claude Code writes 1-hour entries), and fast-mode turns are billed at 2x. Unrecognised models are priced as Opus 5.5.

Also works with Bedrock, Vertex AI, gateway and Foundry-style model IDs (e.g. `global.anthropic.claude-fable-5-2`, `anthropic.claude-opus-5-v1:0`, `claude-opus-4-5@20251101`, `claude-opus-4.8`) — pricing, context detection, and the tooltip's cleaned-up model name all handle the provider prefixes/suffixes.

## Install

### From the Marketplace (recommended)

Install **[Claude Code Usage Meter](https://marketplace.visualstudio.com/items?itemName=Kexgev.claude-context-meter)** from the VS Code Marketplace, or search "Claude Code Usage Meter" in the Extensions panel (`Ctrl/Cmd+Shift+X`). Updates arrive automatically.

### From VSIX

Use this if you're on VSCodium, Cursor, or another build without Marketplace access — or if you're testing a pre-release build.

1. Download the latest `.vsix` from [Releases](https://github.com/kexgev/claude-context-meter/releases)
2. In VS Code: `Extensions` → `···` → `Install from VSIX`
3. **Click "Reload Now"** when prompted, or run `Developer: Reload Window`. Without a reload the old version keeps running and the install looks like it did nothing.

Or via terminal:
```bash
code --install-extension claude-context-meter-2.1.3.vsix --force
```

> **Heads up:** VS Code *pins* extensions installed from a `.vsix`, which turns off
> automatic updates for them. You'll stay on that exact version until you update by
> hand. To go back to automatic updates, install the Marketplace copy instead — note
> this is the extension **ID**, not a file path:
>
> ```bash
> code --install-extension kexgev.claude-context-meter
> ```

Run **Claude Code Usage Meter: Show Diagnostics** from the Command Palette at any time to confirm which version is actually active.

### Build from source

```bash
git clone https://github.com/kexgev/claude-context-meter.git
cd claude-context-meter
npm install
npx vsce package --allow-missing-repository
code --install-extension claude-context-meter-2.1.3.vsix --force
```

On Windows, `./scripts/install-local.ps1` does the build, install, registration check, and stale-folder cleanup in one step.

## Requirements

- VS Code 1.74+
- [Claude Code](https://claude.ai/code) CLI

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeContextMeter.contextLimit` | `200000` | Context window for unrecognised model IDs (gateway aliases, non-Claude models) |
| `claudeContextMeter.idleTimeout` | `180` | Seconds of inactivity before hiding a session |
| `claudeContextMeter.warningThreshold` | `50` | % at which the bar turns yellow |
| `claudeContextMeter.dangerThreshold` | `75` | % at which the bar turns red |
| `claudeContextMeter.compactMode` | `false` | Abbreviate long project names (e.g. `my-cool-project` → `MCP`) |
| `claudeContextMeter.showEmoji` | `true` | Show project emoji prefix |
| `claudeContextMeter.autoColor` | `true` | Auto-assign a unique pastel color per project |
| `claudeContextMeter.shortNames` | `{}` | Custom name overrides e.g. `{ "my-project": "MP" }` |
| `claudeContextMeter.dailyBudget` | `0` | Daily spend alert threshold in USD across all sessions (`0` = disabled) |
| `claudeContextMeter.showUsage` | `true` | Show Claude subscription usage (5-hour and weekly limits) |
| `claudeContextMeter.usageWarningThreshold` | `50` | Subscription usage % at which the meter turns yellow |
| `claudeContextMeter.usageDangerThreshold` | `75` | Subscription usage % at which the meter turns red |
| `claudeContextMeter.usageStaleMinutes` | `30` | Minutes after which a usage reading (live or cached) is marked stale |
| `claudeContextMeter.usageLiveFetch` | `true` | Fetch current usage from Anthropic. `false` uses the local cache only, with no network requests |
| `claudeContextMeter.usageRefreshInterval` | `60` | Seconds between usage refreshes |

## License

MIT
