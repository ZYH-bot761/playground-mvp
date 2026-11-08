@echo off
chcp 936 >nul
:: 上面两行：关闭命令回显；把控制台代码页切成 GBK，保证本文件的中文提示不乱码
:: ============================================================
::  3D 游乐场 · 一键启动
::  双击本文件即可：探测可用端口 -> 启动 Vite -> 端口就绪后自动打开浏览器
::  停止：在窗口里按 Ctrl+C，然后关闭窗口
:: ============================================================

:: 切换到脚本所在目录，保证从桌面或任意位置双击都能找到 package.json
cd /d "%~dp0"

:: 设置窗口标题，便于任务栏识别
title 3D 游乐场 · 一键启动

echo ==========================================
echo   3D 游乐场 · 一键启动
echo ==========================================
echo.

:: 检查 npm 是否可用；没装 Node.js 时给出明确提示，而不是窗口一闪而过
where npm >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 npm，请先安装 Node.js（建议 20.19 以上）。
    pause
    exit /b 1
)

:: 检查依赖目录；缺少 node_modules 时提示先安装，避免 npm 报一堆无关错误
if not exist "node_modules" (
    echo [错误] 当前目录缺少 node_modules，请先在本目录执行：npm install
    pause
    exit /b 1
)

:: 端口探测：从 5173 开始逐个尝试连接，连得上说明被占用，继续试下一个；
:: 第一个连不上的就是空闲端口，写入 PORT。这样既兼容「5173 被占用」，
:: 又把端口固定下来，浏览器打开的就是真实地址（不写死 5173）
set "PORT="
for /f %%p in ('powershell -NoProfile -Command "$ports=5173..5178; foreach($p in $ports){ $c=New-Object Net.Sockets.TcpClient; try{ $c.Connect([System.Net.IPAddress]::Loopback,$p); $c.Close() } catch { $c.Close(); Write-Output $p; exit } }"') do set "PORT=%%p"

:: 5173-5178 全部被占用：直接提示，不盲目启动
if "%PORT%"=="" (
    echo [错误] 5173-5178 端口全部被占用，请先关闭占用这些端口的程序。
    pause
    exit /b 1
)

echo [信息] 本次使用端口：%PORT%
echo [信息] 访问地址：http://localhost:%PORT%/
echo.

:: 后台静默等待端口就绪，再打开默认浏览器：
:: 既不会在 Vite 还没起来时打开空白页，也不用写死端口号。
:: PowerShell 的 Start-Process 打开默认浏览器，效果等价于 start "" 网址
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 90;$i++){ try{ $c=New-Object Net.Sockets.TcpClient; $c.Connect([System.Net.IPAddress]::Loopback,%PORT%); $c.Close(); Start-Process 'http://localhost:%PORT%/'; exit }catch{ Start-Sleep -Milliseconds 500 } }"

:: 前台启动 Vite：--strictPort 保证端口不被悄悄换掉，日志留在本窗口
call npm run dev -- --port %PORT% --strictPort

:: npm 退出且退出码非 0 = 启动失败，pause 让窗口停留，方便查看报错
if errorlevel 1 (
    echo.
    echo [错误] 开发服务器启动失败，请查看上方 npm 的报错信息。
    pause
)

:: 正常结束（例如按 Ctrl+C 停掉服务后关闭窗口）
exit /b 0
