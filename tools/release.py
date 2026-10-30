"""一键发版：python tools/release.py alpha|beta|stable

按 docs/RELEASING.md 的规则：patch 位 +1，后缀表示阶段，号不重置。
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OWNER, REPO = "PinkYunXi", "keyclicker-rs"
STAGES = {"alpha": "-alpha", "beta": "-beta", "stable": ""}

def sh(args, cwd=ROOT, check=True, capture=True):
    r = subprocess.run(args, cwd=str(cwd), capture_output=capture, text=True,
                       encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        print(r.stdout or "", r.stderr or "")
        raise SystemExit("命令失败: " + " ".join(map(str, args)))
    return r

def gh(args, stdin=None, ok_fail=False):
    r = subprocess.run(["gh"] + args, input=stdin, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        if not ok_fail:
            print("FAIL:", " ".join(args[:4]), (r.stderr or "")[:300])
            raise SystemExit(1)
        return None
    return r.stdout

def main():
    stage = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
    if stage not in STAGES:
        raise SystemExit("用法: python tools/release.py alpha|beta|stable")

    cargo = ROOT / "Cargo.toml"
    text = cargo.read_text(encoding="utf-8")
    m = re.search(r'^version = "([^"]+)"', text, re.M)
    if not m:
        raise SystemExit("Cargo.toml 里没找到 version")
    cur = m.group(1)
    sm = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta))?$", cur)
    if not sm:
        raise SystemExit("无法解析当前版本: " + cur)
    major, minor, patch, cur_stage = sm.groups()
    new_version = "%s.%s.%d%s" % (major, minor, int(patch) + 1, STAGES[stage])
    tag = "v" + new_version
    asset = "KeyClicker-%s-x64.exe" % new_version
    print("版本: %s -> %s  (阶段 %s)" % (cur, new_version, stage or "stable"))

    # 1) 写回版本号
    text = re.sub(r'^version = "[^"]+"', 'version = "%s"' % new_version, text, count=1, flags=re.M)
    cargo.write_text(text, encoding="utf-8")
    readme = ROOT / "README.md"
    rt = readme.read_text(encoding="utf-8")
    rt = re.sub(r"^# KeyClicker .*$", "# KeyClicker " + new_version, rt, count=1, flags=re.M)
    readme.write_text(rt, encoding="utf-8")

    # 2) 生成资源 + 编译
    print("生成 UI 资源…")
    sh([sys.executable, "tools/gen_ui_assets.py"])
    print("编译 release…")
    sh(["cargo", "build", "--release"])
    built = ROOT / "target" / "release" / "keyclicker-rs.exe"
    out = ROOT / "target" / "release" / asset
    shutil.copyfile(built, out)
    size = out.stat().st_size
    print("产物: %s (%d bytes)" % (out.name, size))

    # 3) 推送源码
    print("推送源码…")
    sh([sys.executable, "tools/push_via_api.py"], check=True)
    head = json.loads(gh(["api", "repos/%s/%s/commits/main" % (OWNER, REPO)]))["sha"]
    print("head:", head[:7])

    # 4) 创建 tag
    gh(["api", "--method", "POST", "repos/%s/%s/git/refs" % (OWNER, REPO), "--input", "-"],
       stdin=json.dumps({"ref": "refs/tags/" + tag, "sha": head}), ok_fail=True)
    print("tag:", tag)

    # 5) 创建 Release
    body = "\n".join([
        "## KeyClicker %s (x64)" % new_version,
        "",
        "轻量的 Windows 键盘连点 / 定时按键工具，单文件绿色版，无需安装。",
        "",
        "### 下载",
        "**" + asset + "** —— 双击即用；配置保存在 exe 同目录的 " + chr(96) + "clicker_config.json" + chr(96) + "。",
        "",
        "### 说明",
        "- 仅支持 Windows 10 1809+ / Windows 11（x64）",
        "- WebView2 运行时：Windows 11 自带；Windows 10 缺失时会提示打开官方下载页",
        "- 未签名，首次运行可能提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」",
        "",
        "完整功能与构建说明见 README。",
    ])
    rel = gh(["api", "--method", "POST", "repos/%s/%s/releases" % (OWNER, REPO), "--input", "-"],
             stdin=json.dumps({
                 "tag_name": tag,
                 "name": "KeyClicker %s (x64)" % new_version,
                 "body": body,
                 "draft": False,
                 "prerelease": stage != "stable",
             }))
    rid = json.loads(rel)["id"]

    # 6) 上传资产
    up = gh(["api", "--method", "POST",
             "https://uploads.github.com/repos/%s/%s/releases/%d/assets?name=%s" % (OWNER, REPO, rid, asset),
             "-H", "Content-Type: application/octet-stream", "--input", str(out)])
    d = json.loads(up)
    print("已发布:", d["browser_download_url"])

    # 7) 同步到本地部署目录
    dist = Path("D:/AITest/KeyClicker-RS/dist")
    if dist.exists():
        subprocess.run(["taskkill", "/F", "/IM", "keyclicker-rs.exe"], capture_output=True)
        shutil.copyfile(built, dist / "keyclicker-rs.exe")
        print("已部署到", dist / "keyclicker-rs.exe")
    print("\n完成:", new_version, tag)

if __name__ == "__main__":
    main()
