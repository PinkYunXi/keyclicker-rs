import subprocess, json, os
OWNER, REPO = "PinkYunXi", "keyclicker-rs"
TAG = "v0.9.0-alpha"
COMMIT = "c5fdd55cfbc173d1fed52b8132607c5fe5255538"
EXE = "D:/AITest/KeyClicker-RS/dist/keyclicker-rs.exe"

def gh(args, stdin=None, ok_fail=False):
    r = subprocess.run(["gh"] + args, input=stdin, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0 and not ok_fail:
        print("FAIL:", " ".join(args), (r.stderr or "")[:400])
        return None
    return r.stdout

# 1. tag 指向最新提交
print("tag:", "ok" if gh(["api", "--method", "PATCH",
    "repos/%s/%s/git/refs/tags/%s" % (OWNER, REPO, TAG), "--input", "-"],
    stdin=json.dumps({"sha": COMMIT, "force": True})) else "fail")

# 2. 替换 release 资产
rel = json.loads(gh(["api", "repos/%s/%s/releases/tags/%s" % (OWNER, REPO, TAG)]))
rid = rel["id"]
for a in rel["assets"]:
    gh(["api", "--method", "DELETE", "repos/%s/%s/releases/assets/%d" % (OWNER, REPO, a["id"])], ok_fail=True)
    print("deleted asset:", a["name"])
up = gh(["api", "--method", "POST",
    "https://uploads.github.com/repos/%s/%s/releases/%d/assets?name=KeyClicker.exe" % (OWNER, REPO, rid),
    "-H", "Content-Type: application/octet-stream", "--input", EXE])
if up:
    d = json.loads(up)
    print("uploaded:", d["name"], d["size"], "bytes")
    print("url:", d["browser_download_url"])
else:
    print("upload failed")
