# -*- coding: utf-8 -*-
"""Blender 启动时由命令行 --python 执行：启用 blender_mcp 插件并强制 Start Server。
成功标志：stdout 出现 MCP_START_OK，且 9876 端口开始监听。
"""
import addon_utils
import bpy

addon_utils.enable('blender_mcp', default_set=True)

ops = [a for a in dir(bpy.ops.wm) if 'mcp' in a.lower()]
print('MCP_OPS:', ops)

started = False
for name in ops:
    if 'start' in name.lower():
        try:
            getattr(bpy.ops.wm, name)()
            started = True
            print('MCP_START_OK via', name)
            break
        except Exception as e:
            print('OP_FAIL', name, repr(e))

if not started:
    try:
        import blender_mcp
        cands = [a for a in dir(blender_mcp) if 'server' in a.lower()]
        print('MOD_CANDS', cands)
        if hasattr(blender_mcp, 'BlenderMCPServer'):
            srv = blender_mcp.BlenderMCPServer(host='127.0.0.1', port=9876)
            for meth in ('start', 'start_server', 'run'):
                if hasattr(srv, meth):
                    getattr(srv, meth)()
                    print('MOD_START_OK', meth)
                    break
    except Exception as e:
        print('MOD_FAIL', repr(e))

try:
    bpy.ops.wm.save_userpref()
except Exception as e:
    print('PREF_SAVE_SKIP', repr(e))

print('BOOT_EXPR_DONE')
