# Black/White-style animated GIFs for the Pokemon that neither SpriteCollab (a base Walk sheet)
# nor Pokemon Showdown's gen5ani has: frame 0 is the Black/White still (Showdown gen5), and each
# later frame moves the still's own pixels the way the 3D animation's (Showdown ani) outline moves,
# so every colour is the 2D sprite's: the still stretches to the outline's top (bottom on the
# ground), and each height band shifts and stretches sideways with its edges (capped at 8% of the
# width so thin parts do not smear). With no 3D animation, the still breathes.
# Usage: python gen5gen.py <dex...>  -> data/pokemon-icons/gen5gen/<dex>.gif (not in this repo).
# Needs Python with Pillow and numpy. space-panel's pokemon-sprites.js uses these as a last resort.
import io, json, os, re, sys, unicodedata, urllib.request
import numpy as np
from PIL import Image, ImageSequence

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
OUT = os.path.join(HERE, "..", "..", "..", "..", "data", "pokemon-icons", "gen5gen")
SD = "https://play.pokemonshowdown.com/sprites"
BANDS = 48
_js = open(os.path.join(HERE, "..", "..", "pokemon-names.js"), encoding="utf-8").read()
NAMES = json.loads("[" + _js.split("export const NAMES = [")[1].split("];")[0].rstrip().rstrip(",") + "]")


def sid(name):
    n = unicodedata.normalize("NFD", name.replace("♀", "f").replace("♂", "m"))
    return re.sub(r"[^a-z0-9]", "", "".join(c for c in n if not unicodedata.combining(c)).lower())


def fetch(url, name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        try:
            data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "herdr-app"}), timeout=30).read()
        except Exception:
            data = b""
        open(path, "wb").write(data)
    return open(path, "rb").read() or None


def bbox(mask):
    ys, xs = np.nonzero(mask)
    return (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1) if len(xs) else None


def smooth(v, k=5):
    pad = np.pad(v, k // 2, mode="edge")
    return np.convolve(pad, np.ones(k) / k, mode="valid")


def profile(mask):
    # Top, bottom, and for each of BANDS height bands (top to bottom) the left and right edges.
    b = bbox(mask)
    top, bot = b[1], b[3]
    L, R = np.empty(BANDS), np.empty(BANDS)
    for i in range(BANDS):
        y = min(bot - 1, int(top + (i + 0.5) / BANDS * (bot - top)))
        xs = np.nonzero(mask[y])[0]
        L[i], R[i] = (xs.min(), xs.max() + 1) if len(xs) else (np.nan, np.nan)
    for v in (L, R):  # fill empty bands from neighbours
        idx = np.arange(BANDS); ok = ~np.isnan(v)
        v[:] = np.interp(idx, idx[ok], v[ok]) if ok.any() else 0
    return top, bot, L, R


def warp(sprite, H, W, ox, top_d, bot_d, dl, dr):
    # Output pixel -> source pixel (nearest), bottom-anchored. sprite: h x w RGBA.
    h, w = sprite.shape[:2]
    out = np.zeros((H, W, 4), np.uint8)
    base = H - 1  # the ground row in the output
    src_top, src_bot = 0.0, float(h)
    dst_top, dst_bot = (H - h) + top_d, H + bot_d
    ys = np.arange(H) + 0.5
    sy = (ys - dst_top) / (dst_bot - dst_top) * (src_bot - src_top)
    alpha = sprite[..., 3] > 127
    for oy in range(H):
        y = int(np.floor(sy[oy]))
        if y < 0 or y >= h:
            continue
        band = min(BANDS - 1, int(y / h * BANDS))
        xs = np.nonzero(alpha[y])[0]
        if not len(xs):
            continue
        l, r = xs.min(), xs.max() + 1
        nl, nr = l + dl[band], r + dr[band]
        if nr - nl < 1:
            continue
        ox_arr = np.arange(W) + 0.5 - ox
        sx = l + (ox_arr - nl) / (nr - nl) * (r - l)
        ok = (sx >= 0) & (sx < w)
        sxi = np.clip(np.floor(sx).astype(int), 0, w - 1)
        row = sprite[y, sxi]
        out[oy, ok] = row[ok]
    return out


def frames_3d(path):
    im = Image.open(path)
    fr, de = [], []
    for f in ImageSequence.Iterator(im):
        fr.append(np.array(f.convert("RGBA"))[..., 3] > 127)
        de.append(max(20, f.info.get("duration", 100)))
    return fr, de


def make(dex):
    still = np.array(Image.open(io.BytesIO(fetch(f"{SD}/gen5/{sid(NAMES[dex - 1])}.png", f"g5_{dex}.png"))).convert("RGBA"))
    b = bbox(still[..., 3] > 127)
    sprite = still[b[1]:b[3], b[0]:b[2]]
    h, w = sprite.shape[:2]
    pad = max(4, round(0.15 * max(h, w)))
    W, H = w + 2 * pad, h + pad
    ox = pad
    ani = fetch(f"{SD}/ani/{sid(NAMES[dex - 1])}.gif", f"ani_{dex}.gif")
    out, delays = [], []
    if ani:
        masks, d3 = frames_3d(io.BytesIO(ani))
        masks = masks[::2]
        d3 = [d3[i] + (d3[i + 1] if i + 1 < len(d3) else d3[i]) for i in range(0, len(d3), 2)]
        t0, b0, L0, R0 = profile(masks[0])
        s = h / (b0 - t0)  # 3D pixels -> still pixels
        for m in masks:
            t, bt, L, R = profile(m)
            cap = max(1.0, 0.08 * w)  # sideways movement, so thin parts do not smear
            dl = np.clip(smooth((L - L0) * s), -cap, cap)
            dr = np.clip(smooth((R - R0) * s), -cap, cap)
            top_d = np.clip((t - t0) * s, -pad, h * 0.3)
            bot_d = np.clip((bt - b0) * s, -h * 0.3, 0)
            out.append(warp(sprite, H, W, ox, top_d, bot_d, dl, dr))
        out[0] = warp(sprite, H, W, ox, 0, 0, np.zeros(BANDS), np.zeros(BANDS))  # exactly the still
        delays = d3
    else:
        for k in range(8):
            t = (1 - np.cos(2 * np.pi * k / 8)) / 2
            g = np.linspace(0, 1, BANDS)  # widen the lower body a little as it breathes out
            out.append(warp(sprite, H, W, ox, -0.05 * h * t, 0, -0.02 * w * t * g, 0.02 * w * t * g))
        delays = [120] * 8
    return out, delays, sprite


def save_gif(frames, delays, sprite, path):
    # One fixed palette, index 0 transparent: the GIF shows exactly these frames. A still with more
    # colours than a GIF holds keeps its 255 most representative ones.
    cols = np.unique(np.concatenate([f[f[..., 3] > 127][:, :3] for f in frames]), axis=0)
    if len(cols) > 255:
        q = Image.fromarray(sprite[..., :3]).quantize(255, method=Image.Quantize.MEDIANCUT)
        cols = np.array(q.getpalette()[:765], np.int32).reshape(-1, 3)
    pal = [255, 0, 255] + [int(v) for c in cols for v in c]
    pal += [0] * (768 - len(pal))
    ims = []
    for f in frames:
        idx = np.zeros(f.shape[:2], np.uint8)
        m = f[..., 3] > 127
        idx[m] = (((f[m][:, None, :3].astype(np.int32) - cols[None].astype(np.int32)) ** 2).sum(-1).argmin(1) + 1)
        im = Image.fromarray(idx, "P"); im.putpalette(pal); im.info["transparency"] = 0
        ims.append(im)
    ims[0].save(path, save_all=True, append_images=ims[1:], duration=delays, loop=0, disposal=2, transparency=0, optimize=False)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for dex in (int(x) for x in sys.argv[1:]):
        frames, delays, sprite = make(dex)
        save_gif(frames, delays, sprite, os.path.join(OUT, f"{dex}.gif"))
        print(dex, NAMES[dex - 1], len(frames))
