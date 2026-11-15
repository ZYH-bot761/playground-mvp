# -*- coding: utf-8 -*-
"""
本机 Blender 运行时桥接服务（BlenderMCP 协议兼容，端口 9876）。
通过 Blender 官方 bpy 5.3 Python 模块在本机提供完整的 Blender 数据/渲染能力，
并以 BlenderMCP addon 相同的 JSON-over-TCP 协议对外暴露，
供 blender-operation 技能的 blender_client.py 直接连接。
"""
import bpy
import io
import json
import socket
import threading
import traceback
import contextlib
import os

HOST = "127.0.0.1"
PORT = 9876
G = {"bpy": bpy, "__name__": "__blender_mcp__"}
OUT_DIR = r"D:\playground-mvp\zoo"


def _scene_info():
    s = bpy.context.scene
    objs = []
    for o in s.objects:
        objs.append({
            "name": o.name,
            "type": o.type,
            "location": [round(float(v), 4) for v in o.location],
            "dimensions": [round(float(v), 4) for v in o.dimensions],
            "collections": [c.name for c in o.users_collection],
        })
    return {
        "status": "success",
        "result": {
            "name": s.name,
            "object_count": len(objs),
            "objects": objs,
            "frame": s.frame_current,
            "engine": s.render.engine,
            "blender_version": bpy.app.version_string,
            "bridge": "bpy-module-runtime",
        },
    }


def _exec_code(code):
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(code, "<blender_code>", "exec"), G)
        return {"status": "success", "result": {"result": buf.getvalue()}}
    except Exception:
        tb = traceback.format_exc()
        return {"status": "error", "message": "execute_code failed", "result": tb}


def _screenshot(params):
    path = os.path.abspath(params.get("filepath", os.path.join(OUT_DIR, "viewport.png")))
    try:
        scene = bpy.context.scene
        if scene.camera is None:
            return {"status": "error", "result": {"error": "no camera"}}
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        return {"status": "success", "result": {"filepath": path}}
    except Exception:
        return {"status": "error", "result": {"error": traceback.format_exc()}}


def _export_scene(params):
    path = os.path.abspath(params.get("filepath", os.path.join(OUT_DIR, "zoo.glb")))
    fmt = (params.get("format") or "glb").lower()
    try:
        if fmt == "glb":
            bpy.ops.export_scene.gltf(filepath=path, export_format="GLB")
        elif fmt == "fbx":
            bpy.ops.export_scene.fbx(filepath=path)
        else:
            return {"status": "error", "result": {"error": "unsupported format " + fmt}}
        return {"status": "success", "result": {"filepath": path, "format": fmt}}
    except Exception:
        return {"status": "error", "result": {"error": traceback.format_exc()}}


def handle(msg):
    t = msg.get("type", "")
    p = msg.get("params") or {}
    if t == "execute_code":
        return _exec_code(p.get("code", ""))
    if t == "get_scene_info":
        return _scene_info()
    if t == "get_addon_info":
        return {"status": "success", "result": {
            "name": "MCP for Blender", "version": "5.3.0-bpy-bridge",
            "port": PORT, "runtime": "Blender 5.3 bpy module"}}
    if t == "get_viewport_screenshot":
        return _screenshot(p)
    if t == "export_scene":
        return _export_scene(p)
    return {"status": "error", "result": {"error": "unknown command " + t}}


def serve_client(conn):
    try:
        conn.settimeout(600)
        chunks = b""
        while True:
            data = conn.recv(65536)
            if not data:
                break
            chunks += data
            try:
                msg = json.loads(chunks.decode("utf-8"))
                break
            except json.JSONDecodeError:
                continue
        else:
            return
        resp = handle(msg)
        payload = json.dumps(resp, ensure_ascii=False).encode("utf-8")
        conn.sendall(payload)
    except Exception:
        try:
            conn.sendall(json.dumps({"status": "error", "result": {"error": traceback.format_exc()}},
                                   ensure_ascii=False).encode("utf-8"))
        except Exception:
            pass
    finally:
        conn.close()


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, PORT))
    srv.listen(16)
    print("BRIDGE_READY host=%s port=%s blender=%s" % (HOST, PORT, bpy.app.version_string), flush=True)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=serve_client, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
