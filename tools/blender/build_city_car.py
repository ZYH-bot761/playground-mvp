# -*- coding: utf-8 -*-
"""Blender 3.6 无头建模：都会区 Q 版轿车（车身 + 玻璃舱两个几何桶）。

Blender 侧用 Z-up 惯例建模（车头 -Y、高度 +Z、宽 X），导出时做轴变换
(x, y, z)_blender -> (x, z, -y)_three（det=+1，手性不变）：
车头 -Y -> three +Z 车头、高度 Z -> three Y。法线同变换。

产物：
- D:/playground-mvp/models/blender-car-preview.png   Cycles CPU 预览渲染（人工验收）
- D:/playground-mvp/src/scenes/metropolis/city-car-blender-model.js  量化几何数据 JS 模块

运行时语义（与 src/scenes/metropolis/city-traffic.js 实例矩阵对齐，勿改动）：
- body geometry 原点 = AI 车实例位置（世界 y=1.435），占 x[-.5,.5] z[-1.075,1.075] y[-.275,.275]。
- cabin geometry 原点 = 玻璃舱实例位置（世界 y=1.96），底沿下探保证与车身无缝。
- 顶点色：主壳/尾翼=白（×instanceColor=车漆色），深色件=深灰，灯框/车牌=浅灰。
- wheel 保留 city-traffic.js 的 detailedWheelGeometry，本脚本不建模轮子。
"""
import math
import os

import bmesh
import bpy
from mathutils import Vector

ROOT = r"D:\playground-mvp"
OUT_JS = os.path.join(ROOT, "src", "scenes", "metropolis", "city-car-blender-model.js")
OUT_PNG = os.path.join(ROOT, "models", "blender-car-preview.png")

Q1000 = 1000
Q255 = 255

for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

# ---------------------------------------------------------------- 材质（仅预览用）
def make_mat(name, color, metallic, roughness, transmission=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    for n in mat.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            n.inputs['Base Color'].default_value = (*color, 1.0)
            n.inputs['Metallic'].default_value = metallic
            n.inputs['Roughness'].default_value = roughness
            if transmission > 0 and 'Transmission' in n.inputs:
                n.inputs['Transmission'].default_value = transmission
            break
    return mat

MAT_PAINT = make_mat('PaintBlue', (0.12, 0.30, 0.62), 0.6, 0.25)
MAT_DARK = make_mat('TrimDark', (0.05, 0.05, 0.055), 0.3, 0.5)
MAT_LIGHT = make_mat('TrimLight', (0.85, 0.83, 0.78), 0.2, 0.4)
MAT_GLASS = make_mat('GlassDark', (0.04, 0.09, 0.12), 0.5, 0.1, transmission=0.25)

VC_WHITE = (1.0, 1.0, 1.0)
VC_DARK = (0.16, 0.155, 0.15)
VC_LIGHT = (0.88, 0.86, 0.82)

# ---------------------------------------------------------------- 建模工具
# Blender 侧语义：x=宽（±半宽），y=车长（车头 -Y），z=高度。
def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj

def _recalc(mesh):
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

def _finish(obj, mat, vc, bevel, smooth):
    obj.data.materials.append(mat)
    if smooth:
        for p in obj.data.polygons:
            p.use_smooth = True
        obj.data.use_auto_smooth = True
        obj.data.auto_smooth_angle = math.radians(34)
    else:
        for p in obj.data.polygons:
            p.use_smooth = False
    if bevel > 0:
        m = obj.modifiers.new('Bevel', 'BEVEL')
        m.width = bevel
        m.segments = 2
        m.limit_method = 'ANGLE'
        m.angle_limit = math.radians(52)
    obj['vc'] = vc
    return obj

def add_loft(name, profiles, mat, vc, bevel=0.0, smooth=True):
    """沿 y（车长）放样：profiles=[(y, halfWidth, zBot, zTop)]，截面 4 点首尾封口。"""
    verts, faces = [], []
    n = len(profiles)
    for (y, hw, zb, zt) in profiles:
        verts += [(-hw, y, zb), (-hw, y, zt), (hw, y, zt), (hw, y, zb)]
    for i in range(n - 1):
        a, b = i * 4, (i + 1) * 4
        faces += [(a + 0, b + 0, b + 1, a + 1),   # 左侧
                  (a + 1, b + 1, b + 2, a + 2),   # 顶
                  (a + 2, b + 2, b + 3, a + 3),   # 右
                  (a + 3, b + 3, b + 0, a + 0)]   # 底
    faces.append((3, 2, 1, 0))                     # 车尾端面（y 最大）
    s = (n - 1) * 4
    faces.append((s + 0, s + 1, s + 2, s + 3))     # 车头端面
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    mesh.validate()
    _recalc(mesh)
    obj = bpy.data.objects.new(name, mesh)
    link(obj)
    return _finish(obj, mat, vc, bevel, smooth)

def add_box(name, size, loc, mat, vc, bevel=0.008):
    """size=(宽, 长, 高)，loc=(x, y车长, z高度)。"""
    w, l, h = size
    x, y, z = loc
    hx, hy, hz = w / 2, l / 2, h / 2
    vs = [(-hx, -hy, -hz), (-hx, -hy, hz), (-hx, hy, -hz), (-hx, hy, hz),
          (hx, -hy, -hz), (hx, -hy, hz), (hx, hy, -hz), (hx, hy, hz)]
    fs = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4),
          (2, 6, 7, 3), (1, 3, 7, 5), (0, 4, 6, 2)]
    vs = [(vx + x, vy + y, vz + z) for (vx, vy, vz) in vs]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vs, [], fs)
    mesh.update()
    mesh.validate()
    _recalc(mesh)
    obj = bpy.data.objects.new(name, mesh)
    link(obj)
    return _finish(obj, mat, vc, bevel, smooth=False)

def add_fender(name, cy, side, mat, vc):
    """轮眉：半环管贴车身侧壁，环绕轮心 (z=0 高度, y=cy 车长位)，厚度沿 X。"""
    R_OUT, R_IN = 0.300, 0.225
    A0, A1 = 0.12 * math.pi, 0.88 * math.pi
    SEG, THICK = 9, 0.06
    x_out = side * (0.500 + THICK / 2)
    x_in = side * (0.500 - THICK / 2)
    verts, faces = [], []
    for i in range(SEG + 1):
        t = A0 + (A1 - A0) * i / SEG
        zo, yo = R_OUT * math.sin(t), cy - R_OUT * math.cos(t)
        zi, yi = R_IN * math.sin(t), cy - R_IN * math.cos(t)
        base = len(verts)
        verts += [(x_out, yo, zo), (x_in, yo, zo), (x_out, yi, zi), (x_in, yi, zi)]
        if i > 0:
            p = base - 4
            faces += [(p + 0, p + 1, base + 1, base + 0),
                      (p + 2, base + 2, base + 3, p + 3),
                      (p + 0, base + 0, base + 2, p + 2),
                      (p + 1, p + 3, base + 3, base + 1)]
    a, b = 0, SEG * 4
    faces += [(a + 0, a + 2, a + 3, a + 1), (b + 1, b + 3, b + 2, b + 0)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    mesh.validate()
    _recalc(mesh)
    obj = bpy.data.objects.new(name, mesh)
    link(obj)
    return _finish(obj, mat, vc, 0.0, smooth=True)

# ---------------------------------------------------------------- 车身桶
# 主壳：低前鼻 + 缓斜引擎盖 + 平腰线 + 微溜后备箱（车头 -Y；高度相对实例原点 ±.275）
BODY_PROFILES = [   # (y车长, 半宽, z底, z顶)
    ( 1.075, 0.420, -0.275, 0.100),   # 车尾
    ( 0.960, 0.475, -0.275, 0.170),
    ( 0.500, 0.500, -0.275, 0.210),
    (-0.100, 0.500, -0.275, 0.235),
    (-0.500, 0.495, -0.275, 0.210),
    (-0.880, 0.465, -0.275, 0.155),
    (-1.075, 0.420, -0.275, 0.100),   # 车头
]
body_parts = []
body_parts.append(add_loft('shell', BODY_PROFILES, MAT_PAINT, VC_WHITE, bevel=0.02))
body_parts.append(add_box('bumper_front', (0.90, 0.09, 0.16), (0, -1.052, -0.16), MAT_DARK, VC_DARK))
body_parts.append(add_box('bumper_rear', (0.90, 0.09, 0.16), (0, 1.052, -0.16), MAT_DARK, VC_DARK))
body_parts.append(add_box('grille', (0.40, 0.045, 0.085), (0, -1.078, 0.010), MAT_DARK, VC_DARK))
body_parts.append(add_box('grille_bar', (0.34, 0.03, 0.02), (0, -1.062, 0.075), MAT_LIGHT, VC_LIGHT))
body_parts.append(add_box('plate_front', (0.26, 0.02, 0.09), (0, -1.100, -0.155), MAT_LIGHT, VC_LIGHT))
body_parts.append(add_box('plate_rear', (0.26, 0.02, 0.09), (0, 1.100, -0.155), MAT_LIGHT, VC_LIGHT))
for sx in (-1, 1):
    body_parts.append(add_box('headlight_%d' % sx, (0.17, 0.06, 0.095), (sx * 0.31, -1.048, -0.100), MAT_LIGHT, VC_LIGHT))
    body_parts.append(add_box('taillight_%d' % sx, (0.17, 0.06, 0.085), (sx * 0.33, 1.052, -0.030), MAT_DARK, VC_DARK))
    body_parts.append(add_box('skirt_%d' % sx, (0.055, 1.32, 0.09), (sx * 0.502, 0.0, -0.215), MAT_DARK, VC_DARK))
    body_parts.append(add_box('mirror_%d' % sx, (0.08, 0.06, 0.05), (sx * 0.550, -0.30, 0.115), MAT_DARK, VC_DARK))
    body_parts.append(add_box('mirror_arm_%d' % sx, (0.05, 0.04, 0.025), (sx * 0.505, -0.32, 0.100), MAT_DARK, VC_DARK))
    body_parts.append(add_box('handle_%d' % sx, (0.035, 0.13, 0.045), (sx * 0.512, -0.12, 0.045), MAT_LIGHT, VC_LIGHT))
body_parts.append(add_box('spoiler', (0.44, 0.15, 0.035), (0, 0.870, 0.245), MAT_PAINT, VC_WHITE, bevel=0.01))
body_parts.append(add_box('spoiler_leg_l', (0.045, 0.10, 0.055), (-0.15, 0.870, 0.205), MAT_DARK, VC_DARK))
body_parts.append(add_box('spoiler_leg_r', (0.045, 0.10, 0.055), (0.15, 0.870, 0.205), MAT_DARK, VC_DARK))
body_parts.append(add_box('exhaust', (0.11, 0.06, 0.055), (-0.30, 1.075, -0.235), MAT_DARK, VC_DARK))
for cy in (-0.68, 0.68):
    for sx in (-1, 1):
        body_parts.append(add_fender('fender_%d_%d' % (sx, int(cy * 100)), cy, sx, MAT_DARK, VC_DARK))

# ---------------------------------------------------------------- 玻璃舱桶
CABIN_PROFILES = [  # (y车长, 半宽, z底, z顶) —— 收窄加高，座舱轮廓立起来
    ( 0.610, 0.300, -0.300, 0.170),
    ( 0.400, 0.335, -0.300, 0.270),
    ( 0.100, 0.345, -0.300, 0.300),
    (-0.150, 0.330, -0.300, 0.275),
    (-0.400, 0.295, -0.300, 0.160),
    (-0.550, 0.270, -0.300, 0.030),
    (-0.630, 0.255, -0.300, -0.070),
]
cabin_parts = [add_loft('greenhouse', CABIN_PROFILES, MAT_GLASS, VC_WHITE, bevel=0.012)]
cabin_parts.append(add_box('apillar_l', (0.035, 0.55, 0.05), (-0.245, -0.430, 0.100), MAT_DARK, VC_DARK, bevel=0.006))
cabin_parts.append(add_box('apillar_r', (0.035, 0.55, 0.05), (0.245, -0.430, 0.100), MAT_DARK, VC_DARK, bevel=0.006))
cabin_parts.append(add_box('roof_rail', (0.40, 0.50, 0.03), (0, 0.060, 0.295), MAT_DARK, VC_DARK, bevel=0.006))

# ---------------------------------------------------------------- 预览渲染布景
ground = bpy.data.meshes.new('ground')
gw = 12.0
ground.from_pydata(
    [(-gw, -gw, -0.42), (gw, -gw, -0.42), (gw, gw, -0.42), (-gw, gw, -0.42)],
    [], [(0, 1, 2, 3)])
ground.update()
ground_obj = bpy.data.objects.new('ground', ground)
link(ground_obj)
ground_obj.data.materials.append(make_mat('Ground', (0.55, 0.56, 0.58), 0.0, 0.9))

def add_light(name, kind, loc, energy, size=None):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = energy
    if size and kind == 'AREA':
        ld.size = size
    lo = bpy.data.objects.new(name, ld)
    lo.location = loc
    link(lo)
    return lo

add_light('key', 'SUN', (3, -4, 6), 3.0)
add_light('fill', 'AREA', (-3.5, 2.5, 3.0), 320.0, size=4.0)

cam_data = bpy.data.cameras.new('cam')
cam_data.lens = 52
cam = bpy.data.objects.new('cam', cam_data)
link(cam)
cam.location = (4.0, -3.6, 2.0)
direction = Vector((0, 0, 0.15)) - cam.location
cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.camera = cam

world = bpy.data.worlds.new('world')
world.use_nodes = True
for n in world.node_tree.nodes:
    if n.type == 'BACKGROUND':
        n.inputs[0].default_value = (0.92, 0.92, 0.95, 1.0)
        n.inputs[1].default_value = 0.9
bpy.context.scene.world = world

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 64
scene.render.resolution_x = 960
scene.render.resolution_y = 540
scene.render.filepath = OUT_PNG

# ---------------------------------------------------------------- 收集桶数据（含轴变换到 three 语义）
def xf(co):
    return (co.x, co.z, -co.y)

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
        vc = obj.get('vc', VC_WHITE)
        for v in me.vertices:
            p = xf(v.co)
            n = xf(v.normal)
            positions += [round(p[0] * Q1000), round(p[1] * Q1000), round(p[2] * Q1000)]
            normals += [round(n[0] * Q1000), round(n[1] * Q1000), round(n[2] * Q1000)]
            colors += [round(vc[0] * Q255), round(vc[1] * Q255), round(vc[2] * Q255)]
        for t in tris:
            vs = [me.loops[l].vertex_index for l in t.loops]
            indices += [base + vs[0], base + vs[1], base + vs[2]]
        base += len(me.vertices)
        oe.to_mesh_clear()
    tris_n = len(indices) // 3
    return {'position': positions, 'normal': normals, 'color': colors,
            'index': indices, 'tris': tris_n, 'verts': base}

body_data = collect(body_parts)
cabin_data = collect(cabin_parts)
print('[STATS] body: %d verts / %d tris' % (body_data['verts'], body_data['tris']))
print('[STATS] cabin: %d verts / %d tris' % (cabin_data['verts'], cabin_data['tris']))
total = body_data['tris'] + cabin_data['tris']
print('[STATS] total: %d tris' % total)
assert total <= 6000, '面数超预算: %d' % total

# 轴变换正确性断言：three 语义下车身 y 范围 [-275,235]、z 范围 [-1075,1075]、车头 +Z
for nm, d, (lo, hi) in (('body-y', body_data, (-300, 330)), ('body-z', body_data, (-1120, 1120))):
    axis = 1 if nm.endswith('y') else 2
    vals = [d['position'][i] for i in range(axis, len(d['position']), 3)]
    assert min(vals) >= lo and max(vals) <= hi, (nm, min(vals), max(vals))
print('AXIS_CHECK_OK')

# ---------------------------------------------------------------- 渲染预览
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

js = '''// 由 tools/blender/build_city_car.py 生成（Blender 3.6 无头建模），勿手改。
// Q 版轿车：车身桶(顶点色×instanceColor=车漆) + 玻璃舱桶。原点与 city-traffic.js 实例矩阵语义对齐。
// position/normal 量化为毫米整数(÷%d)，color 为 0-255(÷%d)。
import * as THREE from 'three';

%s

%s

function build(d) {
  const g = new THREE.BufferGeometry();
  const f = (a) => Float32Array.from(a, (v) => v / %d);
  const c = (a) => Float32Array.from(a, (v) => v / %d);
  g.setAttribute('position', new THREE.BufferAttribute(f(d.position), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(f(d.normal), 3));
  g.setAttribute('color', new THREE.BufferAttribute(c(d.color), 3));
  g.setIndex(d.index);
  return g;
}

/** 车身（含保险杠/格栅/灯框/轮眉/尾翼等，顶点色：白=车漆区，深/浅灰=饰件）。 */
export function createCarBodyGeometry() { return build(BODY); }
/** 玻璃舱（座舱壳 + A 柱饰条 + 车顶密封条）。 */
export function createCarCabinGeometry() { return build(CABIN); }
''' % (Q1000, Q255, js_bucket('BODY', body_data), js_bucket('CABIN', cabin_data), Q1000, Q255)

os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
with open(OUT_JS, 'w', encoding='utf-8') as fh:
    fh.write(js)
print('JS_OK ->', OUT_JS, '(%d bytes)' % os.path.getsize(OUT_JS))
print('CITY_CAR_BUILD_OK')
