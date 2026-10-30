import subprocess, json
OWNER, REPO = "PinkYunXi", "keyclicker-rs"
TAG = "v0.9.0-beta"
ASSET = "KeyClicker-0.9.0-beta-x64.exe"
EXE = "D:/AITest/KeyClicker-RS/dist/keyclicker-rs.exe"
B = chr(96)  # backtick

def gh(args, stdin=None, ok_fail=False):
    r = subprocess.run(["gh"] + args, input=stdin, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        if not ok_fail:
            print("FAIL:", " ".join(args[:4]), (r.stderr or "")[:250])
        return None
    return r.stdout

head = json.loads(gh(["api", "repos/%s/%s/commits/main" % (OWNER, REPO)]))["sha"]
print("head:", head[:7])

rel = json.loads(gh(["api", "repos/%s/%s/releases/tags/%s" % (OWNER, REPO, TAG)]))
rid = rel["id"]
print("existing assets:", [a["name"] for a in rel["assets"]])

body = "\n".join([
    "## KeyClicker 0.9.0-beta (x64)",
    "",
    "轻量的 Windows 键盘连点 / 定时按键工具，单文件绿色版，无需安装。",
    "",
    "### 下载",
    "**" + ASSET + "** —— 双击即用；配置保存在 exe 同目录的 " + B + "clicker_config.json" + B + "。",
    "",
    "### 功能",
    "- 连点：按键 / 组合键，间隔 1 ms – 24 h，实时计数，可暂停 / 继续 / 停止",
    "- 定时序列：分 + 秒倒计时后依次发送一串按键，支持步骤间隔",
    "- 按键录入：直接按键盘录入，自动识别组合键",
    "- 前台窗口锁定：包含 / 精确 / 正则三种匹配，窗口不匹配时不发送",
    "- 多配置页，改动自动保存",
    "- 全局热键：" + B + "Alt" + B + " + " + B + B + " " + B + B + " 启停当前配置，" + B + "F6" + B + " 启停全部配置，可在设置里改",
    "- 托盘 + 设置面板：关闭行为、删除确认、全局热键、主题",
    "- 主题：深色 / 浅色 / 跟随系统",
    "",
    "### 系统要求",
    "- Windows 10 1809+ / Windows 11（**仅 x64**）",
    "- WebView2 运行时（Windows 11 自带；Windows 10 缺少时会提示打开官方下载页）",
    "",
    "### 已知限制",
    "- 未签名，首次运行可能提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」即可（签名正在申请 SignPath Foundation 开源计划）",
    "- 部分全屏独占游戏内可能被反作弊拦截",
    "",
    "构建方式与完整说明见 README。",
])

gh(["api", "--method", "PATCH", "repos/%s/%s/releases/%d" % (OWNER, REPO, rid), "--input", "-"],
   stdin=json.dumps({"name": "KeyClicker 0.9.0-beta (x64)", "body": body, "prerelease": True}))
print("release renamed")

for a in rel["assets"]:
    gh(["api", "--method", "DELETE", "repos/%s/%s/releases/assets/%d" % (OWNER, REPO, a["id"])], ok_fail=True)
    print("deleted asset:", a["name"])

gh(["api", "--method", "PATCH", "repos/%s/%s/git/refs/tags/%s" % (OWNER, REPO, TAG), "--input", "-"],
   stdin=json.dumps({"sha": head, "force": True}))

up = gh(["api", "--method", "POST",
    "https://uploads.github.com/repos/%s/%s/releases/%d/assets?name=%s" % (OWNER, REPO, rid, ASSET),
    "-H", "Content-Type: application/octet-stream", "--input", EXE])
if up:
    d = json.loads(up)
    print("uploaded:", d["name"], d["size"], "bytes")
    print("url:", d["browser_download_url"])
else:
    print("upload FAILED")
