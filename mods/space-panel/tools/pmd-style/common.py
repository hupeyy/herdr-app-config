# Shared helpers: names, downloads (cached), SpriteCollab idle frames, GIF frames, measurements.
import io, json, os, re, unicodedata, urllib.request, xml.etree.ElementTree as ET
import numpy as np
from PIL import Image, ImageSequence

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
PATHS = os.path.join(HERE, "..", "..", "pmd-paths.json")
NAMES_JS = os.path.join(HERE, "..", "..", "pokemon-names.js")
PMD = "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/sprite"
SD = "https://play.pokemonshowdown.com/sprites"

src = open(NAMES_JS, encoding="utf-8").read()
NAMES = json.loads("[" + src.split("export const NAMES = [")[1].split("];")[0].rstrip().rstrip(",") + "]")


def sid(name):
    n = unicodedata.normalize("NFD", name.replace("♀", "f").replace("♂", "m"))
    return re.sub(r"[^a-z0-9]", "", "".join(c for c in n if not unicodedata.combining(c)).lower())


def fetch(url, name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if os.path.exists(path):
        return open(path, "rb").read() or None
    try:
        data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "herdr-app"}), timeout=30).read()
    except Exception:
        data = b""
    open(path, "wb").write(data)
    return data or None


def rgba(data):
    return np.array(Image.open(io.BytesIO(data)).convert("RGBA"))


def crop_union(frames):
    boxes = [Image.fromarray(f).getbbox() for f in frames]
    boxes = [b for b in boxes if b]
    x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
    return [f[y0:y1, x0:x1] for f in frames]


def pmd_idle(dex, path=None):
    # SpriteCollab idle facing the viewer: (frames cropped to their union box, delays in ms).
    path = path or str(dex).zfill(4)
    key = path.replace("/", "_")
    xml = fetch(f"{PMD}/{path}/AnimData.xml", f"pmd_{key}.xml")
    if not xml:
        return None
    root = ET.fromstring(xml)
    a = next((x for x in root.iter("Anim") if x.findtext("Name") == "Idle"), None)
    if a is None:
        return None
    if a.find("CopyOf") is not None:
        a = next(x for x in root.iter("Anim") if x.findtext("Name") == a.findtext("CopyOf"))
    fw, fh = int(a.findtext("FrameWidth")), int(a.findtext("FrameHeight"))
    du = [round(int(d.text) * 1000 / 60) for d in a.find("Durations")]
    sheet = fetch(f"{PMD}/{path}/{a.findtext('Name')}-Anim.png", f"pmd_{key}_{a.findtext('Name')}.png")
    s = rgba(sheet)
    frames = [s[0:fh, i * fw:(i + 1) * fw] for i in range(len(du))]
    return crop_union(frames), du


def still(dex):
    d = fetch(f"{SD}/gen5/{sid(NAMES[dex - 1])}.png", f"g5_{dex}.png")
    if not d:
        return None
    a = rgba(d)
    b = Image.fromarray(a).getbbox()
    return a[b[1]:b[3], b[0]:b[2]]


def gif_frames(data):
    im = Image.open(io.BytesIO(data))
    fr, de = [], []
    for f in ImageSequence.Iterator(im):
        fr.append(np.array(f.convert("RGBA")))
        de.append(max(20, f.info.get("duration", 100)))
    return fr, de


def anim_2d(dex):
    d = fetch(f"{SD}/gen5ani/{sid(NAMES[dex - 1])}.gif", f"g5ani_{dex}.gif")
    return gif_frames(d) if d else None


def anim_3d(dex):
    d = fetch(f"{SD}/ani/{sid(NAMES[dex - 1])}.gif", f"ani_{dex}.gif")
    return gif_frames(d) if d else None


def opaque(a):
    return a[..., 3] > 127


def edge(mask):
    p = np.pad(mask, 1)
    return mask & ~(p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:])


def lum(rgb):
    return rgb[..., :3].astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)
