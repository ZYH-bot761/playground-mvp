# -*- coding: utf-8 -*-
"""阶段3：鸟类闭合曲线飞行、鱼群 boids、爬行贴地避障游走、哺乳漫步停顿；全部循环。"""
import bpy, math, random, json, os, sys
from mathutils import Vector
sys.path.insert(0, r"D:\playground-mvp\zoo")
import zoo_lib as Z
from zoo_lib import collection, poly_curve, set_driver, add_cycles

scene = bpy.context.scene
os.makedirs(Z.OUT_DIR, exist_ok=True)
N = 240
BLEND = 24
scene.frame_start = 1
scene.frame_end = N + 1
scene.render.fps = 24

# 幂等清理：重跑时移除上一次残留的飞行曲线、约束与位置关键帧（保留 s2 的骨骼驱动器）
for _n in ("bird_zone_FlightPath_1", "bird_zone_FlightPath_2"):
    _o = bpy.data.objects.get(_n)
    if _o:
        bpy.data.objects.remove(_o, do_unlink=True)
for _kind, _cnt in (("BIRD", 8), ("FISH", 15), ("REPTILE", 4), ("MAMMAL", 5)):
    for _i in range(1, _cnt + 1):
        _r = bpy.data.objects.get("%s_%02d_Rig" % (_kind, _i))
        if not _r:
            continue
        if _kind == "BIRD":
            for _c in list(_r.constraints):
                if _c.name == "ClosedFlightLoop":
                    _r.constraints.remove(_c)
            if _r.animation_data:
                for _fc in list(_r.animation_data.drivers):
                    if "offset_factor" in _fc.data_path:
                        _r.animation_data.drivers.remove(_fc)
        elif _r.animation_data and _r.animation_data.action:
            _r.animation_data.action = None


def rigs(kind, count):
    out = []
    for i in range(1, count + 1):
        o = bpy.data.objects.get("%s_%02d_Rig" % (kind.upper(), i))
        if o:
            out.append(o)
    return out


def clamp(v, b):
    v.x = max(b["xmin"], min(b["xmax"], v.x))
    v.y = max(b["ymin"], min(b["ymax"], v.y))
    v.z = max(b["zmin"], min(b["zmax"], v.z))
    return v


def blend_to_start(traj):
    starts = [t[0].copy() for t in traj]
    lasts = [t[-1].copy() for t in traj]
    for k in range(BLEND):
        a = (k + 1) / BLEND
        for i, t in enumerate(traj):
            t.append(lasts[i].lerp(starts[i], a))
    return traj


def bake(rig, coords, z_fixed=None):
    """把闭合轨迹烘成 location / yaw 关键帧，并加 CYCLES 循环修改器。"""
    coords = coords + [coords[0].copy()]
    prev_yaw = 0.0
    for f in range(1, N + 2):
        p = coords[f - 1]
        d = coords[f] - coords[f - 1] if f <= N else coords[1] - coords[0]
        yaw = math.atan2(-d.x, d.y) if (d.x * d.x + d.y * d.y) > 1e-8 else prev_yaw
        prev_yaw = yaw
        rig.location = p
        rig.rotation_euler = (0.0, 0.0, yaw)
        rig.keyframe_insert("location", frame=f)
        rig.keyframe_insert("rotation_euler", frame=f)
    return add_cycles(rig)


# ---------------- 鸟类：两条真实闭合 3D 曲线 + Follow Path 循环驱动 ----------------
bcoll = collection("bird_zone")
curves = []
for ci, (rx, ry, z0, amp, kz) in enumerate([(10.0, 8.0, 7.2, 2.2, 3),
                                            (7.5, 6.0, 9.4, 1.6, 4)]):
    pts = []
    for i in range(72):
        a = 2 * math.pi * i / 72
        pts.append((45.0 + rx * math.cos(a), 14.0 + ry * math.sin(a),
                    z0 + amp * math.sin(kz * a)))
    curves.append(poly_curve("bird_zone_FlightPath_%d" % (ci + 1), pts, bcoll,
                             cyclic=True, bevel=0.05))

bird_rigs = rigs("bird", 8)
bird_cycles = 0
for i, r in enumerate(bird_rigs):
    # Follow Path 会把 owner 的基准 location 当作路径偏移，必须归零才能严格贴着闭合曲线飞
    r.location = (0.0, 0.0, 0.0)
    r.rotation_euler = (0.0, 0.0, 0.0)
    c = r.constraints.new('FOLLOW_PATH')
    c.name = "ClosedFlightLoop"
    c.target = curves[i % 2]
    c.use_fixed_location = True
    c.use_curve_follow = True
    c.forward_axis = 'FORWARD_Y'
    c.up_axis = 'UP_Z'
    period = 240
    off = int(i * period / 8)
    expr = "((f+%d)/%d)-floor((f+%d)/%d)" % (off, period, off, period)
    try:
        fc = c.driver_add("offset_factor")
        d = fc.driver
        d.type = 'SCRIPTED'
        v = d.variables.new()
        v.name = "f"
        v.type = 'SINGLE_PROP'
        v.targets[0].id_type = 'SCENE'
        v.targets[0].id = scene
        v.targets[0].data_path = "frame_current"
        d.expression = expr
        bird_cycles += 1
    except Exception as e:
        print("BIRD_DRIVER_WARNING", r.name, repr(e))
    r["motion"] = "Follow Path closed 3D curve, cyclic driver, z-bob baked into curve"
    r["flight_curve"] = c.target.name

# ---------------- 鱼群：分离 + 对齐 + 聚合 + 水体边界约束 ----------------
FB = dict(xmin=35.0, xmax=55.0, ymin=-23.0, ymax=-5.0, zmin=0.7, zmax=3.0)
rng = random.Random(20261111)
fish = rigs("fish", 15)
pos = [Vector((rng.uniform(37, 53), rng.uniform(-21, -7), rng.uniform(1.0, 2.7))) for _ in fish]
vel = [Vector((rng.uniform(-0.14, 0.14), rng.uniform(-0.14, 0.14), rng.uniform(-0.04, 0.04))) for _ in fish]
traj = [[] for _ in fish]
SIM = N - BLEND
for step in range(SIM):
    nv = []
    for i in range(len(fish)):
        sep = Vector((0, 0, 0))
        ali = Vector((0, 0, 0))
        coh = Vector((0, 0, 0))
        cnt = 0
        for j in range(len(fish)):
            if i == j:
                continue
            d = pos[j] - pos[i]
            dist = d.length
            if 1e-4 < dist < 1.8:
                sep -= d / (dist * dist)
            if dist < 4.5:
                ali += vel[j]
                coh += pos[j]
                cnt += 1
        v = vel[i].copy()
        v += sep * 0.055
        if cnt:
            v += (ali / cnt - vel[i]) * 0.035
            v += (coh / cnt - pos[i]) * 0.0045
        if pos[i].x < FB["xmin"] + 1.2:
            v.x += 0.07
        if pos[i].x > FB["xmax"] - 1.2:
            v.x -= 0.07
        if pos[i].y < FB["ymin"] + 1.2:
            v.y += 0.07
        if pos[i].y > FB["ymax"] - 1.2:
            v.y -= 0.07
        if pos[i].z < FB["zmin"] + 1.2:
            v.z += 0.07
        if pos[i].z > FB["zmax"] - 1.2:
            v.z -= 0.07
        v += Vector((-(pos[i].y + 14.0) * 0.0006, (pos[i].x - 45.0) * 0.0006, 0))
        s = v.length
        if s > 0.26:
            v *= 0.26 / s
        elif s < 0.06:
            v *= 0.06 / max(s, 1e-6)
        nv.append(v)
    vel = nv
    for i in range(len(fish)):
        pos[i] = clamp(pos[i] + vel[i], FB)
        traj[i].append(pos[i].copy())
traj = blend_to_start(traj)
fish_cycles = [bake(r, t) for r, t in zip(fish, traj)]
for r in fish:
    r["motion"] = "boids: separation + alignment + cohesion + water-volume clamp, 240f CYCLES loop"

# ---------------- 地面行走者（爬行/哺乳） ----------------
def obstacles_of(name):
    if name == "reptile_zone":
        return [(Vector((69.0, 9.0)), 2.0), (Vector((80.0, 18.0)), 2.3),
                (Vector((77.0, 7.0)), 1.7)]
    return [(Vector((67.0, -22.0)), 2.0), (Vector((83.0, -22.0)), 2.0),
            (Vector((67.0, -6.0)), 2.0), (Vector((83.0, -6.0)), 2.0)]


def ground_walk(name, kind, count, mode):
    b = dict(xmin=64.5, xmax=85.5, ymin=4.0, ymax=24.0, zmin=0.30, zmax=0.40)
    if kind == "mammal":
        b = dict(xmin=64.5, xmax=85.5, ymin=-24.0, ymax=-4.0, zmin=0.0, zmax=0.10)
    obs = obstacles_of(name)
    rnd = random.Random(7700 + count)
    agents = rigs(kind, count)
    cur = [Vector((rnd.uniform(b["xmin"] + 3, b["xmax"] - 3),
                   rnd.uniform(b["ymin"] + 3, b["ymax"] - 3),
                   b["zmin"])) for _ in agents]
    starts = [p.copy() for p in cur]
    targets = [None] * count
    paths = [[] for _ in agents]
    for f in range(SIM):
        for i in range(count):
            paused = mode == "mammal" and ((f + i * 17) % 70) < 20
            if paused:
                p = cur[i].copy()
                p.z = b["zmin"] + 0.02 * math.sin(f * 0.2 + i)
                paths[i].append(p)
                continue
            if targets[i] is None or (cur[i] - targets[i]).length < 0.5 or (f + i * 9) % 38 == 0:
                targets[i] = Vector((rnd.uniform(b["xmin"] + 2, b["xmax"] - 2),
                                     rnd.uniform(b["ymin"] + 2, b["ymax"] - 2), b["zmin"]))
            d = targets[i] - cur[i]
            step = d.normalized() * 0.115 if d.length > 1e-6 else Vector((0, 0, 0))
            # 围栏避障
            if cur[i].x < b["xmin"] + 2.0:
                step.x += 0.22
            if cur[i].x > b["xmax"] - 2.0:
                step.x -= 0.22
            if cur[i].y < b["ymin"] + 2.0:
                step.y += 0.22
            if cur[i].y > b["ymax"] - 2.0:
                step.y -= 0.22
            # 岩石 / 树木避障
            for oc, rad in obs:
                dv = Vector((cur[i].x - oc.x, cur[i].y - oc.y))
                if dv.length < rad + 1.1:
                    step += Vector((dv.x, dv.y, 0)).normalized() * 0.20
            # 个体间分离
            for j in range(count):
                if j == i:
                    continue
                dv = cur[i] - cur[j]
                if 1e-4 < dv.length < 1.6:
                    step += Vector((dv.x, dv.y, 0)).normalized() * 0.12
            cur[i] = clamp(cur[i] + step, b)
            p = cur[i].copy()
            p.z = b["zmin"] + (0.05 if kind == "mammal" else 0.02) * math.sin(f * 0.28 + i)
            paths[i].append(p)
    paths = blend_to_start(paths)
    cyc = [bake(r, t) for r, t in zip(agents, paths)]
    for r in agents:
        r["motion"] = ("ground walk with fence/obstacle avoidance, 240f CYCLES loop" if kind == "reptile"
                       else "stroll with intermittent pauses, 240f CYCLES loop")
    return dict(kind=kind, count=len(agents), cycles=cyc, bounds=b,
                obstacles=[[list(o), r] for o, r in obs])


rep = ground_walk("reptile_zone", "reptile", 4, "wander")
mam = ground_walk("mammal_zone", "mammal", 5, "stroll")

summary = dict(
    frame_range=[1, N + 1],
    birds=dict(count=len(bird_rigs), driver_count=bird_cycles,
               curves=[c.name for c in curves],
               note="closed 3D poly curves with z-bob; Follow Path offset_factor driven by f (floored modulo)"),
    fish=dict(count=len(fish), rules=["separation", "alignment", "cohesion", "water_clamp"],
              bounds=FB, cycle_fcurves=fish_cycles),
    reptiles=rep, mammals=mam,
    total_scene_tris=Z.total_triangles(),
)
with open(os.path.join(Z.OUT_DIR, "s3_motion.json"), "w", encoding="utf-8") as f:
    json.dump(summary, f, ensure_ascii=False, indent=2, default=list)
print("S3_OK birds=%d/drivers=%d curves=%d fish=%d fish_fcurves=%d rep=%d mam=%d tris=%d" %
      (len(bird_rigs), bird_cycles, len(curves), len(fish), sum(fish_cycles),
       rep["count"], mam["count"], Z.total_triangles()))
