# Measures how SpriteCollab idles relate to the Black/White still (and the 2D/3D animations) over
# a sample of Pokemon that have them all. Writes style.json and prints a summary.
import json, random, sys
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from common import *

paths = json.load(open(PATHS))
random.seed(7)
pool = [int(d) for d, p in paths.items() if "/" not in p]
sample = random.sample(pool, int(sys.argv[1]) if len(sys.argv) > 1 else 160)


def measure(dex):
    pm = pmd_idle(dex)
    st = still(dex)
    if not pm or st is None:
        return None
    frames, du = pm
    m0 = opaque(frames[0])
    tops = []; hs = []
    for f in frames:
        ys = np.nonzero(opaque(f).any(1))[0]
        tops.append(ys.min()); hs.append(ys.max() - ys.min() + 1)
    allpx = np.concatenate([f[opaque(f)][:, :3] for f in frames])
    cols = len(np.unique(allpx, axis=0))
    # Outline: edge pixels' brightness against the mean of the opaque interior.
    e = edge(m0); inner = m0 & ~e
    out_l = float(lum(frames[0][e]).mean()); in_l = float(lum(frames[0][inner]).mean()) if inner.any() else out_l
    black = float((lum(frames[0][e]) < 40).mean())
    sm = opaque(st)
    r = {"dex": dex, "pmd_h": int(m0.shape[0]), "pmd_w": int(m0.shape[1]), "pmd_h0": int(np.ptp(np.nonzero(m0.any(1))[0]) + 1),
         "still_h": int(st.shape[0]), "still_w": int(st.shape[1]), "still_px": int(sm.sum()), "pmd_px": int(m0.sum()),
         "n": len(du), "delays": du, "total": sum(du), "bob": int(max(tops) - min(tops)), "dh": int(max(hs) - min(hs)),
         "colours": cols, "still_colours": int(len(np.unique(st[sm][:, :3], axis=0))),
         "outline_ratio": out_l / max(1.0, in_l), "outline_black": black}
    a2 = anim_2d(dex); a3 = anim_3d(dex)
    r["has2d"] = bool(a2); r["has3d"] = bool(a3)
    for k, a in (("ani2d", a2), ("ani3d", a3)):
        if a:
            fr, de = a
            r[k + "_n"] = len(fr); r[k + "_total"] = sum(de)
    return r


with ThreadPoolExecutor(12) as ex:
    rows = [r for r in ex.map(measure, sample) if r]
json.dump(rows, open(os.path.join(HERE, "calib.json"), "w"))

A = np.array([[r["still_h"], 1] for r in rows], float); y = np.array([r["pmd_h0"] for r in rows], float)
coef_h, *_ = np.linalg.lstsq(A, y, rcond=None)
ratio_area = np.median([np.sqrt(r["pmd_px"] / r["still_px"]) for r in rows])
ns = [r["n"] for r in rows]; tot = [r["total"] for r in rows]
style = {
    "height": {"a": float(coef_h[0]), "b": float(coef_h[1])},
    "linear_ratio_median": float(np.median([r["pmd_h0"] / r["still_h"] for r in rows])),
    "area_ratio_median": float(ratio_area),
    "frames_median": float(np.median(ns)), "frames_hist": {str(k): ns.count(k) for k in sorted(set(ns))},
    "total_ms_median": float(np.median(tot)),
    "first_frame_share_median": float(np.median([r["delays"][0] / r["total"] for r in rows])),
    "bob_hist": {str(k): [r["bob"] for r in rows].count(k) for k in sorted(set(r["bob"] for r in rows))},
    "dh_hist": {str(k): [r["dh"] for r in rows].count(k) for k in sorted(set(r["dh"] for r in rows))},
    "colours_median": float(np.median([r["colours"] for r in rows])),
    "colours_p90": float(np.percentile([r["colours"] for r in rows], 90)),
    "outline_ratio_median": float(np.median([r["outline_ratio"] for r in rows])),
    "outline_black_median": float(np.median([r["outline_black"] for r in rows])),
    "speed_vs_2d": float(np.median([r["total"] / r["ani2d_total"] for r in rows if r.get("ani2d_total")])),
    "speed_vs_3d": float(np.median([r["total"] / r["ani3d_total"] for r in rows if r.get("ani3d_total")])),
    "samples": len(rows),
}
json.dump(style, open(os.path.join(HERE, "style.json"), "w"), indent=1)
print(json.dumps(style, indent=1))
