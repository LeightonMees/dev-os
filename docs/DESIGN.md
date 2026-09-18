# Design system

DEV's interface is a workshop instrument panel for one engineer: dense, quiet, legible at a glance, honest about state. It borrows the *structure* of mature developer tools (activity rail, contextual sidebar, workspace, inspector, bottom panel, status bar) and none of their skins.

## Direction

- **Subject**: orchestration of real development work on this machine. Everything on screen is system state; nothing decorative.
- **Memorable element**: the Work graph, a layered dependency map of the milestone with live execution state. Everything else stays quiet.
- **Not this**: black + purple + cyan, cards everywhere, gradients, glass, uppercase eyebrows, middle-dot meta strings, fake metrics.

## Tokens

Palette, warm graphite with one brass accent:

| Token | Value | Use |
|---|---|---|
| `--ink-0` | `#141618` | window ground, terminal |
| `--ink-1` | `#1b1e22` | sidebars, panels |
| `--ink-2` | `#22262b` | rows, inputs |
| `--ink-3` | `#2b3036` | hover, selected |
| `--rule` | `#31373e` | separators |
| `--rule-2` | `#414850` | strong borders |
| `--text` | `#e3e1dc` | body |
| `--text-2` | `#a9aaa6` | secondary |
| `--text-3` | `#6f736f` | tertiary, labels |
| `--brass` | `#d3a95e` | focus, selection, active worker, primary action |

Semantic status, always paired with a symbol or word, never colour alone:

| State | Colour | Symbol |
|---|---|---|
| backlog | `#7d838b` | ○ |
| ready | `#7fa7c9` | ◔ |
| working | `#d3a95e` (pulsing) | ▶ |
| blocked | `#d9705f` | ■ |
| review | `#b39ddb` | ◆ |
| done | `#7fb98a` | ● |
| cancelled | `#5b6168` | × |

Type:

- Display and labels: **Bahnschrift** (Windows-native DIN derivative), semi-condensed, 11–13px, sentence case, letter-spacing 0.01em. Carries the panel identity.
- Body: Segoe UI Variable Text, 12.5px / 1.45.
- Mono: Cascadia Code → Consolas, 11.5–12.5px, for ids, paths, commands, output, timestamps.
- Scale: 11 / 12.5 / 13.5 / 16 / 20. No larger headings; the window title bar already says DEV.

Spacing on a 4px grid: 4, 8, 12, 16, 24. Row height 26px in tables and trees. Panel padding 8–12px. Radius 3px on inputs and pills, 0 on panels.

## Layout

```
┌─┬───────────┬──────────────────────────────┬────────────┐
│A│ sidebar   │ workspace                    │ inspector  │
│c│ (context) │                              │ (optional) │
│t│           │                              │            │
│ ├───────────┴──────────────────────────────┴────────────┤
│ │ bottom panel: Activity | Output | Checks | Problems   │
├─┴───────────────────────────────────────────────────────┤
│ status bar                                              │
└─────────────────────────────────────────────────────────┘
```

Left aligned throughout. Structure is drawn with 1px rules and tone, not boxes. Panels resize with gutters and remember their size.

## Principles

1. Every number on screen is read from the control plane. No estimates dressed as facts.
2. Status is shown three ways where it matters: word, symbol, colour.
3. A control that cannot act is absent or disabled with a reason in its tooltip.
4. Motion answers the user or marks live work (the working pulse). `prefers-reduced-motion` turns it off.
5. Empty states tell you the next command. Errors say what failed and what to do.
6. Terms a learner meets for the first time (worker, adapter, dependency, evidence, context budget, PTY, MCP) carry a short definition on hover.
