# -*- coding: utf-8 -*-
"""把阶段 6（我的家 · 现代别墅）补进 项目信息.docx（原地增量，不重生成）。"""
import sys
from copy import deepcopy

from docx import Document
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from docx.table import Table, _Row

TARGET = r'D:\playground-mvp\项目信息.docx'
doc = Document(TARGET)
body = doc.element.body


def find_p(prefix):
    for p in doc.paragraphs:
        if p.text.strip().startswith(prefix):
            return p
    raise SystemExit('missing paragraph: ' + prefix)


def find_table(first_cell):
    for t in doc.tables:
        if t.rows and t.rows[0].cells[0].text.strip().startswith(first_cell):
            return t
    raise SystemExit('missing table: ' + first_cell)


H1_T = find_p('06  阶段 5')
H2_T = find_p('6.1  ')
BODY_T = find_p('边界修正：WASD')
BULLET_T = find_p('相机铁律（强化）')
TBL_T = find_table('套件')
CAL2_T = find_table('先记住这一条')
CAL3_T = find_table('口径纠偏：30 万是三角面')
ANCHOR = find_p('附录  术语与验收记录')._p


# ---------- 段落 ----------
def mk_p(template, text, page_break=False):
    el = deepcopy(template._p)
    for child in list(el):
        if child.tag in (qn('w:r'), qn('w:hyperlink'), qn('w:bookmarkStart'), qn('w:bookmarkEnd')):
            el.remove(child)
    r = OxmlElement('w:r')
    t = OxmlElement('w:t')
    t.set(qn('xml:space'), 'preserve')
    t.text = text
    r.append(t)
    ppr = el.find(qn('w:pPr'))
    if ppr is not None:
        ppr.addnext(r)
    else:
        el.insert(0, r)
    if page_break:
        ppr = el.find(qn('w:pPr'))
        if ppr is None:
            ppr = OxmlElement('w:pPr')
            el.insert(0, ppr)
        ppr.append(OxmlElement('w:pageBreakBefore'))
    return el


# ---------- 表格 ----------
def set_cell(cell, text):
    ps = cell._tc.findall(qn('w:p'))
    for extra in ps[1:]:
        cell._tc.remove(extra)
    p = ps[0]
    for r in p.findall(qn('w:r'))[1:]:
        p.remove(r)
    runs = p.findall(qn('w:r'))
    if runs:
        for t in runs[0].findall(qn('w:t')):
            runs[0].remove(t)
        t = OxmlElement('w:t')
        t.set(qn('xml:space'), 'preserve')
        t.text = text
        runs[0].append(t)
    else:
        r = OxmlElement('w:r')
        t = OxmlElement('w:t')
        t.set(qn('xml:space'), 'preserve')
        t.text = text
        r.append(t)
        p.append(r)


def mk_table(rows, widths=None):
    el = deepcopy(TBL_T._tbl)
    tbl = Table(el, doc)
    while len(tbl.rows) < len(rows):
        tbl._tbl.append(deepcopy(tbl.rows[-1]._tr))
    while len(tbl.rows) > len(rows):
        tbl._tbl.remove(tbl.rows[-1]._tr)
    for i, data in enumerate(rows):
        for j, txt in enumerate(data):
            set_cell(tbl.rows[i].cells[j], txt)
    if widths:
        grid = el.find(qn('w:tblGrid'))
        cols = grid.findall(qn('w:gridCol'))
        for gc, w in zip(cols, widths):
            gc.set(qn('w:w'), str(w))
    return el


def mk_cal2(title, line):
    el = deepcopy(CAL2_T._tbl)
    cell = Table(el, doc).rows[0].cells[0]
    ps = cell._tc.findall(qn('w:p'))
    for extra in ps[2:]:
        cell._tc.remove(extra)
    _set_para(ps[0], title)
    _set_para(ps[1], line)
    return el


def mk_cal3(title, l1, l2):
    el = deepcopy(CAL3_T._tbl)
    cell = Table(el, doc).rows[0].cells[0]
    ps = cell._tc.findall(qn('w:p'))
    for extra in ps[3:]:
        cell._tc.remove(extra)
    _set_para(ps[0], title)
    _set_para(ps[1], l1)
    _set_para(ps[2], l2)
    return el


def _set_para(p, text):
    for r in p.findall(qn('w:r'))[1:]:
        p.remove(r)
    runs = p.findall(qn('w:r'))
    if runs:
        for t in runs[0].findall(qn('w:t')):
            runs[0].remove(t)
        t = OxmlElement('w:t')
        t.set(qn('xml:space'), 'preserve')
        t.text = text
        runs[0].append(t)
    else:
        r = OxmlElement('w:r')
        t = OxmlElement('w:t')
        t.set(qn('xml:space'), 'preserve')
        t.text = text
        r.append(t)
        p.append(r)


# ---------- 正文内容 ----------
blocks = []
blocks.append(mk_p(H1_T, '07  阶段 6 · 我的家（现代别墅）与同场并置（2026-11-18）', page_break=True))
blocks.append(mk_p(BODY_T, '本章记录交接文档 v1.1（最后验证 2026-11-17）之后的唯一一次结构性变更：用户自有住所「现代别墅」从「独立设施副本」改为「同场并置的嵌入视图」，并完成四层重排、三段楼梯重做与楼梯口通行修复。本章与旧章节冲突时，以本章与 docs/current-status.md 为准。'))

blocks.append(mk_p(H2_T, '7.1  一句话变更'))
blocks.append(mk_cal2('别墅不再「另开一个世界」',
    '旧实现把别墅注册成独立 attraction：进门 dispose 大厅、出门重建大厅，「窗外」只能画假园区，所以看上去永远不是大厅。阶段 6 改为 FacilityRuntime 的 IEmbeddedView：大厅常驻，别墅按城市里的真实位置落位，只藏掉城市那层实心外壳。'))
blocks.append(mk_cal3('由此得到的产品结论',
    '别墅的窗户与阳台是「真视野」，不是贴图或远景板：视野里的城堡、摩天轮、马路、树与行驶中的车辆，都是同一套大厅网格。',
    '代价是必须同时做到坐标换算与外壳隐藏，缺一件就会看到「站在盒子内壁里」或「景物整体反向」。'))

blocks.append(mk_p(H2_T, '7.1.1  变更对照'))
blocks.append(mk_table([
    ['维度', '阶段 5 之前', '阶段 6 现状'],
    ['生命周期', '独立设施，进入即 dispose 大厅', '嵌入视图，大厅全程常驻不卸载'],
    ['入口分流', 'attractionManager.activate(villa)', 'facilityRuntime.activate(villa)'],
    ['窗外与阳台', '程序化假园区（旧 _buildOutdoor）', '真实都会区与大厅网格（同场）'],
    ['相机', '别墅自行接管并直写 camera.position', 'CameraRig blendTo 锚点，视图不写相机'],
    ['HUD', '别墅 HUD 与大厅 HUD 叠字', '进入收起 .lb-ui / .pg-ui，退出原样恢复'],
    ['落脚', '世界原点附近的独立场景', 'CITY_VILLA(-30,134) 实地落位，yaw = π'],
], widths=[2100, 3400, 3860]))

blocks.append(mk_p(H2_T, '7.2  坐标与常量'))
blocks.append(mk_table([
    ['常量 / 项', '值', '说明与坑'],
    ['CITY_VILLA', 'x=-30、z=134、w=20、d=16、h=9；门 (-30,125.7)', '城市侧地址权威；别墅与它同尺寸、同门位'],
    ['VILLA_ORIGIN', 'x=-30、y=1.2、z=134、yaw=π', '城市地面 y≈1.16，抬 0.04 避免与地面共面'],
    ['HOUSE / LEVELS', 'W20 × D16；[-3.6, 0, 3.6, 7.2]', 'B1 / 1F / 2F / 3F 四层楼板标高'],
    ['STAIR_X 与竖井', 'x∈[-9.55,-6.85]、z∈[-7.8,7.8]', '三段楼梯共用同一竖井，东西两侧是墙'],
    ['三段楼梯', 'z∈[-7,-3] / [-2,2] / [3,7]', '出发层全段栏板，到达层留 1.1m 平台口'],
    ['BALCONY', 'x∈[-3.6,3.6]、z∈[8,10.8]', '2F / 3F 南向阳台，推门即出'],
    ['SHAFT（电梯）', 'x∈[6.4,9]、z∈[-6.8,-4.2]', '四层贯通，右侧按钮直接切层'],
    ['SPAWN', '(0, 0, 6.2)、yaw 0', '入户站在 1F 玄关，面朝室内'],
], widths=[2100, 3400, 3860]))
blocks.append(mk_cal3('本地坐标 → 世界坐标的符号翻转',
    '别墅 root 转了 180°，于是世界 x = -30 - 本地 x、世界 z = 134 - 本地 z；「本地向 +z（朝南门）」在世界里是 -z。',
    '写测试、摆机位、算碰撞都要先过一次换算，凭直觉会整体反向；历史上的「2F / 3F 出口全堵」误判就是这么来的。'))

blocks.append(mk_p(H2_T, '7.3  四层功能分区'))
blocks.append(mk_table([
    ['楼层', '定位', '主要家具与设施'],
    ['B1', '车库 + 家政', '轿车与 SUV 各一辆（可认领驾驶）、洗衣房（洗衣机 / 洗衣篮）、扫地机器人巡线'],
    ['1F', '玄关 + 客厅 + 餐厨', '鞋柜 / 穿衣镜 / 挂衣杆、布艺沙发 + 电视墙 + 地毯茶几、开放厨房（一字台 + 中岛 + 冰箱 + 菜刀架）、餐桌四椅、客卫台盆与镜柜、吸顶灯与落地灯'],
    ['2F', '起居 + 健身 + 娱乐 + 浴室 + 阳台', '起居沙发与电视、跑步机 / 哑铃架 / 瑜伽垫、台球桌 / 街机 / 飞镖靶、干湿分离浴室、南向阳台'],
    ['3F', '主卧 + 主卫 + 衣帽间 + 阳台', '双人床与床头柜、浴缸 / 淋浴 / 台盆、三扇衣柜 + 抽屉柜 + 试衣镜、书房角、南向阳台'],
], widths=[900, 2600, 5860]))
blocks.append(mk_p(BODY_T, '每层只放该层该有的东西，同一件家具不在两层重复出现；四层全部由右侧电梯按钮直达（3F 主卧 / 2F 起居 / 1F 玄关 / B1 车库），电梯与楼梯互不影响。'))

blocks.append(mk_p(H2_T, '7.4  三段楼梯与通行'))
blocks.append(mk_table([
    ['段', '本地 z 区间 / 世界 z 区间', '平台口与碰撞'],
    ['B1 ↔ 1F', '本地 [-7,-3] / 世界 [131,127]', 'B1 出发全段栏板；1F 到达层留 1.1m 口'],
    ['1F ↔ 2F', '本地 [-2,2] / 世界 [136,132]', '2F 到达层留口；出口向东 ≥3m 不被沙发挡'],
    ['2F ↔ 3F', '本地 [3,7] / 世界 [131,127]', '3F 到达层留口；出口向东 ≥3m 不被衣柜挡'],
], widths=[1500, 3300, 4560]))
blocks.append(mk_p(BULLET_T, '脚高由支撑面求解：电梯井按 y 直接给、楼梯按 z 线性插值、阳台走阳台板、其余走楼板；上一帧脚高与当前面高差超过 1.7m 视为「翻层」，不接力，避免一帧跳 3.6m。'))
blocks.append(mk_p(BULLET_T, '楼板按洞真实切分（楼梯井 + 电梯井），不再整块盖住井口；玩家不会「站在一个地方突然掉到车库」。'))
blocks.append(mk_p(BULLET_T, '栏板是分段级的：只在出发层与到达层建碰撞，不再对全楼层生效；旧实现的全 2D 碰撞会在下层客厅里凭空多出隐形墙。'))
blocks.append(mk_p(BULLET_T, '平台口净宽 1.1m，玩家碰撞直径 1.0m；低于 1.1m 的口子物理上过不去。改任何家具、隔断前先量这个数。'))

blocks.append(mk_p(H2_T, '7.5  嵌入视图契约'))
blocks.append(mk_table([
    ['方法', '职责', '注意'],
    ['init(ctx)', '建 root、定位到 VILLA_ORIGIN、visible=false 常驻', '不碰相机、不建 UI、不 attach WASD'],
    ['getCameraAnchor()', '返回 1F 玄关世界锚点 (-30, 2.8, 127.8) 与朝向', '锚点交给 FacilityRuntime 的 blendTo，视图不自己写相机'],
    ['activate()', '显 root、藏 City/villa 外壳、near 0.06、建 WASD、挂 HUD', '禁止直写 camera.position，会和 blendTo 打架'],
    ['deactivate()', '藏 root、还原外壳、销毁 WASD、摘 HUD、near 0.1', 'WASD 的 dispose 是终态，每次回家都要重建'],
    ['update(dt)', '只读相机、算脚高、写 HUD 与提示文本', 'cameraRig.isTransitioning 为真时跳过相机写入'],
    ['dispose()', '从场景摘 root、恢复外壳、摘 UI', '大厅全程不 dispose，只切显隐'],
], widths=[2100, 3900, 3360]))
blocks.append(mk_p(BULLET_T, '注册表接线（src/main.js）：EMBEDDED_KEYS 增加 villa；删除 attractionManager.register(villa)；改为 facilityRuntime.register(villa, () => new VillaEmbedView(baseCtx))；dayNightCycle.registerEmbeddedContext(villa) 让昼夜循环照到室内。'))
blocks.append(mk_p(BULLET_T, '适配器在 src/components/embedded-views/villa-embed-view.js，只做双向委托；初始化时需把 baseCtx 的 onExitAttraction 合并进去，因为 FacilityRuntime 的 ctx 不含该回调。'))
blocks.append(mk_p(BULLET_T, '外壳隐藏与恢复写在 activate / deactivate：进场把 City/villa 设为不可见（否则等于站在盒内壁里），退场原样恢复；别墅与城市盒顶相差 0.64m，在室内看不出来，接受。'))

blocks.append(mk_p(H2_T, '7.6  本轮修复的根因'))
blocks.append(mk_table([
    ['症状', '根因', '修法'],
    ['门口按 E 毫无反应', '漫游层的 isEngaged() 吞掉 E；预热重建时监听被移除且守卫漏判；触发半径 4.5m 太小且超距零反馈', '收敛为 _villaDoorState / _tryEnterVilla / _updateVillaDoor 单一判定；半径 6.0m；16m 内超距给提示；提示条可点；门洞进拾取表'],
    ['上楼扭一下就没了、往下走突然到地下', '楼梯用可写 _level 选段、相机 y 反推楼层，一帧跳 3.6m；楼板整块无洞，穿模', '支撑面求解 + 固定三段跑道；逐帧高差 1.7m 才接力'],
    ['3F 楼梯口被「柜子」挡死', '衣柜横在出口只留 0.35m；楼梯井碰撞全局 2D 对三层同时生效，平台口只剩 0.7m；隔断直抵南墙', '分段级栏板 + 1.1m 平台口；衣柜沿北墙拆成三扇；抽屉柜与试衣镜移位；隔断缩到 z=6.2'],
    ['画面一直闪、像卡住', '每层多建 0.1m 厚「天花板」与上层楼板共面，z-fighting；玻璃透明但未关 depthWrite', '删掉多余天花板；玻璃 depthWrite=false、opacity 0.28；楼板改双层错层；墙体嵌进楼板 0.04m'],
    ['别墅 HUD 与大厅 HUD 叠字', '两层 UI 同时挂在 document.body 上', 'activate 收起 .lb-ui 与 .pg-ui，deactivate 原样恢复'],
], widths=[2400, 3900, 3060]))

blocks.append(mk_p(H2_T, '7.7  验收与基线（2026-11-18 实测）'))
blocks.append(mk_table([
    ['套件', '结果', '关键指标'],
    ['npx vite build', 'PASS', '无新增告警；vendor-physics 仍保持懒加载分块'],
    ['verify-villa-door', '8/8 PASS', '门口按 E、提示条点击、飞行态拒绝、超距提示、进出往返闭环、0 报错'],
    ['verify-villa-embed', '12/12 PASS', '大厅不卸载；落位 (-30,1.2,134) 且转 π；3F / 2F 出口各能东行 ≥3m；1F 门封死；阳台视野 city=90 / villa=9'],
    ['verify-villa、verify-villa-stairs、villa-capture', '待适配', '仍是「独立场景 + 本地相机」口径，脚本未改；不影响运行，改口径后再进联合门禁'],
], widths=[2900, 1300, 5160]))
blocks.append(mk_p(BODY_T, '本章为增量补充：scripts/generate-doc.js 尚未并入阶段 6 内容，下次整份重新生成前必须先同步脚本，否则本章会丢失。'))

blocks.append(mk_p(H2_T, '7.8  新增铁律'))
blocks.append(mk_p(BULLET_T, '嵌入视图不得 dispose 常驻世界：新增「进到某个空间」的玩法优先走 IEmbeddedView；只有真正独占整套场景的设施才允许走 attractionManager。'))
blocks.append(mk_p(BULLET_T, '视图不写相机：activate 只设锚点字段，位置与朝向交给 CameraRig 的 blendTo；update 遇到 cameraRig.isTransitioning 必须跳过写入。'))
blocks.append(mk_p(BULLET_T, '视觉与碰撞必须同源：栏板、门洞、隔断的长度用同一常量推导；「看得见的挡」与「撞得到的挡」不一致，就是下一个「被柜子挡住」。'))
blocks.append(mk_p(BULLET_T, '通行口净宽 ≥1.1m（玩家直径 1.0m）；出口沿走廊至少留 3m 才允许落家具，布置前先量通道再摆物件。'))
blocks.append(mk_p(BULLET_T, '楼层脚高一律用世界 y（本地 y 只差一个 _baseY）；新增楼层先改 LEVELS 再改家具，不要反过来。'))

for el in blocks:
    ANCHOR.addprevious(el)

# ---------- 封面信息表 ----------
cover = find_table('文档项')
rows = {r.cells[0].text.strip(): r for r in cover.rows}
set_cell(rows['文档版本'].cells[1], 'v1.2 / 阶段6「我的家」嵌合版')
set_cell(rows['适用阶段'].cells[1], '阶段 1–6 已完成；阶段 6 为别墅精修与同场并置')
set_cell(rows['最后验证'].cells[1], '2026-11-18')
set_cell(rows['代码状态'].cells[1], 'npm run build 通过；核心验收 73/73 + 别墅门口 8/8、别墅嵌入 12/12')

# ---------- 一句话定位 ----------
pos = find_table('一句话定位')
_set_para(pos.rows[0].cells[0]._tc.findall(qn('w:p'))[1],
          '一个可步行、可驾车、可昼夜与四季切换的 Three.js 微缩城市；所有资产程序化生成，物理按需懒加载，性能红线由脚本守门。自有别墅与城市同场并置，窗外即真实大厅。')

# ---------- 0.2 文档导航：附录前插一行 ----------
nav = find_table('章节')
last_tr = nav.rows[-1]._tr
new_tr = deepcopy(last_tr)
last_tr.addprevious(new_tr)
row = _Row(new_tr, nav)
set_cell(row.cells[0], '06 – 07 阶段 5 加固 · 阶段 6 我的家')
set_cell(row.cells[1], '交接后新增了什么、别墅如何并进大厅、怎么验收')
set_cell(row.cells[2], '所有接手者')

# ---------- 术语表补三条 ----------
gloss = find_table('术语')
for name, meaning in [
    ('嵌入视图 IEmbeddedView', '与常驻世界同场并置、只切换显隐与输入的设施视图；进入时不卸载大厅'),
    ('同场并置', '别墅与城市共用同一 scene 与同一世界坐标，实地落位，两边视野互相可见'),
    ('外壳隐藏', '进入室内时把城市侧实心壳 City/villa 设为不可见，避免玩家站在盒内壁里'),
]:
    for _ in range(1):
        new_tr = deepcopy(gloss.rows[-1]._tr)
        gloss.rows[-1]._tr.addnext(new_tr)
        r = _Row(new_tr, gloss)
        set_cell(r.cells[0], name)
        set_cell(r.cells[1], meaning)

# ---------- 文末结语 ----------
closing = None
for p in doc.paragraphs:
    if p.text.strip().startswith('文档结束'):
        closing = p
if closing is not None:
    _set_para(closing._p, '文档结束。项目在 2026-11-18 完成阶段 6：自有别墅与城市同场并置，四层功能分区、三段楼梯与楼梯口通行全部收口。后续维护请先读第 07 章与 docs/current-status.md，再动第一行代码。')

doc.save(TARGET)
print('OK blocks=%d' % len(blocks))
