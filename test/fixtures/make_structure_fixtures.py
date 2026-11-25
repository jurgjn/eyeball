"""Generate molecular structure files for the structure viewer's end-to-end test (test/e2e.mjs).

An ideal alpha helix of alanines, built from bond lengths, angles and torsions, in several
formats; a small molecule; a density map; and a trajectory with its topology.

Usage: python make_structure_fixtures.py OUTDIR
"""
import gzip
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)


def place(a, b, c, bond, angle, torsion):
    """The atom d with |cd| = bond, angle bcd and torsion abcd (degrees), from a, b and c (NeRF)."""
    angle, torsion = math.radians(angle), math.radians(torsion)
    bc = (c - b) / np.linalg.norm(c - b)
    n = np.cross(b - a, bc)
    n /= np.linalg.norm(n)
    m = np.cross(n, bc)
    d2 = np.array([-bond * math.cos(angle), bond * math.sin(angle) * math.cos(torsion), bond * math.sin(angle) * math.sin(torsion)])
    return c + d2[0] * bc + d2[1] * m + d2[2] * n


def helix(residues):
    """Atoms (name, element, residue number, xyz) of an alpha helix of alanines."""
    phi, psi, omega = -57.0, -47.0, 180.0
    n = np.array([0.0, 0.0, 0.0])
    ca = np.array([1.458, 0.0, 0.0])
    c = place(np.array([0.0, 1.0, 0.0]), n, ca, 1.525, 111.2, -60.0)
    atoms = []
    for i in range(1, residues + 1):
        o = place(n, ca, c, 1.231, 120.5, psi + 180.0)
        cb = place(c, n, ca, 1.53, 110.5, -122.6)
        atoms += [("N", "N", i, n), ("CA", "C", i, ca), ("C", "C", i, c), ("O", "O", i, o), ("CB", "C", i, cb)]
        next_n = place(n, ca, c, 1.329, 116.2, psi)
        next_ca = place(ca, c, next_n, 1.458, 121.7, omega)
        next_c = place(c, next_n, next_ca, 1.525, 111.2, phi)
        n, ca, c = next_n, next_ca, next_c
    return atoms


def pdb_text(atoms, coords=None):
    lines = []
    for k, (name, element, resi, xyz) in enumerate(atoms):
        x, y, z = coords[k] if coords is not None else xyz
        lines.append(f"ATOM  {k + 1:5d} {name:<4s} ALA A{resi:4d}    {x:8.3f}{y:8.3f}{z:8.3f}  1.00 20.00          {element:>2s}")
    return "\n".join(lines + ["END", ""])


atoms = helix(24)
expected = {}

(out / "helix.pdb").write_text(pdb_text(atoms))
with gzip.open(out / "helix.pdb.gz", "wt") as f:
    f.write(pdb_text(atoms))

cif = ["data_helix", "loop_"] + [f"_atom_site.{k}" for k in (
    "group_PDB", "id", "type_symbol", "label_atom_id", "label_comp_id", "label_asym_id", "label_entity_id",
    "label_seq_id", "Cartn_x", "Cartn_y", "Cartn_z", "occupancy", "B_iso_or_equiv", "auth_seq_id", "auth_asym_id",
    "pdbx_PDB_model_num")]
for k, (name, element, resi, (x, y, z)) in enumerate(atoms):
    cif.append(f"ATOM {k + 1} {element} {name} ALA A 1 {resi} {x:.3f} {y:.3f} {z:.3f} 1.00 20.00 {resi} A 1")
(out / "helix.cif").write_text("\n".join(cif + ["#", ""]))

gro = ["alpha helix", f"{len(atoms):5d}"]
for k, (name, element, resi, (x, y, z)) in enumerate(atoms):
    gro.append(f"{resi:5d}{'ALA':<5s}{name:>5s}{k + 1:5d}{x / 10:8.3f}{y / 10:8.3f}{z / 10:8.3f}")
gro.append("   5.00000   5.00000   5.00000")
(out / "helix.gro").write_text("\n".join(gro + [""]))

(out / "helix.xyz").write_text("\n".join([str(len(atoms)), "alpha helix"] + [
    f"{element} {x:.3f} {y:.3f} {z:.3f}" for name, element, resi, (x, y, z) in atoms] + [""]))
for name in ("helix.pdb", "helix.pdb.gz", "helix.cif", "helix.gro", "helix.xyz"):
    expected[name] = {"atoms": len(atoms)}

# ethanol, with bonds
ethanol = [("C", -0.748, -0.015, 0.024), ("C", 0.558, 0.420, -0.278), ("O", 0.716, 1.404, 0.137),
           ("H", -1.293, 0.202, -0.901), ("H", -1.263, 0.754, 0.640), ("H", -0.699, -1.012, 0.416),
           ("H", 0.716, 0.476, -1.358), ("H", 1.300, -0.290, 0.097), ("H", 1.648, 1.666, -0.028)]
bonds = [(1, 2, 1), (2, 3, 1), (1, 4, 1), (1, 5, 1), (1, 6, 1), (2, 7, 1), (2, 8, 1), (3, 9, 1)]
sdf = ["ethanol", "  eyeball", "", f"{len(ethanol):3d}{len(bonds):3d}  0  0  0  0  0  0  0  0999 V2000"]
sdf += [f"{x:10.4f}{y:10.4f}{z:10.4f} {el:<3s} 0  0  0  0  0  0  0  0  0  0  0  0" for el, x, y, z in ethanol]
sdf += [f"{a:3d}{b:3d}{order:3d}  0" for a, b, order in bonds]
(out / "ethanol.sdf").write_text("\n".join(sdf + ["M  END", "$$$$", ""]))
mol2 = ["@<TRIPOS>MOLECULE", "ethanol", f"{len(ethanol)} {len(bonds)} 1", "SMALL", "NO_CHARGES", "", "@<TRIPOS>ATOM"]
types = {"C": "C.3", "O": "O.3", "H": "H"}
mol2 += [f"{k + 1:4d} {el}{k + 1:<4d} {x:9.4f} {y:9.4f} {z:9.4f} {types[el]:<5s} 1 EOH 0.0000" for k, (el, x, y, z) in enumerate(ethanol)]
mol2 += ["@<TRIPOS>BOND"] + [f"{k + 1:4d} {a:4d} {b:4d} {order}" for k, (a, b, order) in enumerate(bonds)]
(out / "ethanol.mol2").write_text("\n".join(mol2 + [""]))
expected["ethanol.sdf"] = expected["ethanol.mol2"] = {"atoms": len(ethanol)}

# a density map (MRC2014): a Gaussian blob on a 32^3 grid of 1 A voxels
size = 32
grid = np.indices((size, size, size)).astype(np.float32) - (size - 1) / 2
density = np.exp(-(grid ** 2).sum(axis=0) / (2 * 5.0 ** 2)).astype(np.float32)
header = bytearray(1024)
struct.pack_into("<3i i 3i 3i 3f 3f 3i 3f i i", header, 0, size, size, size, 2, 0, 0, 0, size, size, size,
                 float(size), float(size), float(size), 90.0, 90.0, 90.0, 1, 2, 3,
                 float(density.min()), float(density.max()), float(density.mean()), 1, 0)
struct.pack_into("<3f 4s 4B f i", header, 196, 0.0, 0.0, 0.0, b"MAP ", 0x44, 0x44, 0, 0, float(density.std()), 0)
(out / "density.mrc").write_bytes(bytes(header) + density.tobytes())
expected["density.mrc"] = {"volume": True}


def fortran(payload):
    return struct.pack("<i", len(payload)) + payload + struct.pack("<i", len(payload))


def dcd(frames):
    """A CHARMM DCD trajectory: coordinates of frames of the same atoms."""
    natoms = frames.shape[1]
    control = [len(frames), 0, 1, len(frames), 0, 0, 0, 0, 0]
    head = b"CORD" + struct.pack("<9i", *control) + struct.pack("<f", 1.0) + struct.pack("<10i", *[0] * 9, 24)
    title = struct.pack("<i", 1) + b"eyeball test trajectory".ljust(80)
    data = fortran(head) + fortran(title) + fortran(struct.pack("<i", natoms))
    for frame in frames:
        for axis in range(3):
            data += fortran(frame[:, axis].astype("<f4").tobytes())
    return data


# a trajectory: the helix turning about its axis, with its topology (a PDB file of the same name)
xyz = np.array([a[3] for a in atoms])
center = xyz.mean(axis=0)
frames = []
for f in range(10):
    t = math.radians(10 * f)
    rotation = np.array([[math.cos(t), -math.sin(t), 0], [math.sin(t), math.cos(t), 0], [0, 0, 1]])
    frames.append((xyz - center) @ rotation.T + center)
frames = np.array(frames, dtype=np.float32)
(out / "traj.pdb").write_text(pdb_text(atoms))
(out / "traj.dcd").write_bytes(dcd(frames))
expected["traj.dcd"] = {"atoms": len(atoms), "frames": len(frames)}
# coordinates without a topology: shown with a note on how to add one
(out / "lonely.dcd").write_bytes(dcd(frames))
expected["lonely.dcd"] = {"note": True}

(out / "structures.expected.json").write_text(json.dumps(expected, indent=1))
print("wrote", ", ".join(expected))
