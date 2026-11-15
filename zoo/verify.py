# -*- coding: utf-8 -*-
"""独立进程重新打开 .blend 做可验证验收。"""
import bpy, json, os, math, sys
from mathutils import Vector
sys.path.insert(0, r"D:\playground-mvp\zoo")
import zoo_lib as Z

BLEND = r"D:\playground-mvp\zoo\playground_zoo.blend"
PNG = r"D:\playground-mvp\zoo\zoo_preview.png"
bpy.ops.wm.open_mainfile(filepath=BLEND)
s = bpy.context.scene

checks = {}
def ck(k, v, extra=None):
    checks[k] = dict(pass_=bool(v), detail=extra)

ck("blend_loaded", os.path.abspath(bpy.data.filepath).lower() == BLEND.lower(),
   dict(filepath=bpy.data.filepath, size_bytes=os.path.getsize(BLEND)))
ck("preview_exists", os.path.exists(PNG),
   dict(path=PNG, size_bytes=os.path.getsize(PNG) if os.path.exists(PNG) else 0))

# 集合结构
zoo = bpy.data.collections.get("zoo")
children = sorted(c.name for c in zoo.children) if zoo else []
ck("zoo_collections", zoo is not None and children == sorted(Z.ZONES),
   dict(children=children, expected=sorted(Z.ZONES)))

# 四区互不重叠 + 紧邻游乐场
bounds = {n: Z.zone_bounds(n) for n in Z.ZONES}
overlap = []
for a in bounds:
    for b in bounds:
        if a >= b:
            continue
        A, B = bounds[a], bounds[b]
        if A["xmin"] < B["xmax"] and B["xmin"] < A["xmax"] and \
           A["ymin"] < B["ymax"] and B["ymin"] < A["ymax"]:
            overlap.append((a, b))
ck("zones_non_overlap", len(overlap) == 0, dict(overlaps=overlap))
gaps = [round(bounds[n]["xmin"] - 30.0, 3) for n in bounds]
ck("zoo_adjacent_to_playground", min(abs(g) for g in gaps) <= 2.01,
   dict(playground_xmax=30.0, zone_xmins={n: bounds[n]["xmin"] for n in bounds}))

# 地面 / 围栏 / 标牌 / 水体
need = {}
for n in Z.ZONES:
    need[n] = dict(ground=bool(bpy.data.objects.get(n + "_Ground")),
                   fence=bool(bpy.data.objects.get(n + "_Fence")),
                   board=bool(bpy.data.objects.get(n + "_SignBoard")),
                   text=bool(bpy.data.objects.get(n + "_SignText")) and
                        bpy.data.objects.get(n + "_SignText").type == 'FONT')
ck("zone_fixtures", all(all(v.values()) for v in need.values()), need)
ck("water_volume", bool(bpy.data.objects.get("marine_zone_WaterVolume")))

# 动物归集与骨骼
manifest = json.loads(s.get("zoo_manifest", "[]"))
zone_count = {}
bone_ok = 0
driver_ok = 0
for a in manifest:
    r = bpy.data.objects.get(a["rig"])
    m = bpy.data.objects.get(a["mesh"])
    if r and r.get("zoo_zone") == a["zone"] and a["zone"] in [c.name for c in r.users_collection]:
        zone_count[a["zone"]] = zone_count.get(a["zone"], 0) + 1
    if r and r.type == 'ARMATURE' and len(r.data.bones) >= 4:
        bone_ok += 1
    if r and r.animation_data and len(r.animation_data.drivers) >= 3:
        driver_ok += 1
    if m and any(x.type == 'ARMATURE' for x in m.modifiers):
        pass
ck("animal_counts", zone_count == {"bird_zone": 8, "reptile_zone": 4,
                                   "marine_zone": 15, "mammal_zone": 5},
   dict(by_zone=zone_count, total=len(manifest)))
ck("armatures_and_drivers", bone_ok == 32 and driver_ok == 32,
   dict(armature_ok=bone_ok, driver_ok=driver_ok))

# 三角面
tris = Z.total_triangles(list(s.objects))
ck("triangle_budget", tris < 200000, dict(total_triangles=tris, limit=200000))

# 动画循环 + 运动有效性
def world_pos(name, frame):
    s.frame_set(frame)
    d = bpy.context.evaluated_depsgraph_get()
    return bpy.data.objects[name].evaluated_get(d).matrix_world.translation.copy()

samples = {"BIRD_01_Rig": [1, 60, 121, 241],
           "FISH_01_Rig": [1, 60, 121, 241],
           "REPTILE_01_Rig": [1, 60, 121, 241],
           "MAMMAL_01_Rig": [1, 60, 121, 241]}
motion = {}
loop_ok = True
for n, frs in samples.items():
    ps = {f: world_pos(n, f) for f in frs}
    delta = (ps[60] - ps[1]).length
    looperr = (ps[241] - ps[1]).length
    motion[n] = dict(frame1=[round(v, 3) for v in ps[1]],
                     frame60=[round(v, 3) for v in ps[60]],
                     move_distance=round(delta, 3), loop_error=round(looperr, 4))
    if delta < 0.5 or looperr > 0.05:
        loop_ok = False
ck("motion_moves_and_loops", loop_ok, motion)

# CYCLES 循环修改器
cycle_count = 0
for a in manifest:
    r = bpy.data.objects.get(a["rig"])
    if r and r.animation_data and r.animation_data.action:
        for fc in Z.all_fcurves(r.animation_data.action):
            if any(m.type == 'CYCLES' for m in fc.modifiers):
                cycle_count += 1
ck("cycles_modifiers", cycle_count >= 140, dict(fcurves_with_cycles=cycle_count))

# 鱼群不穿出水体
FB = (35.0, 55.0, -23.0, -5.0, 0.7, 3.0)
bad = 0
fish_min = [1e9] * 3
fish_max = [-1e9] * 3
for fr in (1, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 241):
    s.frame_set(fr)
    d = bpy.context.evaluated_depsgraph_get()
    for i in range(1, 16):
        p = bpy.data.objects["FISH_%02d_Rig" % i].evaluated_get(d).matrix_world.translation
        if not (FB[0] - 0.02 <= p.x <= FB[1] + 0.02 and
                FB[2] - 0.02 <= p.y <= FB[3] + 0.02 and
                FB[4] - 0.02 <= p.z <= FB[5] + 0.02):
            bad += 1
        for k, v in enumerate((p.x, p.y, p.z)):
            fish_min[k] = min(fish_min[k], v)
            fish_max[k] = max(fish_max[k], v)
ck("fish_inside_water", bad == 0,
   dict(out_of_bounds_samples=bad, observed_min=[round(v, 2) for v in fish_min],
        observed_max=[round(v, 2) for v in fish_max], water_bounds=FB))

# 鸟类在飞行包络内
bad_bird = 0
for fr in (1, 40, 80, 120, 160, 200, 240, 241):
    s.frame_set(fr)
    d = bpy.context.evaluated_depsgraph_get()
    for i in range(1, 9):
        p = bpy.data.objects["BIRD_%02d_Rig" % i].evaluated_get(d).matrix_world.translation
        if not (34.0 <= p.x <= 56.0 and 5.0 <= p.y <= 23.0 and 4.0 <= p.z <= 12.0):
            bad_bird += 1
ck("birds_in_flight_envelope", bad_bird == 0, dict(out_of_envelope_samples=bad_bird))

# 既有物体未被删除/移动
defaults = {n: bpy.data.objects.get(n) for n in ("Cube", "Camera", "Light")}
ck("existing_objects_untouched",
   all(o is not None for o in defaults.values()) and
   tuple(round(v, 3) for v in defaults["Cube"].location) == (0.0, 0.0, 0.0),
   dict(present=[n for n, o in defaults.items() if o], hidden_render=[o.hide_render for o in defaults.values() if o]))

ck("camera_and_engine", s.camera is not None and s.render.engine == 'CYCLES',
   dict(camera=s.camera.name if s.camera else None, engine=s.render.engine,
        resolution=[s.render.resolution_x, s.render.resolution_y]))

passed = sum(1 for v in checks.values() if v["pass_"])
result = dict(blend=bpy.data.filepath, blender=bpy.app.version_string,
              checks=checks, passed=passed, total=len(checks),
              all_pass=passed == len(checks))
with open(r"D:\playground-mvp\zoo\zoo_verify.json", "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2, default=list)
print("VERIFY_OK %d/%d all_pass=%s tris=%d" % (passed, len(checks), passed == len(checks), tris))
for k, v in checks.items():
    if not v["pass_"]:
        print("FAIL", k, v["detail"])
