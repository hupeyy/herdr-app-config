"""Builds ~/.config/herdr-app/mods/file-icons from the material-icon-theme npm package."""
import json, os, shutil, sys

pkg, out = sys.argv[1], sys.argv[2]
m = json.load(open(os.path.join(pkg, "dist", "material-icons.json"), encoding="utf-8"))
defs = {k: os.path.basename(v["iconPath"])[:-4] for k, v in m["iconDefinitions"].items()}

def resolve(table):
    return {k.lower(): defs[v] for k, v in table.items() if v in defs}

data = {
    "file": defs[m["file"]], "folder": defs[m["folder"]], "folderOpen": defs[m["folderExpanded"]],
    "ext": resolve(m["fileExtensions"]), "names": resolve(m["fileNames"]), "langs": resolve(m["languageIds"]),
    "folders": resolve(m["folderNames"]), "foldersOpen": resolve(m["folderNamesExpanded"]),
    "light": {k: resolve(m["light"].get(k, {})) for k in ("fileExtensions", "fileNames", "languageIds", "folderNames", "folderNamesExpanded")},
}

os.makedirs(out, exist_ok=True)
icons = os.path.join(out, "icons")
if os.path.isdir(icons):
    shutil.rmtree(icons)
shutil.copytree(os.path.join(pkg, "icons"), icons)
shutil.copy(os.path.join(pkg, "LICENSE"), os.path.join(out, "LICENSE"))
with open(os.path.join(out, "data.js"), "w", encoding="utf-8", newline="\n") as f:
    f.write("// Generated from material-icon-theme %s (MIT, see LICENSE). Do not edit: rerun gen_icons.py.\n" % json.load(open(os.path.join(pkg, "package.json"), encoding="utf-8"))["version"])
    f.write("export default " + json.dumps(data, separators=(",", ":")) + ";\n")
print("icons", len(os.listdir(icons)), "data.js", os.path.getsize(os.path.join(out, "data.js")))

# Mods cannot import across mod folders, so each user gets its own copy as file-icons/*.js.
for mod in ("file-view", "files-dev", "pane-dev", "space-panel"):
    dest = os.path.join(os.path.dirname(out), mod, "file-icons")
    os.makedirs(dest, exist_ok=True)
    for name in ("icons.js", "data.js"):
        shutil.copy(os.path.join(out, name), os.path.join(dest, name))
    print("copied to", mod)
