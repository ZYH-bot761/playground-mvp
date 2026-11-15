# -*- coding: utf-8 -*-
"""阶段0：读取当前场景，记录已有物体与占地边界。"""
import bpy, json, os, sys
sys.path.insert(0, r"D:\playground-mvp\zoo")
import zoo_lib as Z

scene = bpy.context.scene
objs = []
for o in scene.objects:
    objs.append(dict(name=o.name, type=o.type,
                     location=[round(float(v), 3) for v in o.location],
                     dimensions=[round(float(v), 3) for v in o.dimensions]))
bounds = Z.world_bounds(list(scene.objects))
report = dict(
    blender_version=bpy.app.version_string,
    scene_name=scene.name,
    blend_source="none (no .blend file exists on this machine; factory startup scene)",
    existing_object_count=len(objs),
    existing_objects=objs,
    existing_bounds=bounds,
    note="本工作空间的游乐场是 Three.js 网页项目，磁盘上没有任何 .blend 场景；"
         "Blender 会话内不存在游乐场物体，因此后续构建游乐场代理集合，且不改动任何既有物体。",
)
os.makedirs(Z.OUT_DIR, exist_ok=True)
with open(os.path.join(Z.OUT_DIR, "s0_scene.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print("S0_OK blender=%s scene=%s objects=%d bounds=%s" %
      (bpy.app.version_string, scene.name, len(objs), bounds))
