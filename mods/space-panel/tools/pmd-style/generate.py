# Generates a SpriteCollab-style (Mystery Dungeon) idle for a Pokemon from its other sprites, using
# the relations measured by calibrate.py (style.json):
#   size     PMD height = a * (Black/White still height) + b
#   motion   the 2D animation (gen5ani) if there is one; else the 3D animation's outline moves the
#            still's own pixels (warp); else a breath. Six frames: a long-held rest pose, then a
#            quick pass through the motion, timed like SpriteCollab idles.
#   look     shrunk with box filtering, the still's colours cut to a ~12-colour palette, and a
#            1-pixel pure black outline (SpriteCollab outlines are black).
# Usage: generate.py validate <dex...>  (Pokemon that have a real SpriteCollab idle, for comparison)
#        generate.py make <dex...>      (writes data/pokemon-icons/pmd/<dex>/f<n>.png, meta.json, preview.gif)
# Needs Python with Pillow and numpy. The Pokemon SpriteCollab lacks: those not in ../../pmd-paths.json.
import json, os, sys
import numpy as np
from PIL import Image
from common import *

STYLE = json.load(open(os.path.join(HERE, "style.json")))
# make: into herdr's sprite folder, beside the fetched ones; validate: here.
OUT = os.path.join(HERE, "..", "..", "..", "..", "data", "pokemon-icons", "pmd")
VALIDATE = os.path.join(HERE, "validate")
K = 6                 # frames, the median SpriteCollab idle
REST_MS = 600         # the held rest pose
BANDS = 40


def bbox(mask):
    ys, xs = np.nonzero(mask)
    return (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1) if len(xs) else None


def profile(mask):
    b = bbox(mask); top, bot = b[1], b[3]
    L, R = np.empty(BANDS), np.empty(BANDS)
    for i in range(BANDS):
        y = min(bot - 1, int(top + (i + 0.5) / BANDS * (bot - top)))
        xs = np.nonzero(mask[y])[0]
        L[i], R[i] = (xs.min(), xs.max() + 1) if len(xs) else (np.nan, np.nan)
    idx = np.arange(BANDS)
    for v in (L, R):
        ok = ~np.isnan(v); v[:] = np.interp(idx, idx[ok], v[ok]) if ok.any() else 0
    return top, bot, L, R


def warp(sprite, H, W, ox, top_d, dl, dr):
    # Bottom-anchored: rows stretch so the top moves by top_d; each band shifts/stretches sideways.
    h, w = sprite.shape[:2]; out = np.zeros((H, W, 4), np.uint8)
    dst_top = (H - h) + top_d
    alpha = opaque(sprite)
    for oy in range(H):
        y = int(np.floor((oy + 0.5 - dst_top) / (H - dst_top) * h))
        if y < 0 or y >= h: continue
        xs = np.nonzero(alpha[y])[0]
        if not len(xs): continue
        band = min(BANDS - 1, int(y / h * BANDS)); l, r = xs.min(), xs.max() + 1
        nl, nr = l + dl[band], r + dr[band]
        if nr - nl < 1: continue
        sx = l + (np.arange(W) + 0.5 - ox - nl) / (nr - nl) * (r - l)
        ok = (sx >= 0) & (sx < w)
        out[oy, ok] = sprite[y, np.clip(np.floor(sx).astype(int), 0, w - 1)][ok]
    return out


def smooth(v, k=5):
    return np.convolve(np.pad(v, k // 2, mode="edge"), np.ones(k) / k, mode="valid")


def motion_frames(dex, st):
    """Full-size 2D frames of one motion loop, and the loop's length in ms."""
    a2 = anim_2d(dex)
    if a2:
        fr, de = a2
        return crop_union(fr), sum(de), "2D animation"
    h, w = st.shape[:2]; pad = max(4, round(0.15 * max(h, w))); W, H = w + 2 * pad, h + pad
    a3 = anim_3d(dex)
    if a3:
        fr, de = a3
        masks = [opaque(f) for f in fr]
        t0, b0, L0, R0 = profile(masks[0]); s = h / (b0 - t0); cap = max(1.0, 0.08 * w)
        out = []
        for m in masks:
            t, b, L, R = profile(m)
            out.append(warp(st, H, W, pad, np.clip((t - t0) * s, -pad, h * 0.3),
                            np.clip(smooth((L - L0) * s), -cap, cap), np.clip(smooth((R - R0) * s), -cap, cap)))
        return crop_union(out), sum(de), "3D animation"
    out = []
    for k in range(12):
        t = (1 - np.cos(2 * np.pi * k / 12)) / 2
        g = np.linspace(0, 1, BANDS)
        out.append(warp(st, H, W, pad, -0.06 * h * t, -0.02 * w * t * g, 0.02 * w * t * g))
    return crop_union(out), 1100, "breath (no animation)"


def palette(st, n):
    # The still's main colours, without near-black (the outline is added on its own).
    rgb = st[opaque(st)][:, :3]
    rgb = rgb[(rgb.astype(int).sum(1)) > 60]
    im = Image.fromarray(rgb.reshape(1, -1, 3).astype(np.uint8))
    q = im.quantize(n, method=Image.Quantize.MEDIANCUT)
    return np.array(q.getpalette()[:3 * n], np.int32).reshape(-1, 3)


def punch(rgb):
    # SpriteCollab shading is bolder than a shrunk Black/White sprite: a little more saturation
    # and contrast around the sprite's own mid-tone.
    rgb = rgb.astype(np.float32)
    grey = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    rgb = grey[..., None] + (rgb - grey[..., None]) * 1.2
    mid = grey.mean() if grey.size else 128
    return np.clip(mid + (rgb - mid) * 1.1, 0, 255)


def despeckle(img, body):
    # A pixel whose colour no 4-neighbour shares takes its neighbours' most common colour.
    out = img.copy(); H, W = body.shape
    key = img[..., 0].astype(np.int64) << 16 | img[..., 1].astype(np.int64) << 8 | img[..., 2]
    for y in range(1, H - 1):
        for x in range(1, W - 1):
            if not body[y, x]: continue
            nb = [(y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)]
            ks = [key[p] for p in nb if body[p]]
            if len(ks) >= 3 and key[y, x] not in ks:
                k = max(set(ks), key=ks.count)
                if ks.count(k) >= 2:
                    py, px = next(p for p in nb if body[p] and key[p] == k); out[y, x] = img[py, px]
    return out


def pmdify(frames, still_h, pal):
    target = max(10, round(STYLE["height"]["a"] * still_h + STYLE["height"]["b"]))
    s = (target - 2) / frames[0].shape[0]   # leave room for the outline
    out = []
    for f in frames:
        h, w = f.shape[:2]
        nw, nh = max(1, round(w * s)), max(1, round(h * s))
        pre = f.astype(np.float32); pre[..., :3] *= pre[..., 3:4] / 255
        small = np.array(Image.fromarray(np.clip(pre, 0, 255).astype(np.uint8), "RGBA").resize((nw, nh), Image.BOX)).astype(np.float32)
        a = small[..., 3] > 100
        rgb = punch(np.where(a[..., None], small[..., :3] / np.maximum(small[..., 3:4], 1) * 255, 0))
        # Dark line art: where enough of the source block was a dark line, keep a black pixel.
        line = ((lum(f) < 60) & opaque(f)).astype(np.float32) * 255
        lines = np.array(Image.fromarray(line.astype(np.uint8)).resize((nw, nh), Image.BOX)) > 90
        img = np.zeros((nh + 2, nw + 2, 4), np.uint8)
        body = np.zeros((nh + 2, nw + 2), bool); body[1:-1, 1:-1] = a
        px = rgb[a].astype(np.int32)
        d = ((px[:, None, :] - pal[None]) ** 2).sum(-1)
        img[1:-1, 1:-1][a, :3] = pal[d.argmin(1)]
        img[1:-1, 1:-1][a & lines, :3] = 0
        img[body, 3] = 255
        img = despeckle(img, body)
        # A black outline around the body (outside it), as SpriteCollab draws.
        p = np.pad(body, 1)
        ring = (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]) & ~body
        img[ring] = (0, 0, 0, 255)
        out.append(img)
    return out


def make(dex):
    st = still(dex)
    frames, loop_ms, source = motion_frames(dex, st)
    n = len(frames)
    pick = [0] + [int(i) for i in np.linspace(n / K, n - n / K, K - 1).round()]
    pal = np.clip(punch(palette(st, 12)), 0, 255).astype(np.int32)
    small = pmdify([frames[i] for i in pick], st.shape[0], pal)
    step = int(np.clip((loop_ms * STYLE["speed_vs_3d"] if source == "3D animation" else 500) / (K - 1), 67, 200))
    delays = [REST_MS] + [step] * (K - 1)
    return crop_union(small), delays, source


def save(dex, frames, delays, source, d):
    os.makedirs(d, exist_ok=True)
    ims = [Image.fromarray(f) for f in frames]
    for i, im in enumerate(ims): im.save(os.path.join(d, f"f{i}.png"))
    json.dump({"w": ims[0].width, "h": ims[0].height, "delays": delays, "source": source, "generated": True}, open(os.path.join(d, "meta.json"), "w"))
    ims[0].save(os.path.join(d, "preview.gif"), save_all=True, append_images=ims[1:], duration=delays, loop=0, disposal=2)


if __name__ == "__main__":
    mode, dexes = sys.argv[1], [int(x) for x in sys.argv[2:]]
    for dex in dexes:
        frames, delays, source = make(dex)
        save(dex, frames, delays, source, os.path.join(VALIDATE if mode == "validate" else OUT, str(dex)))
        if mode == "validate":
            real, du = pmd_idle(dex)
            d = os.path.join(VALIDATE, str(dex))
            ims = [Image.fromarray(f) for f in real]
            ims[0].save(os.path.join(d, "real.gif"), save_all=True, append_images=ims[1:], duration=du, loop=0, disposal=2)
            json.dump({"real_w": ims[0].width, "real_h": ims[0].height}, open(os.path.join(d, "real.json"), "w"))
        print(dex, NAMES[dex - 1], source, len(frames), frames[0].shape[:2])
