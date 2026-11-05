# Poké Ball looks kept for later

`space-panel` draws the card's Poké Ball with `../pokeball-anim.ps1`. Earlier looks are kept here
and in git history so any can come back.

| Look | Where |
|---|---|
| Shell spin on the vertical axis: the button rides the band, streaks orbit a tilted ring | commit `6f697be` |
| Flat front view, 16 px, band straight across (v15) | `pokeball-anim-flat-front.ps1` (commit `bb92025`) |
| Three-quarter PokeAPI sprite, open ball modelled in 3D (lid turns about the hinge opposite the button) | `pokeball-anim-isometric.ps1` |
| Three-quarter PokeAPI sprite, half-open lid tipped flat on screen | `pokeball-anim-isometric-tilted-lid.ps1` (commit `f50e862`) |
| Three-quarter sprite, lid swung far back on a hinge | commit `3a6c632` |
| Three-quarter sprite, open ball showing its inside, lid upright | commit `cf7ed0e` |
| Shell spin: y-axis squash (thin line edge-on) | commit `4042031` |
| Flat red-and-white ball, hop and rock in one cycle | commit `8e4a126` |
| Separate rock and bounce, switched by clicking the ball | commit `35f79ed` |

The scripts take the same arguments as the current one: `-Dir`, `-Version`, and for the
three-quarter ones `-Sprite` (PokeAPI's `items/poke-ball.png`) and `-LidAngle`. To bring one
back, copy it over `../pokeball-anim.ps1`, pass `-Sprite` from `makeBallFrames` in `../main.js`,
and bump `BALL_VERSION` there (herdr caches images by file name).

Rendered frames of the three-quarter set are kept locally, outside the repo (they are drawn from
PokeAPI's sprite), in `~/.config/herdr-app/data/pokemon-icons/archive/isometric/`.
