# -*- coding: utf-8 -*-
"""Blender 3.6 建模：都会区「我的别墅」外壳精修（数据编译进 JS，零外部资产）。

坐标语义（Blender Z-up）：
  x = 东西宽（±10m），y = 南北深（**+Y 为南/正面/门**），z = 高度（0..9.3m）。
导出轴变换 (x,y,z)_blender -> (x,z,-y)_three（det=+1，法线同变换）：
  Blender +Y(南) -> Three -Z(南，世界 z 减小方向)，与 CITY_VILLA.door.z=125.7 对齐。

产物：
- D:/playground-mvp/models/blender-villa-preview.png        Cycles CPU 预览（人工验收）
- D:/playground-mvp/src/scenes/metropolis/city-villa-blender-model.js   量化几何 JS 模块

运行时：city-villa.js 把每个桶 geometry.translate(CITY_VILLA.x, 1.16, CITY_VILLA.z)，
使所有外壳 Mesh 保持世界坐标语义，root 仍为 identity —— ring / 招牌 / 门板 / 碰撞盒契约不变。

面数配额：≤12000 tris（红线余量约 69k，后续医院/游乐场/动物园各留 ~12k）。
"""
import math
import os

import bmesh
import bpy
from mathutils import Vector

ROOT = r"D:\playground-mvp"
OUT_JS = os.path.join(ROOT, "src", "scenes", "metropolis", "city-villa-blender-model.js")
OUT_PNG = os.path.join(ROOT, "models", "blender-villa-preview.png")

Q1000, Q255 = 1000, 255
TRI_BUDGET = 12000

for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)


# ---------------------------------------------------------------- 预览材质（仅 Blender 渲染用）
def make_mat(name, color, metallic, roughness, transmission=0.0, emission=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    for n in mat.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            n.inputs['Base Color'].default_value = (*color, 1.0)
            n.inputs['Metallic'].default_value = metallic
            n.inputs['Roughness'].default_value = roughness
            if transmission > 0 and 'Transmission' in n.inputs:
                n.inputs['Transmission'].default_value = transmission
            if emission and 'Emission' in n.inputs:
                n.inputs['Emission'].default_value = emission
                if 'Emission Strength' in n.inputs:
                    n.inputs['Emission Strength'].default_value = 1.4
            break
    return mat


MAT = {
    'WALL':  make_mat('VillaWall',   (0.86, 0.85, 0.82), 0.0, 0.86),
    'GLASS': make_mat('VillaGlass',  (0.26, 0.42, 0.52), 0.35, 0.10, 0.32),
    'FRAME': make_mat('VillaFrame',  (0.10, 0.12, 0.14), 0.70, 0.36),
    'WOOD':  make_mat('VillaWood',   (0.54, 0.35, 0.20), 0.0, 0.72),
    'DOOR':  make_mat('VillaDoor',   (0.34, 0.21, 0.13), 0.0, 0.64),
    'DARK':  make_mat('VillaDark',   (0.13, 0.15, 0.17), 0.10, 0.82),
    'GLOW':  make_mat('VillaGlow',   (1.00, 0.76, 0.40), 0.0, 1.00,
                      emission=(1.0, 0.62, 0.24, 1.0)),
    'GREEN': make_mat('VillaGreen',  (0.20, 0.40, 0.21), 0.0, 0.92),
}

# 顶点色（桶内明暗层次；运行时 material.color=白，顶点色决定实际颜色）
VC = {
    'WHITE': (1.00, 1.00, 1.00),
    'WALL2': (0.90, 0.90, 0.88),
    'WALL3': (0.74, 0.74, 0.72),
    'GLASS': (0.80, 0.90, 0.96),
    'GLASS2': (0.60, 0.74, 0.83),
    'FRAME2': (0.76, 0.78, 0.80),
    'WOOD2': (0.82, 0.76, 0.68),
    'DARK2': (0.72, 0.74, 0.76),
    'GREEN2': (0.74, 0.90, 0.68),
}

BUCKETS = {k: [] for k in ('WALL', 'GLASS', 'FRAME', 'WOOD', 'DOOR', 'DARK', 'GLOW', 'GREEN')}


# ---------------------------------------------------------------- 建模工具（所有变换烘焙进顶点）
def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _recalc(mesh):
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()


def _make(name, verts, faces, bucket, vc, bevel=0.0):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    mesh.validate()
    _recalc(mesh)
    obj = bpy.data.objects.new(name, mesh)
    link(obj)
    mesh.materials.append(MAT[bucket])
    obj['vc'] = vc
    if bevel > 0:
        m = obj.modifiers.new('Bevel', 'BEVEL')
        m.width = bevel
        m.segments = 1
        m.limit_method = 'ANGLE'
        m.angle_limit = math.radians(52)
    BUCKETS[bucket].append(obj)
    return obj


BOX_FACES = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4),
             (2, 6, 7, 3), (1, 3, 7, 5), (0, 4, 6, 2)]


def add_box(bucket, name, size, loc, vc=VC['WHITE'], bevel=0.0):
    """size=(x宽, y深, z高), loc=中心(x,y,z)。顶点直接烘焙世界坐标。"""
    w, l, h = size
    x, y, z = loc
    hx, hy, hz = w / 2, l / 2, h / 2
    vs = [(-hx, -hy, -hz), (-hx, -hy, hz), (-hx, hy, -hz), (-hx, hy, hz),
          (hx, -hy, -hz), (hx, -hy, hz), (hx, hy, -hz), (hx, hy, hz)]
    vs = [(vx + x, vy + y, vz + z) for (vx, vy, vz) in vs]
    return _make(name, vs, BOX_FACES, bucket, vc, bevel)


def add_polybox(bucket, name, pts, vc=VC['WHITE']):
    """任意六面体：pts 为 add_box 同序的 8 个已变换顶点（用于倾斜板）。"""
    return _make(name, pts, BOX_FACES, bucket, vc)


def add_revolve(bucket, name, profile, loc, seg=8, vc=VC['WHITE']):
    """旋转体：profile=[(radius, z), ...] 自下而上；loc=(x,y,z) 底部中心。"""
    x, y, z0 = loc
    verts, faces = [], []
    for r, zz in profile:
        for i in range(seg):
            a = 2 * math.pi * i / seg
            verts.append((x + r * math.cos(a), y + r * math.sin(a), z0 + zz))
    n = len(profile)
    for j in range(n - 1):
        a, b = j * seg, (j + 1) * seg
        for i in range(seg):
            k = (i + 1) % seg
            faces.append((a + i, a + k, b + k, b + i))
    faces.append(tuple(reversed(range(seg))))
    faces.append(tuple((n - 1) * seg + i for i in range(seg)))
    return _make(name, verts, faces, bucket, vc)


def strip_y(bucket, name, x0, x1, y, z, h, t=0.06, vc=VC['WHITE']):
    """沿 x 的横条（南/北立面上的线脚、灯带、框条）。"""
    return add_box(bucket, name, (x1 - x0, t, h), ((x0 + x1) / 2, y, z), vc)


def strip_z(bucket, name, x, y, z0, z1, t=0.06, vc=VC['WHITE']):
    """竖条（窗梃、竖鳍、栏板立柱）。"""
    return add_box(bucket, name, (t, t, z1 - z0), (x, y, (z0 + z1) / 2), vc)


def curtain_y(bucket_prefix, x0, x1, at, z0, z1, cols, rows, glass_vc=None,
              wood_shade=False, sign=1):
    """南/北立面幕墙：深色背板 + 玻璃 + 铝合金分格 + 窗台/窗楣 + 可选木格栅。
    at=墙面 y；sign=+1 朝 +Y（南），sign=-1 朝 -Y（北）。"""
    W, H = x1 - x0, z1 - z0
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    add_box('DARK', bucket_prefix + '_back', (W, 0.04, H), (cx, at + 0.02 * sign, cz), VC['DARK2'])
    add_box('GLASS', bucket_prefix + '_glass', (W, 0.03, H), (cx, at + 0.055 * sign, cz),
            glass_vc or VC['GLASS'])
    f = at + 0.095 * sign
    fw, fh = 0.055, 0.055
    # 外框
    strip_y('FRAME', bucket_prefix + '_fl', x0, x1, f, z0 + fh / 2, fh, 0.055)
    strip_y('FRAME', bucket_prefix + '_fu', x0, x1, f, z1 - fh / 2, fh, 0.055)
    strip_z('FRAME', bucket_prefix + '_fr0', x0 + fw / 2, f, z0, z1, 0.055)
    strip_z('FRAME', bucket_prefix + '_fr1', x1 - fw / 2, f, z0, z1, 0.055)
    # 竖梃 / 横梃
    for i in range(1, cols):
        strip_z('FRAME', '%s_mull%d' % (bucket_prefix, i), x0 + W * i / cols, f, z0, z1, 0.042)
    for j in range(1, rows):
        strip_y('FRAME', '%s_trans%d' % (bucket_prefix, j), x0, x1, f,
                z0 + H * j / rows, 0.042, 0.042)
    # 窗台 / 窗楣（混凝土挑板，制造真实进深阴影）
    add_box('WALL', bucket_prefix + '_sill', (W + 0.36, 0.26, 0.11),
            (cx, at + 0.14 * sign, z0 - 0.045), VC['WALL2'])
    add_box('WALL', bucket_prefix + '_lintel', (W + 0.36, 0.24, 0.10),
            (cx, at + 0.13 * sign, z1 + 0.06), VC['WALL2'])
    # 木格栅遮阳（部分窗）
    if wood_shade:
        for i in range(7):
            xx = x0 + 0.28 + (W - 0.56) * i / 6
            add_box('WOOD', '%s_shade%d' % (bucket_prefix, i), (0.075, 0.16, H * 0.86),
                    (xx, at + 0.30 * sign, cz), VC['WOOD2'])


def curtain_x(bucket_prefix, y0, y1, at, z0, z1, cols, rows, sign=1):
    """东/西立面幕墙：at=墙面 x，sign=+1 朝 +X，sign=-1 朝 -X。"""
    D, H = y1 - y0, z1 - z0
    cy, cz = (y0 + y1) / 2, (z0 + z1) / 2
    d = 0.02 * sign
    add_box('DARK', bucket_prefix + '_back', (0.04, D, H), (at + d, cy, cz), VC['DARK2'])
    add_box('GLASS', bucket_prefix + '_glass', (0.03, D, H), (at + 0.055 * sign, cy, cz), VC['GLASS2'])
    f = at + 0.095 * sign
    for i in range(cols + 1):
        yy = y0 + D * i / cols
        add_box('FRAME', '%s_mull%d' % (bucket_prefix, i), (0.055, 0.05, H), (f, yy, cz))
    for j in range(rows + 1):
        zz = z0 + H * j / rows
        add_box('FRAME', '%s_trans%d' % (bucket_prefix, j), (0.05, D, 0.05), (f, cy, zz))
    add_box('WALL', bucket_prefix + '_sill', (0.26, D + 0.3, 0.10),
            (at + 0.14 * sign, cy, z0 - 0.04), VC['WALL2'])


# ================================================================ A. 基座与三层错落体量
add_box('WALL', 'base_plinth', (20.8, 16.8, 0.30), (0, 0, 0.15), VC['WALL3'])
add_box('DARK', 'base_skirt', (20.9, 16.9, 0.10), (0, 0, 0.34), VC['DARK2'])

# 1F
add_box('WALL', 'core_1f', (19.4, 15.4, 3.10), (0, 0, 1.89), VC['WHITE'])
add_box('WALL', 'slab_1f', (20.8, 16.8, 0.24), (0, 0, 3.56), VC['WALL2'])
add_box('DARK', 'slab_1f_edge', (20.9, 16.9, 0.045), (0, 0, 3.435), VC['DARK2'])
# 2F（东侧退台 3.5m 做露台）
add_box('WALL', 'core_2f', (15.7, 15.4, 2.90), (-1.55, 0, 5.13), VC['WHITE'])
add_box('WALL', 'slab_2f', (20.8, 16.8, 0.22), (0, 0, 6.69), VC['WALL2'])
add_box('DARK', 'slab_2f_edge', (20.9, 16.9, 0.045), (0, 0, 6.575), VC['DARK2'])
# 3F
add_box('WALL', 'core_3f', (12.5, 15.4, 1.72), (-1.75, 0, 7.66), VC['WHITE'])
add_box('WALL', 'roof_slab', (13.3, 16.2, 0.20), (-1.75, 0, 8.62), VC['WALL2'])
add_box('DARK', 'roof_edge', (13.5, 16.4, 0.05), (-1.75, 0, 8.505), VC['DARK2'])
# 女儿墙
PY = 8.95
add_box('WALL', 'parapet_s', (13.3, 0.24, 0.48), (-1.75, 8.0, PY), VC['WALL2'])
add_box('WALL', 'parapet_n', (13.3, 0.24, 0.48), (-1.75, -8.0, PY), VC['WALL2'])
add_box('WALL', 'parapet_e', (0.24, 16.2, 0.48), (4.85, 0, PY), VC['WALL2'])
add_box('WALL', 'parapet_w', (0.24, 16.2, 0.48), (-8.35, 0, PY), VC['WALL2'])
# 层间腰线（四面）
for tag, yy, xx in (('s', 8.02, None), ('n', -8.02, None)):
    for lvz in (0.62, 3.30, 6.45):
        strip_y('WALL', 'belt_%s_%.2f' % (tag, lvz), -10.0, 10.0, yy, lvz, 0.09, 0.10, VC['WALL3'])
for tag, xx in (('e', 9.92), ('w', -9.92)):
    for lvz in (0.62, 3.30, 6.45):
        add_box('WALL', 'belt_%s_%.2f' % (tag, lvz), (0.10, 16.1, 0.09), (xx, 0, lvz), VC['WALL3'])

# 檐下灯带（8 条，夜间氛围）
for tag, yy in (('s', 8.36), ('n', -8.36)):
    strip_y('GLOW', 'eave_%s_1' % tag, -9.9, 9.9, yy, 3.41, 0.045, 0.045)
    strip_y('GLOW', 'eave_%s_2' % tag, -9.9, 9.9, yy, 6.55, 0.045, 0.045)
for tag, xx in (('e', 10.32), ('w', -10.32)):
    add_box('GLOW', 'eave_%s_1' % tag, (0.045, 16.0, 0.045), (xx, 0, 3.41))
    add_box('GLOW', 'eave_%s_2' % tag, (0.045, 16.0, 0.045), (xx, 0, 6.55))

# ================================================================ B. 1F 南立面（主视角）
# 入口门洞
add_box('DARK', 'entry_recess', (3.5, 0.06, 2.72), (0, 7.735, 1.70), VC['DARK2'])
# 双开门（独立 DOOR 桶，运行时命名 City/villa-door 供拾取）
for s in (-1, 1):
    add_box('DOOR', 'door_leaf_%d' % s, (1.62, 0.10, 2.58), (s * 0.83, 7.80, 1.65), VC['WHITE'])
    add_box('DOOR', 'door_panel_%d' % s, (1.34, 0.03, 1.02), (s * 0.83, 7.865, 2.14), VC['WOOD2'])
    add_box('DOOR', 'door_panel_lo_%d' % s, (1.34, 0.03, 0.96), (s * 0.83, 7.865, 1.06), VC['WOOD2'])
    add_box('FRAME', 'door_handle_%d' % s, (0.045, 0.075, 0.30), (s * 0.16, 7.90, 1.62), VC['FRAME2'])
# 门框 + 门楣
for s in (-1, 1):
    strip_z('FRAME', 'door_jamb_%d' % s, s * 1.76, 7.90, 0.34, 3.02, 0.10, VC['FRAME2'])
strip_y('FRAME', 'door_head', -1.80, 1.80, 7.90, 3.02, 0.10, 0.10, VC['FRAME2'])
# 左右落地幕墙
curtain_y('cw1_w', -8.90, -2.30, 7.72, 0.80, 3.10, 4, 2, VC['GLASS'], wood_shade=True)
curtain_y('cw1_e', 2.30, 8.90, 7.72, 0.80, 3.10, 4, 2, VC['GLASS'], wood_shade=True)
# 壁灯
for s in (-1, 1):
    add_box('GLOW', 'sconce_%d' % s, (0.14, 0.10, 0.42), (s * 2.02, 7.92, 2.32))
    add_box('FRAME', 'sconce_cap_%d' % s, (0.20, 0.14, 0.05), (s * 2.02, 7.92, 2.56), VC['FRAME2'])

# ================================================================ C. 门廊 / 雨棚 / 台阶
add_box('WALL', 'canopy', (6.8, 2.00, 0.22), (0, 8.70, 3.20), VC['WALL2'])
add_box('DARK', 'canopy_edge', (6.9, 2.10, 0.05), (0, 8.70, 3.075), VC['DARK2'])
strip_y('GLOW', 'canopy_light', -3.1, 3.1, 9.62, 3.075, 0.045, 0.045)
for s in (-1, 1):
    add_box('FRAME', 'porch_col_%d' % s, (0.18, 0.18, 2.86), (s * 3.15, 9.48, 1.77), VC['FRAME2'])
    add_box('WALL', 'porch_colbase_%d' % s, (0.30, 0.30, 0.16), (s * 3.15, 9.48, 0.42), VC['WALL3'])
# 雨棚下木格栅天花
for i in range(9):
    add_box('WOOD', 'canopy_slat_%d' % i, (0.055, 1.80, 0.055),
            (-2.8 + i * 0.70, 8.70, 3.055), VC['WOOD2'])
# 三级台阶（往南逐级下降）
for i, (yy, zz, ww) in enumerate(((8.35, 0.28, 4.8), (8.90, 0.19, 5.4), (9.45, 0.10, 6.0))):
    add_box('WALL', 'step_%d' % i, (ww, 0.55, zz + 0.06), (0, yy, (zz + 0.06) / 2), VC['WALL3'])
# 门牌灯箱
add_box('GLOW', 'door_plate', (0.72, 0.05, 0.20), (2.42, 7.92, 2.85))
add_box('FRAME', 'door_plate_frame', (0.80, 0.07, 0.26), (2.42, 7.90, 2.85), VC['FRAME2'])

# ================================================================ D. 2F / 3F 南面 + 阳台
curtain_y('cw2_s', -8.80, 5.60, 7.72, 4.05, 6.40, 6, 2, VC['GLASS2'])
curtain_y('cw3_s', -7.60, 3.80, 7.72, 7.05, 8.40, 5, 1, VC['GLASS2'])


def balcony(bucket_prefix, x0, x1, y, z0, z1):
    """玻璃栏板阳台：玻璃板 + 上扶手 + 立柱 + 底部基座。"""
    W = x1 - x0
    add_box('GLASS', bucket_prefix + '_panel', (W, 0.055, z1 - z0 - 0.12),
            ((x0 + x1) / 2, y, (z0 + z1) / 2), VC['GLASS2'])
    strip_y('FRAME', bucket_prefix + '_rail', x0 - 0.05, x1 + 0.05, y, z1, 0.055, 0.085, VC['FRAME2'])
    strip_y('FRAME', bucket_prefix + '_base', x0 - 0.05, x1 + 0.05, y, z0 + 0.04, 0.08, 0.10, VC['FRAME2'])
    n = max(2, int(W / 1.55))
    for i in range(n + 1):
        strip_z('FRAME', '%s_post%d' % (bucket_prefix, i), x0 + W * i / n, y, z0, z1, 0.075, VC['FRAME2'])


balcony('bal2_s', -9.20, 6.00, 8.36, 3.72, 4.72)
balcony('bal3_s', -8.10, 4.30, 8.36, 6.82, 7.72)
# 2F 南幕墙局部水平木百叶（暖色遮阳构件，打破全冷白蓝）
for i in range(8):
    strip_y('WOOD', 'cw2_brise_%d' % i, 1.90, 5.50, 7.98,
            4.20 + i * 0.28, 0.075, 0.10, VC['WOOD2'])
# 2F 东露台补全：铺装分格 + 南/北侧玻璃栏板（否则是悬空白平台）
add_box('WALL', 'terrace2_deck', (4.0, 15.2, 0.06), (8.25, 0, 3.71), VC['WALL3'])
for i in range(9):
    add_box('DARK', 'terrace2_joint_%d' % i, (3.9, 0.02, 0.012),
            (8.25, -7.0 + i * 1.75, 3.745), VC['DARK2'])
balcony('terrace2_s', 6.10, 10.20, 8.36, 3.72, 4.72)
balcony('terrace2_n', 6.10, 10.20, -8.36, 3.72, 4.72)
# 3F 退台露台（slab_2f 外露区）：铺装 + 东/南/北玻璃栏板 + 户外家具
add_box('WALL', 'terrace3_deck', (5.4, 15.6, 0.06), (7.65, 0, 6.83), VC['WALL3'])
for i in range(9):
    add_box('DARK', 'terrace3_joint_%d' % i, (5.3, 0.02, 0.012),
            (7.65, -7.0 + i * 1.75, 6.865), VC['DARK2'])
balcony('terrace3_s', 4.95, 10.20, 8.36, 6.82, 7.72)
balcony('terrace3_n', 4.95, 10.20, -8.36, 6.82, 7.72)
add_box('GLASS', 'terrace3_e_panel', (0.055, 15.4, 0.78), (10.28, 0, 7.27), VC['GLASS2'])
add_box('FRAME', 'terrace3_e_rail', (0.085, 15.6, 0.055), (10.28, 0, 7.70), VC['FRAME2'])
for i in range(10):
    strip_z('FRAME', 'terrace3_e_post%d' % i, 10.28, -7.2 + i * 1.6,
            6.82, 7.70, 0.07, VC['FRAME2'])
add_box('WOOD', 'terrace3_table', (1.80, 0.80, 0.07), (7.60, 3.00, 7.55), VC['WOOD2'])
for s2 in (-1, 1):
    add_box('FRAME', 'terrace3_leg_%d' % s2, (0.06, 0.06, 0.68),
            (7.60 + s2 * 0.72, 3.00, 7.20), VC['FRAME2'])
    add_box('WOOD', 'terrace3_chair_%d' % s2, (0.46, 0.46, 0.07),
            (7.60 + s2 * 1.30, 3.00, 7.20), VC['WOOD2'])
for i, cy in enumerate((-5.4, 5.6)):
    add_box('WALL', 'terrace3_planter_%d' % i, (1.30, 0.62, 0.42), (8.90, cy, 7.07), VC['WALL2'])
    add_box('GREEN', 'terrace3_plant_%d' % i, (1.16, 0.50, 0.24), (8.90, cy, 7.38), VC['GREEN2'])
# 东侧露台栏板（沿 x=+9.9 与南北两端）
add_box('GLASS', 'terrace_e_panel', (0.055, 15.0, 0.86), (10.28, 0, 4.20), VC['GLASS2'])
add_box('FRAME', 'terrace_e_rail', (0.085, 15.2, 0.055), (10.28, 0, 4.65), VC['FRAME2'])
for i in range(10):
    strip_z('FRAME', 'terrace_e_post%d' % i, 10.28, -7.2 + i * 1.6, 3.72, 4.65, 0.07, VC['FRAME2'])
# 露台家具：圆桌 + 两椅 + 遮阳伞
add_revolve('WOOD', 'terrace_table_top', [(0.62, 0.72), (0.62, 0.78)], (8.0, 2.4, 3.68), 10)
add_revolve('FRAME', 'terrace_table_leg', [(0.07, 0.0), (0.07, 0.72)], (8.0, 2.4, 3.68), 8, VC['FRAME2'])
for i, (cx, cz) in enumerate(((7.0, 2.4), (9.0, 2.4))):
    add_box('WOOD', 'terrace_chair_%d' % i, (0.48, 0.48, 0.08), (cx, cz, 4.13), VC['WOOD2'])
    add_box('WOOD', 'terrace_chair_back_%d' % i, (0.48, 0.07, 0.52), (cx, cz + 0.22, 4.42), VC['WOOD2'])
add_revolve('FRAME', 'umbrella_pole', [(0.035, 0.0), (0.035, 2.50)], (8.0, 2.4, 3.68), 8, VC['FRAME2'])
add_revolve('GREEN', 'umbrella_canopy', [(1.15, 2.18), (0.05, 2.52)], (8.0, 2.4, 3.68), 10, VC['GREEN2'])

# ================================================================ E. 东 / 西 / 北立面
# 竖向遮阳鳍片（西面 1F/2F，真实建筑语言）
for lv, (za, zb) in enumerate(((0.55, 3.30), (3.90, 6.50))):
    for i in range(11):
        yy = -7.2 + i * 1.44
        add_box('FRAME', 'fin_w%d_%d' % (lv, i), (0.16, 0.10, zb - za),
                (-9.78, yy, (za + zb) / 2), VC['FRAME2'])
# 东面 1F 竖鳍
for i in range(11):
    add_box('FRAME', 'fin_e_%d' % i, (0.16, 0.10, 2.70),
            (9.78, -7.2 + i * 1.44, 1.90), VC['FRAME2'])
# 条窗（西/东/北）
curtain_x('cw_w1', -6.2, -1.4, -9.72, 1.30, 2.60, 3, 1, -1)
curtain_x('cw_w2', 1.4, 6.2, -9.72, 4.40, 5.90, 3, 1, -1)
curtain_x('cw_e1', -6.2, -1.4, 9.72, 1.30, 2.60, 3, 1, 1)
curtain_y('cw_n1', -6.2, 6.2, -7.72, 1.30, 2.60, 5, 1,
          VC['GLASS2'], wood_shade=False, sign=-1)
# 北面服务门
add_box('DOOR', 'service_door', (1.10, 0.08, 2.20), (7.4, -7.80, 1.44), VC['WOOD2'])
strip_y('FRAME', 'service_frame', 6.75, 8.05, -7.90, 2.58, 0.09, 0.09, VC['FRAME2'])

# ================================================================ F. 屋顶设备层
for i, (cx, cy) in enumerate(((-5.0, -4.0), (-5.0, 4.0))):
    add_box('DARK', 'hvac_%d' % i, (1.25, 0.90, 0.72), (cx, cy, 9.08), VC['DARK2'])
    add_box('FRAME', 'hvac_cap_%d' % i, (1.33, 0.98, 0.06), (cx, cy, 9.47), VC['FRAME2'])
    for k in range(6):
        add_box('FRAME', 'hvac_grille_%d_%d' % (i, k), (1.10, 0.025, 0.045),
                (cx, cy - 0.47, 8.86 + k * 0.09), VC['FRAME2'])
# 太阳能板阵列（平铺 + 支架）
for i in range(3):
    for j in range(2):
        cx = -1.6 + i * 1.55
        cy = -4.2 + j * 2.30
        add_box('DARK', 'pv_%d_%d' % (i, j), (1.42, 2.10, 0.055), (cx, cy, 9.02), VC['DARK2'])
        add_box('GLASS', 'pv_face_%d_%d' % (i, j), (1.34, 2.02, 0.02), (cx, cy, 9.06), VC['GLASS2'])
        add_box('FRAME', 'pv_leg_%d_%d' % (i, j), (0.07, 0.07, 0.20), (cx, cy, 8.90), VC['FRAME2'])
# 屋顶通风帽
add_revolve('FRAME', 'roof_vent', [(0.30, 0.0), (0.30, 0.26), (0.42, 0.30)],
            (2.8, -5.2, 8.72), 8, VC['FRAME2'])

# ================================================================ G. 庭院景观
add_box('WALL', 'yard_paving', (24.0, 4.6, 0.10), (0, 9.90, 0.05), VC['WALL3'])
for i in range(7):
    strip_y('DARK', 'pave_joint_%d' % i, -11.8, 11.8, 8.0 + i * 0.64, 0.105, 0.012, 0.014, VC['DARK2'])
for s in (-1, 1):
    add_box('WALL', 'yard_wall_%d' % s, (3.4, 0.30, 0.62), (s * 9.3, 11.85, 0.36), VC['WALL2'])
    add_box('DARK', 'yard_wall_cap_%d' % s, (3.5, 0.36, 0.06), (s * 9.3, 11.85, 0.70), VC['DARK2'])
    # 绿化池
    add_box('WALL', 'planter_%d' % s, (1.9, 1.9, 0.44), (s * 7.6, 9.90, 0.27), VC['WALL2'])
    add_box('GREEN', 'planter_soil_%d' % s, (1.66, 1.66, 0.06), (s * 7.6, 9.90, 0.50), VC['GREEN2'])
    # 景观树：阔叶球形树冠（主冠 + 两个偏冠），避免松塔形卡通感
    add_revolve('WOOD', 'tree_trunk_%d' % s, [(0.13, 0.0), (0.11, 1.30)],
                (s * 7.6, 9.90, 0.50), 8, VC['WOOD2'])
    add_revolve('GREEN', 'tree_crown_main_%d' % s,
                [(0.05, 1.12), (0.55, 1.16), (0.92, 1.40), (0.95, 1.66),
                 (0.72, 1.92), (0.05, 2.08)],
                (s * 7.6, 9.90, 0.50), 10, VC['GREEN2'])
    for k, (dx, dy, sc) in enumerate(((0.52, 0.20, 0.70), (-0.46, -0.28, 0.62))):
        add_revolve('GREEN', 'tree_crown_sub_%d_%d' % (s, k),
                    [(0.05 * sc, 1.18), (0.62 * sc, 1.24), (0.80 * sc, 1.48),
                     (0.60 * sc, 1.72), (0.05 * sc, 1.86)],
                    (s * 7.6 + dx, 9.90 + dy, 0.50), 9,
                    VC['WHITE'] if k == 0 else VC['GREEN2'])
    # 灌木
    for k in range(3):
        add_revolve('GREEN', 'shrub_%d_%d' % (s, k), [(0.30, 0.0), (0.42, 0.28), (0.05, 0.58)],
                    (s * 5.2 + k * 0.75, 10.9, 0.10), 7, VC['GREEN2'])
    # 庭院灯
    add_revolve('FRAME', 'yard_lamp_post_%d' % s, [(0.045, 0.0), (0.045, 1.10)],
                (s * 3.9, 10.9, 0.10), 8, VC['FRAME2'])
    add_box('GLOW', 'yard_lamp_head_%d' % s, (0.22, 0.22, 0.16), (s * 3.9, 10.9, 1.22))

# ================================================================ 统计 / 轴变换校验 / 渲染 / 导出
def collect(parts):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    positions, normals, colors, indices = [], [], [], []
    base = 0
    for obj in parts:
        oe = obj.evaluated_get(depsgraph)
        me = oe.to_mesh()
        tris = me.calc_loop_triangles()
        if not tris:
            tris = me.loop_triangles
        vc = obj.get('vc', VC['WHITE'])
        for v in me.vertices:
            p = (v.co.x, v.co.z, -v.co.y)
            n = (v.normal.x, v.normal.z, -v.normal.y)
            positions += [round(p[0] * Q1000), round(p[1] * Q1000), round(p[2] * Q1000)]
            normals += [round(n[0] * Q1000), round(n[1] * Q1000), round(n[2] * Q1000)]
            colors += [round(vc[0] * Q255), round(vc[1] * Q255), round(vc[2] * Q255)]
        for t in tris:
            vs = [me.loops[l].vertex_index for l in t.loops]
            indices += [base + vs[0], base + vs[1], base + vs[2]]
        base += len(me.vertices)
        oe.to_mesh_clear()
    return {'position': positions, 'normal': normals, 'color': colors,
            'index': indices, 'tris': len(indices) // 3, 'verts': base}


data = {k: collect(v) for k, v in BUCKETS.items()}
for k in BUCKETS:
    print('[STATS] %-6s %5d verts / %5d tris' % (k, data[k]['verts'], data[k]['tris']))
total = sum(d['tris'] for d in data.values())
print('[STATS] TOTAL %d tris (budget %d)' % (total, TRI_BUDGET))
assert 0 < total <= TRI_BUDGET, '面数超预算 %d' % total

# 轴变换 + 尺寸断言：Three 语义 y=高度 0..9.6m，x ±12m，z ±12m（庭院铺装外扩）
allpos = [v for d in data.values() for v in d['position']]
for axis, (lo, hi) in ((1, (-100, 9900)), (0, (-12500, 12500)), (2, (-12500, 12500))):
    vals = allpos[axis::3]
    assert min(vals) >= lo and max(vals) <= hi, (axis, min(vals), max(vals))
print('AXIS_CHECK_OK  y[%d,%d] x[%d,%d] z[%d,%d]' % (
    min(allpos[1::3]), max(allpos[1::3]), min(allpos[0::3]), max(allpos[0::3]),
    min(allpos[2::3]), max(allpos[2::3])))

# ---------------------------------------------------------------- 预览渲染
# 地面（不导出，仅渲染用）
_ground_vs = [(-45, -45, -0.04), (-45, 45, -0.04), (45, 45, -0.04), (45, -45, -0.04)]
_ground_mesh = bpy.data.meshes.new('ground')
_ground_mesh.from_pydata(_ground_vs, [], [(0, 1, 2, 3)])
_ground_mesh.update()
_g = bpy.data.objects.new('ground', _ground_mesh)
link(_g)
_ground_mesh.materials.append(make_mat('Ground', (0.55, 0.56, 0.55), 0.0, 0.95))

cam_data = bpy.data.cameras.new('cam')
cam_data.lens = 38
cam = bpy.data.objects.new('cam', cam_data)
link(cam)
cam.location = (19.0, 27.0, 14.5)
direction = Vector((0, 1.0, 4.2)) - cam.location
cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.camera = cam

world = bpy.data.worlds.new('world')
world.use_nodes = True
for n in world.node_tree.nodes:
    if n.type == 'BACKGROUND':
        n.inputs[0].default_value = (0.78, 0.83, 0.90, 1.0)
        n.inputs[1].default_value = 0.85
bpy.context.scene.world = world

sun_data = bpy.data.lights.new('sun', 'SUN')
sun_data.energy = 2.2
sun_data.angle = math.radians(7)
sun = bpy.data.objects.new('sun', sun_data)
link(sun)
sun.rotation_euler = (math.radians(38), math.radians(-24), math.radians(28))

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 48
scene.render.resolution_x = 1200
scene.render.resolution_y = 750
scene.render.filepath = OUT_PNG
bpy.ops.render.render(write_still=True)
print('RENDER_OK ->', OUT_PNG)

# ---------------------------------------------------------------- 生成 JS 模块
def js_array(nums, per_line=12):
    lines = []
    for i in range(0, len(nums), per_line):
        lines.append(','.join(str(v) for v in nums[i:i + per_line]))
    return '[\n' + ',\n'.join(lines) + '\n]'


def js_bucket(name, d):
    return ("const %s = {\n" % name) \
        + "  position: " + js_array(d['position']) + ",\n" \
        + "  normal: " + js_array(d['normal']) + ",\n" \
        + "  color: " + js_array(d['color']) + ",\n" \
        + "  index: " + js_array(d['index']) + ",\n};"


buckets_js = '\n\n'.join(js_bucket(k, data[k]) for k in BUCKETS)
parts_js = '\n'.join('    %s: build(%s),' % (k, k) for k in BUCKETS)

js = '''// 由 tools/blender/build_city_villa.py 生成（Blender 3.6 建模），勿手改。
// 都会区「我的别墅」外壳精修：三层错落体量 / 内凹玻璃幕墙 / 挑檐腰线 / 玻璃栏板阳台 /
// 雨棚门廊 / 屋顶设备层 / 庭院景观。按材质分 8 桶，运行时沿用现有 MeshStandardMaterial 体系。
// 坐标：几何原点 = 建筑中心地面，Blender +Y(南) 已转换为 Three -Z。
// 由 city-villa.js 统一 translate 到 CITY_VILLA 世界坐标。position/normal 毫米整数(÷1000)，color 0-255(÷255)。
import * as THREE from 'three';

%s

function build(d) {
  const g = new THREE.BufferGeometry();
  const f = (a) => Float32Array.from(a, (v) => v / 1000);
  const c = (a) => Float32Array.from(a, (v) => v / 255);
  g.setAttribute('position', new THREE.BufferAttribute(f(d.position), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(f(d.normal), 3));
  g.setAttribute('color', new THREE.BufferAttribute(c(d.color), 3));
  g.setIndex(d.index);
  return g;
}

/** 都会区别墅外壳：按材质分桶的 BufferGeometry（未平移，调用方负责 translate）。 */
export function createVillaShellParts() {
  return {
%s
  };
}

/** 外壳总三角面数（预算台账用）。 */
export const VILLA_SHELL_TRIS = %d;
''' % (buckets_js, parts_js, total)

os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
with open(OUT_JS, 'w', encoding='utf-8') as fh:
    fh.write(js)
print('JS_OK ->', OUT_JS, '(%d bytes)' % os.path.getsize(OUT_JS))
print('CITY_VILLA_BUILD_OK')
