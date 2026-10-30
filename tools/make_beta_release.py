import subprocess, json

OWNER, REPO = "PinkYunXi", "keyclicker-rs"
OLD_TAG = "v0.9.0-alpha"
NEW_TAG = "v0.9.0-beta"
EXE = "D:/AITest/KeyClicker-RS/dist/keyclicker-rs.exe"
TICK = chr(96)

def gh(args, stdin=None, ok_fail=False):
    r = subprocess.run(["gh"] + args, input=stdin, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        if not ok_fail:
            print("FAIL:", " ".join(args), (r.stderr or "")[:300])
        return None
    return r.stdout

head = json.loads(gh(["api", "repos/%s/%s/commits/main" % (OWNER, REPO)]))["sha"]
print("head:", head)

rel = gh(["api", "repos/%s/%s/releases/tags/%s" % (OWNER, REPO, OLD_TAG)], ok_fail=True)
if rel:
    rid = json.loads(rel)["id"]
    ok = gh(["api", "--method", "DELETE", "repos/%s/%s/releases/%d" % (OWNER, REPO, rid)], ok_fail=True)
    print("delete alpha release:", "ok" if ok is not None else "fail")
else:
    print("alpha release not found")

ok = gh(["api", "--method", "DELETE", "repos/%s/%s/git/refs/tags/%s" % (OWNER, REPO, OLD_TAG)], ok_fail=True)
print("delete alpha tag:", "ok" if ok is not None else "skip/fail")

print("create beta tag:", "ok" if gh(["api", "--method", "POST",
    "repos/%s/%s/git/refs" % (OWNER, REPO), "--input", "-"],
    stdin=json.dumps({"ref": "refs/tags/" + NEW_TAG, "sha": head})) else "fail")

body = "\n".join([
    "## KeyClicker 0.9.0-beta",
    "",
    "参考 KeyClicker 1.2.4 重写的键盘连点器，Rust + WebView2 实现，单文件绿色版，无 PyQt6 的 GPL 授权问题。",
    "",
    "### 下载",
    "KeyClicker.exe：单文件，双击即用。已内嵌 WebView2 安装器，Win10 缺少 WebView2 时首次启动会提示一键安装。",
    "",
    "### 功能",
    "- 键盘连点：单键 / 组合键，间隔 1ms–24h，随机浮动，次数限制",
    "- 定时序列：分+秒倒计时后依次发送一串按键",
    "- 全局热键录入：录入时自动吞键，支持 Alt/Ctrl/Shift/Win 组合",
    "- 窗口锁定：不锁定 / 标题包含 / 标题精确 / 正则 / 指定进程",
    "- 抓取窗口：倒数后吸附到目标窗口",
    "- 设置面板（标题栏齿轮或托盘右键）：关闭行为、删除配置页确认、全局热键、主题",
    "- 全局启停热键：默认 Alt+" + TICK + " 启停当前配置，F6 启停全部",
    "- 托盘图标 + 右键菜单（显示主界面 / 设置 / 退出），单实例",
    "- 主题：跟随系统 / 浅色 / 深色，无边框圆角、响应式布局",
    "- 配置自动保存，兼容旧版 KeyClicker v2 / v1.1.0 配置",
    "",
    "### 系统要求",
    "- Windows 10 1809+ / Windows 11（x64）",
    "- WebView2 Runtime（Win11 自带；Win10 缺失时首次启动提示安装）",
    "",
    "### 已知限制",
    "- 仅 x64，未签名，SmartScreen 可能提示（签名方案见 docs/CODE_SIGNING.md）",
    "- 部分全屏独占游戏内注入可能被反作弊拦截",
    "- 窗口尺寸限制在 720x520 ~ 1120x800，不支持最大化",
    "",
    "构建方式见 README.md。",
])

rel = gh(["api", "--method", "POST", "repos/%s/%s/releases" % (OWNER, REPO), "--input", "-"],
         stdin=json.dumps({"tag_name": NEW_TAG, "name": "KeyClicker 0.9.0-beta",
                           "body": body, "draft": False, "prerelease": True}))
if not rel:
    rel = gh(["api", "repos/%s/%s/releases/tags/%s" % (OWNER, REPO, NEW_TAG)])
rid = json.loads(rel)["id"]
print("release id:", rid)

up = gh(["api", "--method", "POST",
         "https://uploads.github.com/repos/%s/%s/releases/%d/assets?name=KeyClicker.exe" % (OWNER, REPO, rid),
         "-H", "Content-Type: application/octet-stream", "--input", EXE])
if up:
    d = json.loads(up)
    print("uploaded:", d["name"], d["size"], "bytes")
    print("url:", d["browser_download_url"])
else:
    print("upload FAILED")
