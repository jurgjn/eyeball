"""Draw media/icon.png: a flaming, lidless eye scrutinising a grid of data.

The flames are ridged noise in polar coordinates around the eye, curled so they swirl
outwards; the iris fibres are a radial bar chart; behind the eye is a spreadsheet grid
lit by its glow. Needs numpy, scipy and Pillow. Usage: python media/make_icon.py [SIZE]
"""
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates, zoom

SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 256
S = 1024  # render size, downsampled at the end
HALF_W, HALF_H = 0.72, 0.35  # eye (almond) half width and height, in [-1, 1] units

ys, xs = np.mgrid[0:S, 0:S].astype(np.float64)
X = (xs + 0.5) / S * 2 - 1  # [-1, 1], right
Y = (ys + 0.5) / S * 2 - 1  # [-1, 1], down


def periodic_noise(shape, octaves, persistence=0.55, seed=0):
    """Smooth fractal noise in [0, 1] on a grid that wraps in both directions."""
    rng = np.random.default_rng(seed)
    acc = np.zeros(shape)
    amp, total = 1.0, 0.0
    for octave in range(octaves):
        n = 4 * 2 ** octave
        tiled = np.tile(rng.standard_normal((n, n)), (3, 3))
        up = zoom(tiled, (shape[0] * 3 / tiled.shape[0], shape[1] * 3 / tiled.shape[1]), order=3, mode="grid-wrap")
        acc += amp * up[shape[0]:2 * shape[0], shape[1]:2 * shape[1]]
        total += amp
        amp *= persistence
    acc /= total
    return (acc - acc.min()) / (acc.max() - acc.min())


def sd_almond(px, py, half_w, half_h):
    """Signed distance to a horizontal lens with pointed corners at (+-half_w, 0)."""
    r = (half_h + half_w ** 2 / half_h) / 2
    d = (half_w ** 2 / half_h - half_h) / 2
    qx, qy = np.abs(py), np.abs(px)  # Inigo Quilez's sdVesica, with the axes swapped
    b = math.sqrt(r * r - d * d)
    return np.where((qy - b) * d > qx * b, np.hypot(qx, qy - b), np.hypot(qx + d, qy) - r)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def fire_colour(t):
    """Black-body-like ramp: t in [0, 1] -> RGB in [0, 1]."""
    stops = np.array([0.0, 0.18, 0.4, 0.62, 0.82, 1.0])
    cols = np.array([[0, 0, 0], [0.45, 0.03, 0.0], [0.86, 0.22, 0.0], [1.0, 0.55, 0.05], [1.0, 0.85, 0.35], [1.0, 0.98, 0.88]])
    t = np.clip(t, 0, 1)
    return np.stack([np.interp(t, stops, cols[:, c]) for c in range(3)], axis=-1)


def grid_lines(u, width_px):
    """Anti-aliased lines at the integer values of u."""
    du = np.maximum(np.hypot(*np.gradient(u)), 1e-6)
    return np.clip(1 - (np.abs(u - np.round(u)) / du - width_px / 2), 0, 1)


# ---- background: dark red, with a spreadsheet grid lit by the eye
img = np.zeros((S, S, 3)) + np.array([0.035, 0.012, 0.008])
img += np.array([0.22, 0.05, 0.015]) * np.exp(-(np.hypot(X * 0.9, Y * 1.2) / 0.75) ** 2)[..., None]
light = np.exp(-(np.hypot(X * 0.75, Y) / 0.5) ** 2)
u = (X + 1) / 0.19 + 0.5
v = (Y + 1) / 0.105 + 0.3
lines = np.maximum(grid_lines(u, 2.2), grid_lines(v, 2.2))
# short bars in the cells stand in for values
fu, fv = u - np.floor(u), v - np.floor(v)
cell_rand = np.random.default_rng(5).random((60, 60))
length = 0.25 + 0.6 * cell_rand[np.clip(np.floor(u).astype(int), 0, 59), np.clip(np.floor(v).astype(int), 0, 59)]
values = ((fv > 0.38) & (fv < 0.62) & (fu > 0.12) & (fu < 0.12 + length * 0.76)).astype(float)
img += np.array([1.0, 0.42, 0.1]) * ((0.55 * lines + 0.28 * values) * (0.025 + 0.75 * light))[..., None]

# ---- flames: ridged noise in polar coordinates, longest at the corners, curling outwards
s = sd_almond(X, Y, HALF_W, HALF_H)
theta = np.arctan2(Y, X)
A, R = 512, 256
noise1 = periodic_noise((A, R), 6, seed=11)
noise2 = periodic_noise((A, R), 5, seed=23)
outside = np.maximum(s, 0)
angle = (theta + outside * 2.6 * np.sin(2 * theta) + np.pi) / (2 * np.pi) * A
n1 = map_coordinates(noise1, [(angle * 4) % A, outside * 45], order=1, mode="grid-wrap")
n2 = map_coordinates(noise2, [(angle * 11) % A, outside * 103 + 40], order=1, mode="grid-wrap")
uneven = map_coordinates(noise2, [(theta + np.pi) / (2 * np.pi) * A, np.full_like(theta, 7.0)], order=1, mode="grid-wrap")
tongues = 0.65 * (1 - np.abs(2 * n1 - 1)) ** 2.2 + 0.35 * (1 - np.abs(2 * n2 - 1)) ** 1.8
corners = np.abs(np.cos(theta)) ** 3
rising = np.clip(-np.sin(theta), 0, 1) ** 2 * 0.25
reach = 0.03 + 0.4 * tongues * (0.45 + 0.85 * corners + rising) * (0.6 + 0.8 * uneven)
flame = np.clip(1 - outside / reach, 0, 1) ** 1.25 * (s > -0.02)
heat = np.clip(flame * (0.5 + 0.45 * tongues) + 0.3 * np.exp(-outside / 0.1), 0, 1)
img += fire_colour(heat * 0.95) * (heat > 0)[..., None]

# ---- eye: molten iris, darker towards the rim, whose fibres are a radial bar chart
inside = smoothstep(0.004, -0.004, s)
er = np.hypot(X / HALF_W, Y / HALF_H)  # 0 at the centre, 1 at the rim
phi = np.arctan2(Y / HALF_H, X / HALF_W)
swirl1 = map_coordinates(noise1, [(phi + np.pi) / (2 * np.pi) * A, er * 90], order=1, mode="grid-wrap")
swirl2 = map_coordinates(noise2, [((phi + np.pi) / (2 * np.pi) * A * 3) % A, er * 160], order=1, mode="grid-wrap")
depth = np.clip(-s / HALF_H, 0, 1)
iris = 0.9 - 0.46 * np.clip(er, 0, 1) ** 1.1 + 0.16 * (swirl1 - 0.5) + 0.1 * (swirl2 - 0.5)
iris -= 0.2 * np.exp(-((er - 0.9) / 0.09) ** 2)  # dark ring inside the rim
iris = np.where(depth < 0.05, np.maximum(iris, 0.7 - depth * 4), iris)  # the rim catches fire
N = 56
k = np.arange(N)
heights = 0.42 + 0.22 * np.sin(k / N * 2 * np.pi * 3 + 0.5) + 0.14 * np.sin(k / N * 2 * np.pi * 7 + 1.7)
heights = np.clip(heights + np.random.default_rng(8).uniform(-0.12, 0.12, N), 0.12, 0.6)
pos = (phi + np.pi) / (2 * np.pi) * N
within = pos - np.floor(pos)
r_in = 0.2
bars = (smoothstep(0.08, 0.22, within) * smoothstep(0.92, 0.78, within) * smoothstep(r_in - 0.01, r_in + 0.02, er)
        * smoothstep(0.015, -0.015, er - (r_in + heights[np.floor(pos).astype(int) % N])))
iris -= 0.27 * bars
img = img * (1 - inside[..., None]) + fire_colour(iris) * inside[..., None]

# ---- pupil: a black slit with a burning edge
ps = sd_almond(Y, X, 0.325, 0.08)  # vertical lens
img += np.array([0.5, 0.17, 0.0]) * (np.exp(-np.maximum(ps, 0) / 0.02) * inside * (ps > 0))[..., None]
pupil = smoothstep(0.004, -0.004, ps)
img = img * (1 - pupil[..., None]) + np.array([0.02, 0.0, 0.0]) * pupil[..., None]

# ---- tone map, rounded tile, output
img = np.clip(1 - np.exp(-img * 1.25), 0, 1) ** (1 / 1.1)
q = np.maximum(np.abs(np.stack([X, Y])) - 0.6 + 0.015, 0)
alpha = smoothstep(0.003, -0.003, np.hypot(q[0], q[1]) - 0.4)
rgba = (np.dstack([img, alpha]) * 255 + 0.5).astype(np.uint8)
out = Path(__file__).with_name("icon.png")
Image.fromarray(rgba, "RGBA").resize((SIZE, SIZE), Image.LANCZOS).save(out)
print("wrote", out)
