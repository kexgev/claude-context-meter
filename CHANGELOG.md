# Changelog

All notable changes to **Claude Context Meter** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] — 2026-08-20

### Added
- **Subscription usage meter.** A new status bar item showing your Claude plan's
  session (5-hour) and weekly limits — the same figures Claude Code's `/usage`
  command reports. It colors yellow then red as you approach a limit, and the
  hover lists every limit your plan reports along with its reset time.

  The data comes from Claude Code's own local usage cache in `~/.claude.json`.
  No sign-in, no token, no account access, and no network requests are involved.
  Because it is a cache it only refreshes while Claude Code is running, so a
  reading older than `usageStaleMinutes` is marked stale rather than presented
  as current. Users on an API key rather than a subscription have no usage data,
  and the item stays hidden for them.

- **Show Subscription Usage** command — lists every plan limit with its reset time.
- Four settings: `showUsage` (default `true`), `usageWarningThreshold` (`50`),
  `usageDangerThreshold` (`75`), and `usageStaleMinutes` (`30`).
- A one-time notification introducing the feature, with a "Turn off" action.

### Changed
- `CLAUDE_CONFIG_DIR` is honored when locating Claude Code's config, for setups
  that relocate it.

## [1.5.0] — 2026-08-20

### Fixed
- **Pricing was wrong for every current Claude model.** Cost and burn-rate figures
  are the headline feature, and they were computed from a stale rate table:
  - Opus was billed at `$15/$75` per MTok — the current Opus tier (4.5 through 5)
    is `$5/$25`. Costs were overstated roughly **3x**.
  - Haiku was billed at `$0.80/$4`; Haiku 4.5 is `$1/$5`.
  - Claude Fable 5 and Mythos 5 matched no pricing rule at all and silently fell
    back to Sonnet rates (`$3/$15`) instead of their actual `$10/$50`.
  - Legacy Opus 4.0/4.1 correctly retain the older `$15/$75` pricing.

### Added
- **Spend Summary** command — total cost across every session (active *and* idle)
  for Today, This Week, or All Time, broken down per project, with a
  copy-to-clipboard markdown table.
- **Daily budget alerts** — set `claudeContextMeter.dailyBudget` to a USD amount
  and get a single warning the first time the day's total crosses it. Re-arms at
  midnight. Set to `0` (the default) to disable.
- **Bedrock / Vertex AI / Foundry model IDs** are now displayed cleanly. IDs such
  as `anthropic.claude-opus-5-v1:0`, `us.anthropic.claude-opus-4-5-v1:0`, and
  `claude-opus-4-5@20251101` render as their plain model name in tooltips and
  copied stats. Pricing and context-window detection already handled these.
- **Show Diagnostics** command — reports the running extension version, detected
  model, resolved pricing tier, context limit, and transcript path. Useful when
  reporting an issue, and confirms which version is actually active.
- **Show Session Detail** is now available from the Command Palette. It was
  previously only reachable by clicking a status bar item.
- A one-time "what's new" notification after updating to a new version.

### Changed
- Model support now explicitly covers Claude Opus 5, Sonnet 5, Fable 5, Mythos 5,
  and Haiku 4.5. Unrecognised future Claude models continue to default to a 1M
  context window (200K for Haiku), so new releases keep working without an update.
- Documented that installing from a `.vsix` file *pins* the extension in VS Code,
  which disables automatic updates until you reinstall from the Marketplace.

## [1.4.0]

### Added
- Live session cost and burn rate in the status bar and tooltip.
- Click a status bar item to open a detail popup with per-session actions:
  Hide, Open transcript, Copy stats.

### Fixed
- Transcript file paths on Windows.
- Tooltip rendering and file-watcher reliability.

## [1.3.1]

### Added
- `bugs` and `homepage` URLs so the Marketplace listing shows Repository,
  Issues, and Homepage in its Resources sidebar. No runtime changes.

## [1.3.0]

### Added
- Claude Opus 4.8 support. Future Claude models now default to a 1M context
  window, so new releases work without an extension update.

### Fixed
- Resolved 8 high-severity vulnerabilities in devDependencies.

## [1.2.1]

### Fixed
- Opus 4.7 is now correctly detected as 1M context (previously fell back to
  the 200k default).
- Corrected the Sonnet 4.6 context window.
- Added Sonnet 4.7 detection.

## [1.2.0]

### Added
- Context window detection across all Claude model families.
- **Copy Context Stats** command — markdown table of all sessions to the clipboard.
- Threshold notifications (warning and critical, once per session).

### Fixed
- Warning state is marked as fired when a session crosses straight into critical.
- Clipboard write failures in the copy command are now handled.

## [1.1.0]

### Added
- Custom Claude Context Meter logo.

### Fixed
- Renamed all settings and commands from `claudeContextBar` to `claudeContextMeter`.

## [1.0.0]

- Initial release.

[1.6.0]: https://github.com/kexgev/claude-context-meter/releases/tag/v1.6.0
[1.5.0]: https://github.com/kexgev/claude-context-meter/releases/tag/v1.5.0
[1.4.0]: https://github.com/kexgev/claude-context-meter/releases/tag/v1.4.0
[1.3.1]: https://github.com/kexgev/claude-context-meter/releases/tag/v1.3.1
[1.3.0]: https://github.com/kexgev/claude-context-meter/releases/tag/v1.3.0
[1.2.1]: https://github.com/kexgev/claude-context-meter/releases/tag/v1.2.1
[1.2.0]: https://github.com/kexgev/claude-context-meter/releases/tag/v1.2.0
[1.1.0]: https://github.com/kexgev/claude-context-meter/releases/tag/v1.1.0
[1.0.0]: https://github.com/kexgev/claude-context-meter/releases/tag/v1.0.0
