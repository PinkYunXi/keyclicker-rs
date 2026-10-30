import subprocess, json
OWNER, REPO = "PinkYunXi", "keyclicker-rs"
TAG = "v0.9.0-beta"
EXE = "D:/AITest/KeyClicker-RS/dist/keyclicker-rs.exe"

def gh(args, stdin=None, ok_fail=False):
    r = subprocess.run(["gh"] + args, input=stdin, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0 and not ok_fail:
        print("FAIL:", " ".join(args), (r.stderr or "")[:400])
        return None
    return r.stdout

head = json.loads(gh(["api", "repos/%s/%s/commits/main" % (OWNER, REPO)]))["sha"]
print("head:", head)
print("tag:", "ok" if gh(["api", "--method", "PATCH",
    "repos/%s/%s/git/refs/tags/%s" % (OWNER, REPO, TAG), "--input", "-"],
    stdin=json.dumps({"sha": head, "force": True})) else "fail")

rel = json.loads(gh(["api", "repos/%s/%s/releases/tags/%s" % (OWNER, REPO, TAG)]))
rid = rel["id"]
for a in rel["assets"]:
    gh(["api", "--method", "DELETE", "repos/%s/%s/releases/assets/%d" % (OWNER, REPO, a["id"])], ok_fail=True)
    print("deleted:", a["name"])
up = gh(["api", "--method", "POST",
    "https://uploads.github.com/repos/%s/%s/releases/%d/assets?name=KeyClicker.exe" % (OWNER, REPO, rid),
    "-H", "Content-Type: application/octet-stream", "--input", EXE])
if up:
    d = json.loads(up)
    print("uploaded:", d["name"], d["size"], "bytes")
