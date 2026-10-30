import subprocess, json, sys, os

OWNER, REPO = "PinkYunXi", "keyclicker-rs"
TAG = "v0.9.0-beta"
COMMIT = "d6221b7ab1140151fd5b947942757ff6783df0fc"
EXE = "D:/AITest/KeyClicker-RS/dist/keyclicker-rs.exe"

def gh(args, stdin=None):
    r = subprocess.run(["gh"] + args, input=stdin, capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print("FAIL:", " ".join(args), (r.stderr or "")[:800])
        return None
    return r.stdout

out = gh(["api", "--method", "POST", "repos/%s/%s/git/refs" % (OWNER, REPO), "--input", "-"],
         stdin=json.dumps({"ref": "refs/tags/" + TAG, "sha": COMMIT}))
if out is None:
    out = gh(["api", "--method", "PATCH", "repos/%s/%s/git/refs/tags/%s" % (OWNER, REPO, TAG), "--input", "-"],
             stdin=json.dumps({"sha": COMMIT, "force": True}))
print("tag:", "ok" if out else "fail")

body = """## KeyClicker 0.9.0-beta

参考 KeyClicker 1.2.4 重写的键盘连点器，Rust + WebView2 实现，单文件绿色版，无 PyQt6 的 GPL 授权问题。

### 下载
KeyClicker.exe：单文件，双击即用。已内嵌 WebView2 安装器，Win10 缺少 WebView2 时首次启动会提示一键安装。

### 功能
- 键盘连点：单键 / 组合键（最多 4 个），间隔 1ms–24h，随机浮动，次数限制
- 定时点击：指定时刻或延时触发
- 全局热键录入：录制时自动吞键，支持 Alt/Ctrl/Shift/Win 组合
- 窗口锁定：不锁定 / 标题包含 / 标题精确 / 正则 / 指定进程，切换窗口自动暂停恢复
- 抓取窗口：点击后吸附到目标窗口
- 全局启停热键：Alt+ 反引号 与 F6
- 托盘图标 + 右键菜单，单实例（重复启动唤起已有窗口）
- 主题：跟随系统 / 浅色 / 深色，无边框圆角、可拖拽、支持 150% 缩放的响应式布局
- 配置自动保存，兼容旧版 KeyClicker v2 / v1.1.0 配置

### 系统要求
- Windows 10 1809+ / Windows 11（x64）
- WebView2 Runtime（Win11 自带；Win10 缺失时首次启动提示安装）

### 已知限制（beta）
- 仅 x64，未签名，SmartScreen 可能提示
- 部分全屏独占游戏内注入可能被反作弊拦截
- 高 DPI 多显示器混合缩放下布局可能需手动调整窗口大小

构建方式见 README.md。"""

rel = gh(["api", "--method", "POST", "repos/%s/%s/releases" % (OWNER, REPO), "--input", "-"],
         stdin=json.dumps({"tag_name": TAG, "name": "KeyClicker 0.9.0-beta",
                           "body": body, "draft": False, "prerelease": True}))
if rel is None:
    rel = gh(["api", "repos/%s/%s/releases/tags/%s" % (OWNER, REPO, TAG)])
rid = json.loads(rel)["id"]
print("release id:", rid)

up = gh(["api", "--method", "POST",
         "https://uploads.github.com/repos/%s/%s/releases/%d/assets?name=KeyClicker.exe" % (OWNER, REPO, rid),
         "-H", "Content-Type: application/octet-stream", "--input", EXE])
print("upload:", "ok" if up else "FAIL")
if up:
    print("url:", json.loads(up)["browser_download_url"])
