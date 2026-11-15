# -*- coding: utf-8 -*-
"""动物园场景构建公共库（Blender 5.x bpy，纯数据 API 为主）。"""
import bpy
import math
import os
from mathutils import Vector, Euler, Matrix

OUT_DIR = r"D:\playground-mvp\zoo"

# ---------------- 布局常量 ----------------
PG_BOUNDS = dict(xmin=-30.0, xmax=30.0, ymin=-30.0, ymax=30.0)

ZONES = {
    "bird_zone": dict(
        cx=45.0, cy=14.0, w=26.0, h=24.0,
        color=(0.44, 0.75, 0.95, 1.0), label_cn="鸟类区", label_en="BIRD ZONE",
        hex="#70BFF2", animal="bird", count=8),
    "reptile_zone": dict(
        cx=75.0, cy=14.0, w=26.0, h=24.0,
        color=(0.76, 0.61, 0.34, 1.0), label_cn="爬行区", label_en="REPTILE ZONE",
        hex="#C29B57", animal="reptile", count=4),
    "marine_zone": dict(
        cx=45.0, cy=-14.0, w=26.0, h=24.0,
        color=(0.08, 0.25, 0.55, 1.0), label_cn="海洋区", label_en="MARINE ZONE",
        hex="#14408C", animal="fish", count=15),
    "mammal_zone": dict(
        cx=75.0, cy=-14.0, w=26.0, h=24.0,
        color=(0.30, 0.62, 0.28, 1.0), label_cn="哺乳区", label_en="MAMMAL ZONE",
        hex="#4C9E47", animal="mammal", count=5),
}


def zone_bounds(name):
    z = ZONES[name]
    return dict(xmin=z["cx"] - z["w"] / 2, xmax=z["cx"] + z["w"] / 2,
                ymin=z["cy"] - z["h"] / 2, ymax=z["cy"] + z["h"] / 2)


# ---------------- 材质 ----------------
def make_mat(name, color, roughness=0.78, metallic=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = None
    for n in m.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            p = n
            break
    if p is not None:
        p.inputs["Base Color"].default_value = color
        p.inputs["Roughness"].default_value = roughness
        p.inputs["Metallic"].default_value = metallic
        p.inputs["Alpha"].default_value = alpha
    m.diffuse_color = color
    if alpha < 1.0:
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            pass
    return m


def get_mat(name):
    return bpy.data.materials.get(name)


# ---------------- 几何生成器 ----------------
def box(w, d, h):
    x, y, z = w / 2, d / 2, h / 2
    v = [(-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z),
         (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
         (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return v, f


def cyl(r, h, n=8):
    z = h / 2
    v = [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), -z) for i in range(n)]
    v += [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), z) for i in range(n)]
    f = [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
    f += [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    return v, f


def cone(r, h, n=6):
    z = h / 2
    v = [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), -z) for i in range(n)]
    v.append((0.0, 0.0, z))
    f = [(i, (i + 1) % n, n) for i in range(n)]
    f.append(tuple(range(n - 1, -1, -1)))
    return v, f


def sphere(r, seg=8, rings=5):
    v = [(0.0, 0.0, -r)]
    for j in range(1, rings):
        phi = -math.pi / 2 + math.pi * j / rings
        for i in range(seg):
            th = 2 * math.pi * i / seg
            v.append((r * math.cos(phi) * math.cos(th),
                      r * math.cos(phi) * math.sin(th), r * math.sin(phi)))
    v.append((0.0, 0.0, r))
    f = []
    for i in range(seg):
        f.append((0, 1 + (i + 1) % seg, 1 + i))
    for j in range(rings - 2):
        a = 1 + j * seg
        b = a + seg
        for i in range(seg):
            f.append((a + i, a + (i + 1) % seg, b + (i + 1) % seg, b + i))
    last = len(v) - 1
    a = 1 + (rings - 2) * seg
    for i in range(seg):
        f.append((a + i, a + (i + 1) % seg, last))
    return v, f


class MB:
    """把多个低模部件合并为单个 mesh，并按骨骼记录顶点组。"""
    def __init__(self):
        self.v = []
        self.f = []
        self.mi = []
        self.groups = {}

    def add(self, gen, off=(0, 0, 0), scale=(1, 1, 1), rot=None, mat=0, group=None):
        verts, faces = gen
        base = len(self.v)
        rotm = Euler(rot).to_matrix() if rot else None
        for p in verts:
            q = Vector((p[0] * scale[0], p[1] * scale[1], p[2] * scale[2]))
            if rotm is not None:
                q = rotm @ q
            self.v.append((q.x + off[0], q.y + off[1], q.z + off[2]))
        for face in faces:
            self.f.append(tuple(base + i for i in face))
            self.mi.append(mat)
        if group:
            self.groups.setdefault(group, []).extend(range(base, base + len(verts)))
        return self

    def build(self, name, coll, materials, loc=(0, 0, 0), parent=None, color_per_face=False):
        mesh = bpy.data.meshes.new(name + "_Mesh")
        mesh.from_pydata(self.v, [], self.f)
        mesh.update()
        for m in materials:
            mesh.materials.append(m)
        for i, poly in enumerate(mesh.polygons):
            poly.material_index = self.mi[i] if i < len(self.mi) else 0
        obj = bpy.data.objects.new(name, mesh)
        coll.objects.link(obj)
        obj.location = loc
        if parent is not None:
            obj.parent = parent
            obj.matrix_parent_inverse = Matrix.Identity(4)
        for gname, idxs in self.groups.items():
            vg = obj.vertex_groups.new(name=gname)
            vg.add(idxs, 1.0, 'REPLACE')
        return obj


# ---------------- 集合 / 文字 / 曲线 ----------------
def collection(name, parent=None):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(c)
    return c


def font_load():
    for p in (r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\msyh.ttc"):
        if os.path.exists(p):
            try:
                return bpy.data.fonts.load(p)
            except Exception:
                pass
    return None


CN_FONT = None


def text_object(name, body, coll, loc, size=1.4, mat=None, rot=(math.pi / 2, 0, 0)):
    global CN_FONT
    if CN_FONT is None:
        CN_FONT = font_load()
    cu = bpy.data.curves.new(name + "_Curve", 'FONT')
    cu.body = body
    cu.size = size
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    cu.extrude = 0.04
    cu.bevel_depth = 0.01
    if CN_FONT is not None:
        cu.font = CN_FONT
    if mat is not None:
        cu.materials.append(mat)
    o = bpy.data.objects.new(name, cu)
    coll.objects.link(o)
    o.location = loc
    o.rotation_euler = rot
    return o


def poly_curve(name, points, coll, cyclic=True, bevel=0.0):
    cu = bpy.data.curves.new(name + "_Curve", 'CURVE')
    cu.dimensions = '3D'
    cu.resolution_u = 2
    cu.bevel_depth = bevel
    cu.bevel_resolution = 1
    sp = cu.splines.new('POLY')
    sp.points.add(len(points) - 1)
    for p, co in zip(sp.points, points):
        p.co = (co[0], co[1], co[2], 1.0)
    sp.use_cyclic_u = cyclic
    o = bpy.data.objects.new(name, cu)
    coll.objects.link(o)
    return o


# ---------------- 驱动器 / 循环 ----------------
def set_driver(owner, prop, index, expr, scene=None):
    """为任意 RNA 属性挂基于 frame_current 的循环驱动器。"""
    scene = scene or bpy.context.scene
    if index is None:
        fc = owner.driver_add(prop)
    else:
        fc = owner.driver_add(prop, index)
    drv = fc.driver
    drv.type = 'SCRIPTED'
    try:
        v = drv.variables.get("f")
        if v is None:
            v = drv.variables.new()
            v.name = "f"
        v.type = 'SINGLE_PROP'
        v.targets[0].id_type = 'SCENE'
        v.targets[0].id = scene
        v.targets[0].data_path = "frame_current"
    except Exception:
        pass
    drv.expression = expr
    return fc


def all_fcurves(action):
    out = []
    try:
        out = list(action.fcurves)
    except Exception:
        pass
    if not out:
        try:
            for layer in action.layers:
                for strip in layer.strips:
                    for cb in strip.channelbags:
                        out.extend(list(cb.fcurves))
        except Exception:
            pass
    return out


def add_cycles(obj):
    ad = obj.animation_data
    if ad is None:
        return 0
    n = 0
    acts = set()
    if ad.action:
        acts.add(ad.action)
    for fcurve in all_fcurves(ad.action) if ad.action else []:
        try:
            if not any(m.type == 'CYCLES' for m in fcurve.modifiers):
                fcurve.modifiers.new('CYCLES')
            n += 1
        except Exception:
            pass
    return n


def total_triangles(objects=None):
    objs = objects if objects is not None else bpy.context.scene.objects
    total = 0
    for o in objs:
        if o.type != 'MESH':
            continue
        m = o.data
        try:
            m.calc_loop_triangles()
        except Exception:
            pass
        try:
            total += len(m.loop_triangles)
        except Exception:
            total += sum(max(1, len(p.vertices) - 2) for p in m.polygons)
    return total


def world_bounds(objects):
    import mathutils
    xs, ys, zs = [], [], []
    for o in objects:
        if o.type not in {'MESH', 'CURVE', 'FONT'}:
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            xs.append(w.x); ys.append(w.y); zs.append(w.z)
    if not xs:
        return None
    return dict(xmin=min(xs), xmax=max(xs), ymin=min(ys), ymax=max(ys),
                zmin=min(zs), zmax=max(zs))
