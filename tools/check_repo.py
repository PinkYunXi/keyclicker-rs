import subprocess, json
OWNER, REPO = "PinkYunXi", "keyclicker-rs"
def gh(a):
    r = subprocess.run(["gh"]+a, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout if r.returncode == 0 else ("ERR " + (r.stderr or "")[:200])
t = json.loads(gh(["api", "repos/%s/%s/git/trees/main?recursive=1" % (OWNER, REPO)]))
print("files in repo:", len([x for x in t["tree"] if x["type"]=="blob"]))
for x in t["tree"]:
    if x["type"]=="blob":
        print(" ", x["path"], x.get("size",""))
rel = json.loads(gh(["api", "repos/%s/%s/releases" % (OWNER, REPO)]))
for r in rel:
    print("release:", r["tag_name"], r["name"], "prerelease=", r["prerelease"])
    for a in r["assets"]:
        print("  asset:", a["name"], a["size"], a["state"])
print("repo url: https://github.com/%s/%s" % (OWNER, REPO))
