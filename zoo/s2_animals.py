# -*- coding: utf-8 -*-
"""阶段2：32 只低多边形动物，每只含独立 Armature 骨骼与循环骨骼动画。"""
import bpy, math, json, os, sys
sys.path.insert(0, r"D:\playground-mvp\zoo")
import zoo_lib as Z
from zoo_lib import MB, box, cyl, cone, sphere, make_mat, collection, set_driver

scene = bpy.context.scene
os.makedirs(Z.OUT_DIR, exist_ok=True)


def M(name, color, **kw):
    return bpy.data.materials.get(name) or make_mat(name, color, **kw)

PAL = {
    "bird": [M("Animal_BirdBody", (0.98, 0.72, 0.16, 1)),
             M("Animal_BirdWing", (0.99, 0.86, 0.38, 1)),
             M("Animal_BirdBeak", (0.94, 0.40, 0.10, 1)),
             M("Animal_Eye", (0.05, 0.05, 0.06, 1))],
    "fish": [M("Animal_FishBody", (0.20, 0.72, 0.90, 1)),
             M("Animal_FishHead", (0.95, 0.62, 0.20, 1)),
             M("Animal_FishFin", (0.98, 0.42, 0.28, 1)),
             M("Animal_Eye", (0.05, 0.05, 0.06, 1))],
    "reptile": [M("Animal_ReptileBody", (0.34, 0.62, 0.24, 1)),
                M("Animal_ReptileBelly", (0.78, 0.80, 0.42, 1)),
                M("Animal_Eye", (0.05, 0.05, 0.06, 1)),
                M("Animal_ReptileSpike", (0.18, 0.40, 0.16, 1))],
    "mammal": [M("Animal_MammalBody", (0.72, 0.42, 0.20, 1)),
               M("Animal_MammalAccent", (0.94, 0.88, 0.72, 1)),
               M("Animal_Eye", (0.05, 0.05, 0.06, 1)),
               M("Animal_MammalTail", (0.48, 0.28, 0.14, 1))],
}


def make_armature(name, bones, coll, loc):
    arm = bpy.data.armatures.new(name + "_ArmData")
    rig = bpy.data.objects.new(name + "_Rig", arm)
    coll.objects.link(rig)
    rig.location = loc
    try:
        for o in list(bpy.data.objects):
            try:
                if o.select_get():
                    o.select_set(False)
            except Exception:
                pass
        rig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        with bpy.context.temp_override(active_object=rig, selected_objects=[rig], object=rig):
            bpy.ops.object.mode_set(mode='EDIT')
            eb = arm.edit_bones
            for b in list(eb):
                eb.remove(b)
            made = {}
            for bname, head, tail, parent in bones:
                b = eb.new(bname)
                b.head = head
                b.tail = tail
                b.use_deform = True
                if parent and parent in made:
                    b.parent = made[parent]
                made[bname] = b
            bpy.ops.object.mode_set(mode='OBJECT')
    except Exception as e:
        print("ARMATURE_WARNING %s: %s" % (name, e))
    return rig


def bone_drivers(rig, specs):
    """specs: [(bone, axis, expr)]，全部基于场景帧的三角函数循环驱动。"""
    for bname, axis, expr in specs:
        pb = rig.pose.bones.get(bname)
        if pb is None:
            continue
        pb.rotation_mode = 'XYZ'
        try:
            set_driver(pb, "rotation_euler", axis, expr, scene=scene)
        except Exception as e:
            print("DRIVER_WARNING %s/%s: %s" % (rig.name, bname, e))


def animal_spec(kind, phase):
    """返回 (bones, MB 构建器, 材质索引表, 骨骼驱动表达式, 缩放)。"""
    p = phase
    if kind == "bird":
        bones = [
            ("root", (0, 0, -0.1), (0, 0, 0.2), None),
            ("head", (0, 0.35, 0.12), (0, 0.68, 0.12), "root"),
            ("wing_L", (0.12, 0.02, 0.12), (0.85, 0.02, 0.12), "root"),
            ("wing_R", (-0.12, 0.02, 0.12), (-0.85, 0.02, 0.12), "root"),
            ("tail", (0, -0.4, 0.05), (0, -0.9, 0.05), "root"),
        ]
        m = MB()
        m.add(sphere(0.42, 8, 5), scale=(1.0, 1.35, 0.85), mat=0, group="root")
        m.add(sphere(0.25, 7, 4), off=(0, 0.52, 0.18), mat=0, group="head")
        m.add(cone(0.12, 0.30, 5), off=(0, 0.84, 0.18), rot=(-math.pi / 2, 0, 0), mat=2, group="head")
        for sx in (-1, 1):
            m.add(sphere(0.055, 6, 4), off=(sx * 0.16, 0.62, 0.29), mat=3, group="head")
        m.add(box(0.78, 0.55, 0.10), off=(0.48, 0.02, 0.12), mat=1, group="wing_L")
        m.add(box(0.78, 0.55, 0.10), off=(-0.48, 0.02, 0.12), mat=1, group="wing_R")
        m.add(cone(0.18, 0.52, 5), off=(0, -0.66, 0.05), rot=(math.pi / 2, 0, 0), mat=0, group="tail")
        for sx in (-1, 1):
            m.add(cyl(0.04, 0.28, 5), off=(sx * 0.13, 0, -0.42), mat=2, group="root")
        drv = [
            ("wing_L", 0, "0.68*sin(f*0.16+%.3f)" % p),
            ("wing_R", 0, "-0.68*sin(f*0.16+%.3f)" % p),
            ("head", 0, "0.14*sin(f*0.08+%.3f)" % p),
            ("tail", 2, "0.28*sin(f*0.16+%.3f)" % p),
        ]
        return bones, m, PAL["bird"], drv, 0.85
    if kind == "fish":
        bones = [
            ("root", (0, 0, 0), (0, 0.3, 0), None),
            ("head", (0, 0.25, 0), (0, 0.66, 0), "root"),
            ("tail", (0, -0.35, 0), (0, -0.98, 0), "root"),
            ("fin_L", (0.12, 0.10, 0), (0.52, 0.10, 0), "root"),
            ("fin_R", (-0.12, 0.10, 0), (-0.52, 0.10, 0), "root"),
        ]
        m = MB()
        m.add(sphere(0.36, 8, 5), scale=(0.75, 1.6, 0.70), mat=0, group="root")
        m.add(sphere(0.24, 7, 4), off=(0, 0.42, 0), mat=1, group="head")
        for sx in (-1, 1):
            m.add(sphere(0.05, 6, 4), off=(sx * 0.19, 0.40, 0.12), mat=3, group="head")
        m.add(cone(0.28, 0.46, 5), off=(0, -0.75, 0), rot=(math.pi / 2, 0, 0), mat=2, group="tail")
        m.add(cone(0.16, 0.34, 4), off=(0, -0.05, 0.32), mat=2, group="root")
        m.add(box(0.36, 0.22, 0.06), off=(0.30, 0.10, 0), rot=(0, 0, 0.35), mat=2, group="fin_L")
        m.add(box(0.36, 0.22, 0.06), off=(-0.30, 0.10, 0), rot=(0, 0, -0.35), mat=2, group="fin_R")
        drv = [
            ("tail", 2, "0.52*sin(f*0.26+%.3f)" % p),
            ("fin_L", 0, "0.32*sin(f*0.26+%.3f)" % p),
            ("fin_R", 0, "-0.32*sin(f*0.26+%.3f)" % p),
            ("head", 2, "0.10*sin(f*0.13+%.3f)" % p),
        ]
        return bones, m, PAL["fish"], drv, 0.72
    if kind == "reptile":
        bones = [
            ("root", (0, 0, 0.2), (0, 0, 0.6), None),
            ("head", (0, 0.55, 0.32), (0, 0.95, 0.32), "root"),
            ("tail", (0, -0.45, 0.28), (0, -1.25, 0.28), "root"),
            ("leg_FL", (0.45, 0.42, 0.32), (0.45, 0.42, 0.05), "root"),
            ("leg_FR", (-0.45, 0.42, 0.32), (-0.45, 0.42, 0.05), "root"),
            ("leg_BL", (0.45, -0.42, 0.32), (0.45, -0.42, 0.05), "root"),
            ("leg_BR", (-0.45, -0.42, 0.32), (-0.45, -0.42, 0.05), "root"),
        ]
        m = MB()
        m.add(sphere(0.45, 8, 5), scale=(1.0, 1.5, 0.55), off=(0, 0, 0.28), mat=0, group="root")
        m.add(sphere(0.28, 7, 4), off=(0, 0.72, 0.32), mat=0, group="head")
        m.add(box(0.34, 0.36, 0.20), off=(0, 0.98, 0.28), mat=1, group="head")
        for sx in (-1, 1):
            m.add(sphere(0.06, 6, 4), off=(sx * 0.20, 0.82, 0.46), mat=2, group="head")
        for sx, sy, g in [(0.5, 0.42, "leg_FR"), (-0.5, 0.42, "leg_FL"),
                          (0.5, -0.42, "leg_BR"), (-0.5, -0.42, "leg_BL")]:
            m.add(box(0.20, 0.52, 0.18), off=(sx, sy, 0.20), mat=0, group=g)
        m.add(cone(0.22, 0.90, 6), off=(0, -0.95, 0.28), rot=(math.pi / 2, 0, 0), mat=0, group="tail")
        for i, dy in enumerate((-0.25, 0.0, 0.25)):
            m.add(cone(0.09, 0.22, 4), off=(0, dy, 0.52), mat=3, group="root")
        drv = [
            ("leg_FR", 0, "0.42*sin(f*0.20+%.3f)" % p),
            ("leg_FL", 0, "-0.42*sin(f*0.20+%.3f)" % p),
            ("leg_BR", 0, "-0.42*sin(f*0.20+%.3f)" % (p + math.pi)),
            ("leg_BL", 0, "0.42*sin(f*0.20+%.3f)" % (p + math.pi)),
            ("tail", 2, "0.34*sin(f*0.15+%.3f)" % p),
            ("head", 2, "0.13*sin(f*0.10+%.3f)" % p),
        ]
        return bones, m, PAL["reptile"], drv, 0.95
    # mammal
    bones = [
        ("root", (0, 0, 0.4), (0, 0, 0.9), None),
        ("head", (0, 0.62, 0.95), (0, 1.05, 1.05), "root"),
        ("tail", (0, -0.62, 0.85), (0, -1.25, 0.85), "root"),
        ("leg_FL", (0.34, 0.50, 0.75), (0.34, 0.50, 0.05), "root"),
        ("leg_FR", (-0.34, 0.50, 0.75), (-0.34, 0.50, 0.05), "root"),
        ("leg_BL", (0.34, -0.50, 0.75), (0.34, -0.50, 0.05), "root"),
        ("leg_BR", (-0.34, -0.50, 0.75), (-0.34, -0.50, 0.05), "root"),
    ]
    m = MB()
    m.add(sphere(0.50, 8, 5), scale=(1.0, 1.6, 0.9), off=(0, 0, 0.75), mat=0, group="root")
    m.add(sphere(0.32, 7, 4), off=(0, 0.85, 1.00), mat=0, group="head")
    m.add(cone(0.16, 0.40, 5), off=(0, 1.22, 0.95), rot=(-math.pi / 2, 0, 0), mat=1, group="head")
    for sx in (-1, 1):
        m.add(cone(0.12, 0.34, 4), off=(sx * 0.20, 0.88, 1.36), mat=0, group="head")
        m.add(sphere(0.06, 6, 4), off=(sx * 0.18, 1.08, 1.10), mat=2, group="head")
    for sx, sy, g in [(0.34, 0.50, "leg_FR"), (-0.34, 0.50, "leg_FL"),
                      (0.34, -0.50, "leg_BR"), (-0.34, -0.50, "leg_BL")]:
        m.add(cyl(0.12, 0.85, 6), off=(sx, sy, 0.42), mat=0, group=g)
    m.add(cone(0.20, 0.72, 6), off=(0, -0.98, 0.85), rot=(math.pi / 2, 0, 0), mat=3, group="tail")
    drv = [
        ("leg_FR", 0, "0.36*sin(f*0.17+%.3f)" % p),
        ("leg_FL", 0, "-0.36*sin(f*0.17+%.3f)" % p),
        ("leg_BR", 0, "-0.36*sin(f*0.17+%.3f)" % (p + math.pi)),
        ("leg_BL", 0, "0.36*sin(f*0.17+%.3f)" % (p + math.pi)),
        ("tail", 2, "0.30*sin(f*0.12+%.3f)" % p),
        ("head", 0, "0.10*sin(f*0.09+%.3f)" % p),
    ]
    return bones, m, PAL["mammal"], drv, 1.0


ZONE_OF = {"bird": "bird_zone", "fish": "marine_zone",
           "reptile": "reptile_zone", "mammal": "mammal_zone"}
COUNTS = {"bird": 8, "fish": 15, "reptile": 4, "mammal": 5}
START = {
    "bird": dict(xmin=37.0, xmax=53.0, ymin=6.0, ymax=22.0, z=6.5),
    "fish": dict(xmin=35.0, xmax=55.0, ymin=-23.0, ymax=-5.0, zmin=0.7, zmax=3.0),
    "reptile": dict(xmin=64.5, xmax=85.5, ymin=4.0, ymax=24.0, z=0.35),
    "mammal": dict(xmin=64.5, xmax=85.5, ymin=-24.0, ymax=-4.0, z=0.0),
}

manifest = []
for kind in ("bird", "fish", "reptile", "mammal"):
    coll = collection(ZONE_OF[kind])
    s = START[kind]
    for i in range(COUNTS[kind]):
        idx = i + 1
        tag = "%s_%02d" % (kind.upper(), idx)
        phase = 2 * math.pi * i / COUNTS[kind]
        x = s["xmin"] + (s["xmax"] - s["xmin"]) * ((i * 0.6180339887) % 1.0)
        y = s["ymin"] + (s["ymax"] - s["ymin"]) * ((i * 0.3819660113 + 0.23) % 1.0)
        z = s.get("z", 0.0)
        if "zmin" in s:
            z = s["zmin"] + (s["zmax"] - s["zmin"]) * ((i * 0.7548776662) % 1.0)
        bones, mb, mats, drv, scale = animal_spec(kind, phase)
        rig = make_armature(tag, bones, coll, (x, y, z))
        rig.scale = (scale, scale, scale)
        rig["zoo_kind"] = kind
        rig["zoo_zone"] = ZONE_OF[kind]
        rig["asset_source"] = "本地程序化生成（Blender bpy 基础几何体 + Armature 骨骼 + 循环驱动）"
        mesh = mb.build(tag + "_Mesh", coll, mats, loc=(0, 0, 0), parent=rig)
        mod = mesh.modifiers.new("ArmatureRig", 'ARMATURE')
        mod.object = rig
        mod.use_vertex_groups = True
        mod.use_bone_envelopes = False
        mesh["zoo_kind"] = kind
        mesh["zoo_zone"] = ZONE_OF[kind]
        bone_drivers(rig, drv)
        manifest.append(dict(name=tag, kind=kind, zone=ZONE_OF[kind],
                             rig=rig.name, mesh=mesh.name,
                             bone_count=len(bones), start=[round(x, 2), round(y, 2), round(z, 2)],
                             source=rig["asset_source"]))

scene["zoo_manifest"] = json.dumps(manifest, ensure_ascii=False)
with open(os.path.join(Z.OUT_DIR, "s2_animals.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
print("S2_OK animals=%d birds=8 fish=15 reptiles=4 mammals=5 tris=%d" %
      (len(manifest), Z.total_triangles()))
