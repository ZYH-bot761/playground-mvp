# -*- coding: utf-8 -*-
"""阶段1：四区布局（地面/围栏/文字标牌）+ 游乐场代理集合 + 水体/障碍物。"""
import bpy, math, os, json, sys
sys.path.insert(0, r"D:\playground-mvp\zoo")
import zoo_lib as Z
from zoo_lib import MB, box, cyl, cone, sphere, make_mat, collection, text_object, poly_curve

scene = bpy.context.scene
os.makedirs(Z.OUT_DIR, exist_ok=True)

# 隐藏出厂默认物体（不删除、不移动、不改材质；它们不属于游乐场资产）
for o in list(scene.objects):
    if o.name in ("Cube", "Camera", "Light"):
        o.hide_render = True
        o.hide_viewport = True

def M(name, color, **kw):
    return bpy.data.materials.get(name) or make_mat(name, color, **kw)

MAT = {
    "pg_ground": M("PG_Concrete", (0.72, 0.75, 0.70, 1)),
    "pg_plaza": M("PG_Plaza", (0.86, 0.82, 0.70, 1)),
    "pg_red": M("PG_CarouselRed", (0.80, 0.25, 0.30, 1)),
    "pg_cream": M("PG_CarouselCream", (0.96, 0.88, 0.72, 1)),
    "pg_gold": M("PG_Gold", (0.88, 0.68, 0.22, 1), metallic=0.35, roughness=0.4),
    "pg_blue": M("PG_CoasterBlue", (0.18, 0.42, 0.78, 1)),
    "pg_wood": M("PG_Wood", (0.48, 0.32, 0.18, 1)),
    "pg_water": M("PG_FountainWater", (0.35, 0.70, 0.92, 1), alpha=0.45, roughness=0.15),
    "fence": M("Zoo_FenceWood", (0.42, 0.29, 0.16, 1)),
    "board": M("Zoo_SignBoard", (0.20, 0.16, 0.13, 1)),
    "text": M("Zoo_SignText", (0.98, 0.96, 0.86, 1), roughness=0.5),
    "water": M("Zoo_Water", (0.16, 0.52, 0.85, 1), alpha=0.16, roughness=0.08),
    "rock": M("Zoo_Rock", (0.52, 0.50, 0.46, 1)),
    "tree": M("Zoo_TreeTrunk", (0.36, 0.24, 0.13, 1)),
    "leaf": M("Zoo_TreeLeaf", (0.20, 0.48, 0.20, 1)),
}

# ---------------- 游乐场代理（既有场景的参照，单独集合，不改动任何既有物体） ----------------
pg = collection("playground_existing_proxy")
pg["note"] = "No .blend playground scene existed; low-poly proxy of the Three.js playground facilities."
pg["bounds"] = "x[-30,30] y[-30,30] z[0,12]"

MB().add(box(60, 60, 0.3), off=(0, 0, -0.15)).build("PG_Ground", pg, [MAT["pg_ground"]])
MB().add(cyl(7.5, 0.25, 20), off=(0, 0, 0.02)).build("PG_Plaza", pg, [MAT["pg_plaza"]])

# 中央喷泉
f = MB()
f.add(cyl(2.6, 0.7, 16), off=(0, 0, 0.35), mat=0)
f.add(cyl(2.2, 0.12, 16), off=(0, 0, 0.72), mat=1)
f.add(cyl(0.35, 2.0, 10), off=(0, 0, 1.7), mat=0)
f.add(sphere(0.75, 8, 5), off=(0, 0, 2.8), mat=1)
f.build("PG_Fountain", pg, [MAT["pg_plaza"], MAT["pg_water"]])

# 旋转木马 (-15,-10)
c = MB()
c.add(cyl(4.2, 0.5, 16), off=(-15, -10, 0.3), mat=0)
c.add(cyl(0.28, 3.4, 10), off=(-15, -10, 2.0), mat=1)
c.add(cone(4.8, 2.0, 16), off=(-15, -10, 3.6), mat=2)
for i in range(8):
    a = 2 * math.pi * i / 8
    x, y = -15 + 3.1 * math.cos(a), -10 + 3.1 * math.sin(a)
    c.add(box(0.7, 1.3, 0.9), off=(x, y, 1.05), rot=(0, 0, a), mat=3)
c.build("PG_Carousel", pg, [MAT["pg_red"], MAT["pg_gold"], MAT["pg_cream"], MAT["pg_plaza"]])

# 过山车闭合轨道 (12,-12)
pts = []
for i in range(64):
    a = 2 * math.pi * i / 64
    pts.append((12 + 8.5 * math.cos(a), -12 + 6.0 * math.sin(a),
                4.2 + 2.2 * math.cos(2 * a) + 1.1 * math.sin(3 * a)))
poly_curve("PG_CoasterTrack", pts, pg, cyclic=True, bevel=0.22)
sup = MB()
for i in range(12):
    a = 2 * math.pi * i / 12
    x, y = 12 + 8.5 * math.cos(a), -12 + 6.0 * math.sin(a)
    z = 4.2 + 2.2 * math.cos(2 * a) + 1.1 * math.sin(3 * a)
    sup.add(box(0.28, 0.28, z), off=(x, y, z / 2), mat=0)
sup.build("PG_CoasterSupports", pg, [MAT["pg_blue"]])

# 摩天轮 (-16,12)
wheel = []
for i in range(48):
    a = 2 * math.pi * i / 48
    wheel.append((-16 + 7.0 * math.cos(a), 12, 8.5 + 7.0 * math.sin(a)))
poly_curve("PG_FerrisWheelRing", wheel, pg, cyclic=True, bevel=0.22)
fw = MB()
for i in range(8):
    a = 2 * math.pi * i / 8
    x, z = -16 + 7.0 * math.cos(a), 8.5 + 7.0 * math.sin(a)
    fw.add(box(1.1, 1.0, 1.0), off=(x, 12, z), mat=0)
fw.add(box(0.5, 0.5, 8.4), off=(-19.5, 12, 4.2), rot=(0, 0.28, 0), mat=1)
fw.add(box(0.5, 0.5, 8.4), off=(-12.5, 12, 4.2), rot=(0, -0.28, 0), mat=1)
fw.build("PG_FerrisWheelCabins", pg, [MAT["pg_red"], MAT["pg_gold"]])

# 海盗船 (14,12)
ps = MB()
ps.add(box(7.0, 2.2, 1.2), off=(14, 12, 1.5), mat=0)
ps.add(box(0.3, 0.3, 6.0), off=(11.2, 12, 3.0), rot=(0, 0.38, 0), mat=1)
ps.add(box(0.3, 0.3, 6.0), off=(16.8, 12, 3.0), rot=(0, -0.38, 0), mat=1)
ps.add(cyl(0.2, 3.0, 8), off=(14, 12, 5.4), rot=(math.pi / 2, 0, 0), mat=1)
ps.build("PG_PirateShip", pg, [MAT["pg_wood"], MAT["pg_gold"]])

# 小火车 (0,-21)
tr = []
for i in range(40):
    a = 2 * math.pi * i / 40
    tr.append((5.0 * math.cos(a), -21 + 3.0 * math.sin(a), 0.35))
poly_curve("PG_TrainTrack", tr, pg, cyclic=True, bevel=0.12)
cars = MB()
for i in range(4):
    a = 2 * math.pi * i / 4
    cars.add(box(1.6, 0.9, 0.8), off=(5.0 * math.cos(a), -21 + 3.0 * math.sin(a), 0.75),
             rot=(0, 0, a), mat=0)
cars.build("PG_TrainCars", pg, [MAT["pg_blue"]])

# 入口大门 (-28,0)
g = MB()
g.add(box(1.0, 1.0, 6.0), off=(-28, -4.5, 3.0), mat=0)
g.add(box(1.0, 1.0, 6.0), off=(-28, 4.5, 3.0), mat=0)
g.add(box(1.0, 10.0, 1.0), off=(-28, 0, 6.0), mat=1)
g.build("PG_EntranceGate", pg, [MAT["pg_cream"], MAT["pg_red"]])

pg_bounds = Z.world_bounds(list(pg.objects))

# ---------------- zoo 总集合与四区 ----------------
zoo_root = collection("zoo")
zoo_root["note"] = "新建动物园总集合；四区彼此不重叠，东侧紧邻游乐场（间距 2m）。"

zone_report = {}
for name, z in Z.ZONES.items():
    c = collection(name, zoo_root)
    c["zone_key"] = name
    c["color_hex"] = z["hex"]
    c["animal_type"] = z["animal"]
    c["animal_count"] = z["count"]
    cx, cy, w, h = z["cx"], z["cy"], z["w"], z["h"]

    ground_mat = bpy.data.materials.get("Zone_" + name) or make_mat("Zone_" + name, z["color"])
    MB().add(box(w, h, 0.3), off=(0, 0, -0.15)).build(
        name + "_Ground", c, [ground_mat], loc=(cx, cy, 0))

    # 围栏：立柱 + 两道横杆，合并为单 mesh
    fb = MB()
    post_r = 0.16
    for sx in (-1, 1):
        for sy in (-1, 1):
            fb.add(box(0.26, 0.26, 1.7), off=(sx * w / 2, sy * h / 2, 0.85))
    nx = max(2, int(w / 2.8))
    ny = max(2, int(h / 2.8))
    for i in range(1, nx):
        x = -w / 2 + w * i / nx
        for sy in (-1, 1):
            fb.add(box(0.20, 0.20, 1.7), off=(x, sy * h / 2, 0.85))
    for i in range(1, ny):
        y = -h / 2 + h * i / ny
        for sx in (-1, 1):
            fb.add(box(0.20, 0.20, 1.7), off=(sx * w / 2, y, 0.85))
    for zz in (0.55, 1.20):
        for sy in (-1, 1):
            fb.add(box(w, 0.12, 0.12), off=(0, sy * h / 2, zz))
        for sx in (-1, 1):
            fb.add(box(0.12, h, 0.12), off=(sx * w / 2, 0, zz))
    fb.build(name + "_Fence", c, [MAT["fence"]], loc=(cx, cy, 0))

    # 标牌：底板 + 立柱 + 文字（-Y 朝向摄像机）
    by = cy - h / 2 - 0.8
    MB().add(box(14, 0.3, 2.6), off=(0, 0, 0)).build(
        name + "_SignBoard", c, [MAT["board"]], loc=(cx, by, 2.0))
    posts = MB()
    for dx in (-5.5, 5.5):
        posts.add(box(0.3, 0.3, 2.4), off=(dx, 0, 0))
    posts.build(name + "_SignPosts", c, [MAT["fence"]], loc=(cx, by, 1.2))
    label = z["label_cn"] + "  " + z["label_en"] if Z.font_load() else z["label_en"]
    text_object(name + "_SignText", label, c, (cx, by - 0.22, 2.0),
                size=1.15, mat=MAT["text"])

    # 海洋区水体（透明盒），鱼类活动范围在其内部
    if name == "marine_zone":
        MB().add(box(w - 2, h - 2, 3.6), off=(0, 0, 1.8)).build(
            name + "_WaterVolume", c, [MAT["water"]], loc=(cx, cy, 0))
        rim = MB()
        for sx in (-1, 1):
            rim.add(box(0.35, h - 2, 3.9), off=(sx * (w - 2) / 2, 0, 1.95))
        for sy in (-1, 1):
            rim.add(box(w - 2, 0.35, 3.9), off=(0, sy * (h - 2) / 2, 1.95))
        rim.build(name + "_WaterRim", c, [MAT["board"]], loc=(cx, cy, 0))
        c["fish_bounds"] = "x[35,55] y[-23,-5] z[0.6,3.0]"

    # 爬行政区岩石障碍
    if name == "reptile_zone":
        rocks = MB()
        for i, (dx, dy, r) in enumerate([(-6, -5, 1.3), (5, 4, 1.6), (2, -7, 1.0)]):
            rocks.add(sphere(r, 7, 4), off=(dx, dy, r * 0.55))
        rocks.build(name + "_Rocks", c, [MAT["rock"]], loc=(cx, cy, 0))

    # 哺乳区树木
    if name == "mammal_zone":
        trees = MB()
        for dx, dy in [(-8, -8), (8, -8), (-8, 8), (8, 8)]:
            trees.add(cyl(0.28, 2.4, 6), off=(dx, dy, 1.2))
        trees.build(name + "_TreeTrunks", c, [MAT["tree"]], loc=(cx, cy, 0))
        canopy = MB()
        for dx, dy in [(-8, -8), (8, -8), (-8, 8), (8, 8)]:
            canopy.add(cone(2.0, 3.2, 7), off=(dx, dy, 3.6))
        canopy.build(name + "_TreeCanopies", c, [MAT["leaf"]], loc=(cx, cy, 0))

    b = Z.zone_bounds(name)
    zone_report[name] = dict(center=[cx, cy], size=[w, h], bounds=b,
                             color=z["hex"], label=z["label_cn"] + " / " + z["label_en"])

with open(os.path.join(Z.OUT_DIR, "s1_layout.json"), "w", encoding="utf-8") as f:
    json.dump(dict(playground_bounds=pg_bounds, playground_object_count=len(pg.objects),
                   zoo_root="zoo", zones=zone_report), f, ensure_ascii=False, indent=2)
print("S1_OK zoo_root=zoo zones=%d pg_objects=%d pg_bounds=%s" %
      (len(Z.ZONES), len(pg.objects), pg_bounds))
