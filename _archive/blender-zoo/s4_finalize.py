# -*- coding: utf-8 -*-
"""阶段4：总览摄像机、灯光、保存 .blend、仅渲染 1 张预览图、输出交付清单。"""
import bpy, math, json, os, sys
from mathutils import Vector
sys.path.insert(0, r"D:\playground-mvp\zoo")
import zoo_lib as Z
from zoo_lib import collection, total_triangles

scene = bpy.context.scene
os.makedirs(Z.OUT_DIR, exist_ok=True)
BLEND_PATH = os.path.join(Z.OUT_DIR, "playground_zoo.blend")
PNG_PATH = os.path.join(Z.OUT_DIR, "zoo_preview.png")

pres = collection("zoo_presentation")

# ---------------- 摄像机：同时看到游乐场与动物园 ----------------
cam_data = bpy.data.cameras.new("ZooOverviewCam")
cam_data.type = 'ORTHO'
cam = bpy.data.objects.new("ZooOverviewCam", cam_data)
pres.objects.link(cam)
target = Vector((29.0, 0.0, 3.0))
cam.location = (89.0, -102.0, 96.0)
cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
scene.camera = cam

# 用包围盒 8 角点的投影自动选 ortho_scale（不额外渲染）
try:
    from bpy_extras.object_utils import world_to_camera_view
    corners = [Vector((x, y, z)) for x in (-30.0, 30.0, 88.0)
               for y in (-30.0, 30.0) for z in (0.0, 16.0)]
    chosen = 150.0
    for s in (150.0, 165.0, 180.0, 200.0, 220.0, 245.0):
        cam_data.ortho_scale = s
        bpy.context.view_layer.update()
        uv = [world_to_camera_view(scene, cam, p) for p in corners]
        if all(0.04 < c.x < 0.96 and 0.04 < c.y < 0.96 for c in uv):
            chosen = s
            break
        chosen = s
    cam_data.ortho_scale = chosen
except Exception as e:
    cam_data.ortho_scale = 190.0
    print("CAMERA_FIT_WARNING", repr(e))

# ---------------- 灯光与世界 ----------------
world = scene.world or bpy.data.worlds.new("ZooWorld")
scene.world = world
world.use_nodes = True
bg = None
for n in world.node_tree.nodes:
    if n.type == 'BACKGROUND':
        bg = n
        break
if bg:
    bg.inputs["Color"].default_value = (0.70, 0.81, 0.95, 1.0)
    bg.inputs["Strength"].default_value = 0.85

sun_data = bpy.data.lights.new("ZooSun", 'SUN')
sun_data.energy = 2.0
sun_data.angle = math.radians(12)
sun = bpy.data.objects.new("ZooSun", sun_data)
pres.objects.link(sun)
sun.rotation_euler = (math.radians(38), math.radians(-24), math.radians(18))

# ---------------- 渲染设置（Cycles CPU，单张预览） ----------------
scene.render.engine = 'CYCLES'
try:
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 3
    scene.cycles.transparent_max_bounces = 4
except Exception as e:
    print("CYCLES_CFG_WARNING", repr(e))
scene.render.resolution_x = 1400
scene.render.resolution_y = 800
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.render.filepath = PNG_PATH
scene.render.film_transparent = False
try:
    scene.view_settings.view_transform = 'Standard'
except Exception:
    pass
scene.frame_set(1)

# ---------------- 保存 .blend ----------------
bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH, check_existing=False)

# ---------------- 仅渲染 1 张预览图 ----------------
bpy.ops.render.render(write_still=True)

# ---------------- 交付清单 ----------------
def coll_objects(name):
    c = bpy.data.collections.get(name)
    return [] if c is None else sorted(o.name for o in c.objects)

inventory = {
    "zoo_root": "zoo",
    "zone_collections": {n: dict(count=len(coll_objects(n)), objects=coll_objects(n))
                         for n in Z.ZONES},
    "playground_proxy": dict(collection="playground_existing_proxy",
                             count=len(coll_objects("playground_existing_proxy")),
                             objects=coll_objects("playground_existing_proxy"),
                             note="磁盘无 .blend 游乐场；依据网页项目设施清单重建的低模参照集合，未改动任何既有物体"),
    "presentation": dict(count=len(coll_objects("zoo_presentation")),
                         objects=coll_objects("zoo_presentation")),
    "animal_assets": json.loads(scene.get("zoo_manifest", "[]")),
    "total_objects": len(scene.objects),
    "total_triangles": total_triangles(list(scene.objects)),
}
with open(os.path.join(Z.OUT_DIR, "s4_inventory.json"), "w", encoding="utf-8") as f:
    json.dump(inventory, f, ensure_ascii=False, indent=2)

report = dict(blend_path=BLEND_PATH, preview_path=PNG_PATH,
              camera=dict(name=cam.name, location=list(cam.location),
                          ortho_scale=cam_data.ortho_scale, target=list(target)),
              render=dict(engine=scene.render.engine, resolution=[1400, 800],
                          samples=getattr(scene.cycles, "samples", None)),
              zones=json.load(open(os.path.join(Z.OUT_DIR, "s1_layout.json"), encoding="utf-8"))["zones"],
              total_objects=inventory["total_objects"],
              total_triangles=inventory["total_triangles"])
with open(os.path.join(Z.OUT_DIR, "s4_report.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print("S4_OK blend=%s png=%s objects=%d tris=%d ortho=%.0f" %
      (BLEND_PATH, PNG_PATH, inventory["total_objects"], inventory["total_triangles"],
       cam_data.ortho_scale))
