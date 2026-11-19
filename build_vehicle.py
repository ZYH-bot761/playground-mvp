# -*- coding: utf-8 -*-
"""使用本地 Blender 建模车辆并导出 glb。
- 整车：车身 / 车窗 / 车门 / 4 轮（轮毂 + 轮辐）/ 保险杠 / 灯 / 格栅 / 镜
- PBR 材质：车身金属漆（含 clearcoat）、玻璃、橡胶轮子、门/镜深色金属、灯
- 尺度：车身长度 4.5m
- 范围：仅车辆
"""
import math
import bpy
from mathutils import Quaternion, Vector

OUT = r"D:\playground-mvp\models\vehicle.glb"

# ---------------------------------------------------------------- 基础工具
def prim(o_name, op, **kw):
    bpy.ops.object.select_all(action='DESELECT')
    op_attr = getattr(bpy.ops.mesh, op)
    op_attr(enter_editmode=False, **kw)
    return bpy.context.active_object

def sett(o, loc=(0, 0, 0), scale=(1, 1, 1), rot=None):
    o.location = loc
    o.scale = scale
    if rot is not None:
        o.rotation_euler = rot
    return o

def cross(u, v):
    return Vector((u.y * v.z - u.z * v.y,
                  u.z * v.x - u.x * v.z,
                  u.x * v.y - u.y * v.x))

def norm(v):
    return v.normalized()

def align_obj(o, local_axis, world_dir):
    """把物体的局部轴对齐到世界方向（通过旋转四元数，再转 Euler 写入）。"""
    a = Vector(local_axis)
    d = Vector(world_dir).normalized()
    ax = cross(a, d).normalized()
    dot = a.dot(d)
    ang = 2.0 * math.acos(max(-1.0, min(1.0, dot)))
    q = Quaternion(ax, ang)
    euler = q.to_euler()
    o.rotation_mode = 'XYZ'
    o.rotation_euler = euler
    return o

def wheel_radials(axis):
    """车轮四轴方向（与轮轴垂直的 4 个方向）。"""
    if abs(axis[0]) > 0.9:
        return [(0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
    return [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0)]

# ---------------------------------------------------------------- PBR 材质
def make_mat(name, base, metallic, roughness, clearcoat=0.0, cc_rough=0.0,
             transmission=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    prin = None
    for n in mat.node_tree.nodes:
        if 'Principled' in n.name or (n.type and 'PRINCIPLED' in n.type):
            prin = n
            break
    if prin is None:
        raise RuntimeError('找不到 Principled BSDF 节点')
    inp = {
        'Base Color': (base[0], base[1], base[2], base[3]),
        'Metallic': metallic,
        'Roughness': roughness,
        'Clearcoat': clearcoat,
        'Clearcoat Roughness': cc_rough,
        'Transmission': transmission,
    }
    for k, v in inp.items():
        if k in prin.inputs:
            prin.inputs[k].default_value = v
    return mat

PAPER = make_mat('VehicleMetallicPaint', (0.95, 0.18, 0.14, 1.0), 1.0, 0.26,
                  clearcoat=0.35, cc_rough=0.2)
PAPER_DARK = make_mat('VehiclePaintDark', (0.20, 0.15, 0.11, 1.0), 1.0, 0.38,
                      clearcoat=0.15, cc_rough=0.0)
GLASS = make_mat('VehicleGlass', (0.55, 0.85, 0.95, 1.0), 1.0, 0.08,
                 clearcoat=0.1, transmission=1.0)
RUBBER = make_mat('VehicleRubber', (0.14, 0.12, 0.11, 1.0), 0.0, 0.82)
LIGHT = make_mat('VehicleLight', (0.92, 0.90, 0.88, 1.0), 0.35, 0.18,
                 clearcoat=0.6)
TAIL = make_mat('VehicleTaillight', (0.65, 0.08, 0.08, 1.0), 0.7, 0.25)

def assign(mat, mesh):
    mesh.data.materials.append(mat)

scene = bpy.context.scene
all_meshes = []

# ---------------------------------------------------------------- 车身主体
def add_box(name, size, loc, mat):
    w, h, d = (size + (0, 0, 0))[:3]
    o = prim(name, 'primitive_cube_add', size=max(w, h, d))
    sett(o, loc, scale=(w, h, d))
    assign(mat, o)
    all_meshes.append(o)
    return o

add_box('chassis', (1.8, 0.9, 4.5), (0, 0, 0), PAPER)   # 底盘：长4.5m
add_box('cabin', (1.15, 0.85, 2.0), (0, 1.20, 0.05), PAPER)  # 座舱
add_box('bumper_front', (1.85, 0.10, 2.0), (0, 0.09, 0.30), PAPER_DARK)
add_box('bumper_rear', (1.85, 0.10, 2.2), (0, 0.09, -0.10), PAPER_DARK)
add_box('sill_left', (0.10, 0.14, 2.2), (-0.95, 0.07, 0.0), PAPER_DARK)
add_box('sill_right', (0.10, 0.14, 2.2), (0.95, 0.07, 0.0), PAPER_DARK)
add_box('subframe', (0.05, 0.10, 4.5), (-0.42, 0.05, 0.0), PAPER_DARK)
add_box('grille_front', (1.80, 0.10, 0.30), (0, 0.40, 0.15), LIGHT)
add_box('headlight_left', (0.50, 0.25, 0.25), (-0.25, 0.62, 2.22), LIGHT)
add_box('headlight_right', (0.50, 0.25, 0.25), (0.25, 0.62, 2.22), LIGHT)
add_box('taillight_left', (0.50, 0.25, 0.25), (-0.25, 0.72, -2.30), TAIL)
add_box('taillight_right', (0.50, 0.25, 0.25), (0.25, 0.72, -2.30), TAIL)
add_box('mirror_left', (0.12, 0.30, 0.30), (-1.02, 0.82, 0.20), PAPER_DARK)
add_box('mirror_right', (0.12, 0.30, 0.30), (1.02, 0.82, 0.20), PAPER_DARK)

# ---------------------------------------------------------------- 座舱内部：窗 / 门
def add_rect(name, size, loc, mat):
    w, h, dz = (size + (0, 0, 0))[:3]
    o = prim(name, 'primitive_plane_add', size=1.0)
    sett(o, loc, scale=(w, h, 1.0))
    assign(mat, o)
    all_meshes.append(o)
    return o

add_rect('rear_window', (1.10, 0.65, 1.0), (0, 1.15, 0.98), GLASS)
add_rect('window_left', (0.60, 0.65, 1.0), (-0.56, 1.15, 0.40), GLASS)
add_rect('window_right', (0.60, 0.65, 1.0), (0.56, 1.15, 0.40), GLASS)
add_box('door_left', (0.60, 0.30, 1.10), (-0.56, 0.92, 0.05), PAPER_DARK)
add_box('door_right', (0.60, 0.30, 1.10), (0.56, 0.92, 0.05), PAPER_DARK)
add_box('hatch_front', (1.00, 0.25, 0.20), (0, 0.92, 0.90), PAPER_DARK)

# ---------------------------------------------------------------- 车轮（4 个：轮胎 + 轮毂 + 轮辐）
W_HEAD_Y = 0.46

def add_wheel(name, cx, cz, wheel_axis):
    # 轮胎：圆柱，默认轴 Y
    o = prim(name + '_tire', 'primitive_cylinder_add', radius=0.45, depth=0.10,
             vertices=32, end_fill_type='NGON')
    align_obj(o, Vector((0, 1, 0)), wheel_axis)
    sett(o, (cx, W_HEAD_Y, cz))
    assign(RUBBER, o)
    all_meshes.append(o)

    # 轮毂：更小的圆柱，同方向
    o = prim(name + '_hub', 'primitive_cylinder_add', radius=0.13, depth=0.05,
             vertices=24, end_fill_type='NGON')
    align_obj(o, Vector((0, 1, 0)), wheel_axis)
    sett(o, (cx, W_HEAD_Y, cz))
    assign(RUBBER, o)
    all_meshes.append(o)

    for rd in wheel_radials(wheel_axis):
        o = prim(name + '_spoke', 'primitive_cube_add', size=0.3)
        sett(o, (cx, W_HEAD_Y, cz), scale=(0.05, 0.05, 0.3))
        assign(RUBBER, o)
        all_meshes.append(o)

front = (0, 2.15, (0, 0, 1))
back = (0, -2.15, (0, 0, -1))
left = (-0.90, 0.0, (1, 0, 0))
right = (0.90, 0.0, (-1, 0, 0))
for (cx, cz, d) in [front, back, left, right]:
    add_wheel('wheel', cx, cz, d)

# ---------------------------------------------------------------- 导出 glb
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB')
print('VEHICLE_OK', len(all_meshes), 'meshes ->', OUT)
