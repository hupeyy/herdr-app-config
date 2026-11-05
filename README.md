# herdr-app config

My setup for the Herdr desktop app (`herdr-app` + `herdr-core`), plus a Claude Code integration.
This folder is the live `~/.config/herdr-app`: Herdr redraws itself from it while it runs.
`.gitignore` is an allowlist. Herdr rewrites its shipped layouts and mods, its type files and
its state on every start, so only my files are tracked.

## Install

```sh
git clone https://github.com/hupeyy/herdr-app-config ~/.config/herdr-app   # before Herdr's first start
```

On an existing install, clone elsewhere and copy the tracked files in. Then pick the
`main-tasks` layout (`ctrl-shift-l`, or Settings).

`settings.json` plays `sounds/windows-notify.mp3` for agent alerts. That file is Microsoft's
Windows 8 notification sound, so it is not in this repo: download it into `sounds/` from
https://www.myinstants.com/en/instant/windows-8-8-1-notify-system-generic-9559/ or remove the
`done` / `blocked` keys to use Herdr's own sounds.

## Layouts

| Layout | What it is |
|---|---|
| `main-tasks` | The daily layout: a root-workspace strip, dev workspace cards, the Tasks rail, a usage status bar |
| `main-vimnav` | `main` with `ctrl-h/j/k/l` moving between panes, Neovim style (`vim-nav`) |

## Mods

| Mod | What it does |
|---|---|
| `space-tabs` | Top strip of root workspaces (a folder each); a click goes to the root's last dev workspace |
| `space-panel` | Sidebar cards, one per dev workspace (a Herdr space): tabs, panes and sub-agents, drag a tab to another card, Jira and GitHub buttons |
| `space-new` | New root or dev workspace dialog: folder, name, color, icon, shell or agent with a first message |
| `menu-spaces` | Right-click menu for cards: edit, lock, close |
| `tasks` | Jira and GitHub board and rail: my tickets, my PRs, review requests, detail views, **Start workspace** |
| `tabs-tasks` | Tab bar with a Tasks button next to Files and Changes, and window buttons |
| `pane-dev` | Pane header that shows a file tab's file |
| `files-dev`, `file-view` | File tree that opens files as tabs; editor tab that follows the disk and shows the git diff |
| `file-icons` | VS Code style icons (Material Icon Theme). `gen_icons.py` copies `icons.js` and `data.js` into each mod that draws them, because a mod cannot import from another mod's folder |
| `status-usage` | Status bar with Claude plan usage |
| `agents-space` | Agents list limited to the active space |
| `vim-nav` | `ctrl-h/j/k/l` pane moves for `main-vimnav` |

The `tasks` mod reads Jira credentials from `~/.config/jiratui/config.yaml` and GitHub through
the `gh` CLI. `status-usage` reads Claude Code's sign-in token from `~/.claude/.credentials.json`
and keeps it in memory. No credential is stored in this repo.

## Claude Code integration

`claude/herdr-resume.ps1` (Windows PowerShell) does two things.

**Resume after a reboot.** Herdr's core brings a lost terminal (reboot, logout, core crash)
back as an empty shell with the same address and labels, and it does not re-run the program.
The script stores each Claude session on its terminal as `hc` labels (`claude.session`,
`claude.mode`, `claude.cwd`), and the recovered shell resumes it.

```jsonc
// ~/.claude/settings.json
"SessionStart": [{ "hooks": [{ "type": "command",
  "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"<home>/.config/herdr-app/claude/herdr-resume.ps1\" start" }] }],
"SessionEnd":   [{ "hooks": [{ "type": "command",
  "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"<home>/.config/herdr-app/claude/herdr-resume.ps1\" end" }] }]
```

```powershell
# $PROFILE
if ($env:HC_TERMINAL_ID) { & "$env:USERPROFILE\.config\herdr-app\claude\herdr-resume.ps1" shell }
```

- Quitting Claude yourself (`/exit`, Ctrl+C) clears the record, so that pane stays a shell.
- Only the interactive session that owns the pane is recorded. Background jobs inherit
  `HC_TERMINAL_ID`, and they are skipped.
- Only the terminal's root shell resumes. A nested `powershell` does not.

**Claude in a shell pane.** Claude started from a shell reports itself to Herdr only while it
works, so an idle one showed the shell icon. `space-panel`, `pane-dev` and `tabs-tasks` treat a
shell pane with a `claude.session` label as Claude. `space-panel` also reads each session's
transcript (`space-panel/scan-work.mjs`) for the tickets it created or was handed and the PRs it
opened or reviewed. The card's Jira and GitHub buttons open all of them.

## Pokémon

Each dev workspace card shows a Poké Ball and its own Pokémon, after
[mathieucroset/herdr-pokemon-agents](https://github.com/mathieucroset/herdr-pokemon-agents) (MIT).
A new dev workspace gets a random one; the Edit dialog picks another (all 1,025, searchable).
The art is downloaded on first use into `data/pokemon-icons/` and is not in this repo:
animated idle sprites from [PMDCollab/SpriteCollab](https://github.com/PMDCollab/SpriteCollab)
(Pokémon Mystery Dungeon style pixel art by the SpriteCollab contributors, licensed
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/); each sprite's artists are listed in
that repo's `tracker.json` and `credit_names.txt`). 987 Pokémon have one (a few through a form,
`mods/space-panel/pmd-paths.json`). The other 38 get an idle generated in the same style by
`mods/space-panel/tools/pmd-style` (Python with Pillow and numpy): it measures how SpriteCollab idles
relate to the Black/White sprites and animations of Pokémon that have both, then builds one from
the Pokémon's Showdown sprites (`generate.py make <dex...>`, into `data/`, not this repo). Until
then they show a still menu icon from [PokeAPI/sprites](https://github.com/PokeAPI/sprites). herdr does not play GIFs reliably, so
`pmd-frames.ps1` splits each card's sheet into frames once and the cards swap them on one shared
8 fps clock. Names
from [PokeAPI](https://pokeapi.co). Pokémon and all related names are trademarks of Nintendo,
Creatures and GAME FREAK. This is an unofficial fan mod.

The Poké Ball is the classic 12-pixel sprite (seen from a little above), drawn from maps in
`mods/space-panel/pokeball-anim.ps1`: still when idle, popping open (closed, half open, open) on repeat when
an agent needs input, rocking one way, the other way, then bouncing while an agent works, and
turning flat about its centre with circling streaks while an agent's shell runs. Earlier
looks (a flat front view, the three-quarter PokeAPI sprite) are kept in `mods/space-panel/archive`.