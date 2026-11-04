// Ctrl+H/J/K/L: hand the key to Vim/Neovim when it has focus (its herdr_nav.lua
// moves between splits and calls pane.go at an edge), else move herdr pane focus.
// Port of vim-herdr-navigation. Docked as a 0px block: key commands reach shown mods only.

import { View, div } from "gpui-kit";
import { focused, terminals, hc, run, nextCommand } from "herdr";

const VIM = new Set(["nvim", "vim"]);
const KEY = { left: "ctrl+h", down: "ctrl+j", up: "ctrl+k", right: "ctrl+l" };

export default class VimNav extends View {
  init(_props, cx) {
    cx.spawn(async () => {
      for (;;) {
        const dir = await nextCommand();
        if (KEY[dir]) await this.navigate(dir);
      }
    });
  }

  async navigate(dir) {
    const address = focused()?.terminal;
    const term = address && terminals().find((t) => t.address === address);
    if (term && VIM.has(term.program?.key)) {
      await hc(["keys", address, KEY[dir]]);
    } else {
      run("pane.go", { direction: dir });
    }
  }

  render() {
    return div().size_full();
  }
}
