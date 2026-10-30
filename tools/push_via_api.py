import subprocess, base64, json, os, sys

OWNER = "PinkYunXi"
REPO = "keyclicker-rs"
ROOT = "D:/AIproject/keyclicker-rs"
SKIP_DIRS = {"target", ".git", "dist", "logs"}
SKIP_EXT = {".log", ".pdb"}

def gh(args, stdin=None, check=True):
    r = subprocess.run(["gh"] + args, input=stdin, capture_output=True,
                       text=True, encoding="utf-8", errors="replace", cwd=ROOT)
    if r.returncode != 0:
        print("GH FAIL:", " ".join(args), (r.stderr or "")[:600])
        if check:
            sys.exit(1)
        return None
    return r.stdout

files = []
for base, dirs, names in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for n in sorted(names):
        if os.path.splitext(n)[1].lower() in SKIP_EXT:
            continue
        p = os.path.join(base, n)
        rel = os.path.relpath(p, ROOT).replace("\\", "/")
        files.append(rel)
files.sort()
print("files:", len(files))

first = "README.md"
r = subprocess.run(["gh", "api", "repos/%s/%s/contents/%s" % (OWNER, REPO, first)],
                   capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=ROOT)
sha_existing = None
if r.returncode == 0:
    try:
        sha_existing = json.loads(r.stdout)["sha"]
    except Exception:
        pass
print("existing readme sha:", sha_existing)

b64 = base64.b64encode(open(os.path.join(ROOT, first), "rb").read()).decode()
payload = {"message": "KeyClicker 0.9.0-alpha: initial import", "content": b64}
branch = "main"
if sha_existing:
    payload["sha"] = sha_existing
    info = json.loads(gh(["api", "--method", "PUT",
                          "repos/%s/%s/contents/%s" % (OWNER, REPO, first), "--input", "-"],
                         stdin=json.dumps(payload)))
else:
    info = json.loads(gh(["api", "--method", "PUT",
                          "repos/%s/%s/contents/%s" % (OWNER, REPO, first), "--input", "-"],
                         stdin=json.dumps(payload)))
base_commit = info["commit"]["sha"]
print("base commit:", base_commit)

tree = [{"path": first, "mode": "100644", "type": "blob", "sha": info["content"]["sha"]}]
for path in files:
    if path == first:
        continue
    data = open(os.path.join(ROOT, path), "rb").read()
    body = json.dumps({"content": base64.b64encode(data).decode(), "encoding": "base64"})
    res = json.loads(gh(["api", "--method", "POST",
                         "repos/%s/%s/git/blobs" % (OWNER, REPO), "--input", "-"], stdin=body))
    mode = "100755" if path.endswith((".exe", ".bat", ".cmd", ".sh")) else "100644"
    tree.append({"path": path, "mode": mode, "type": "blob", "sha": res["sha"]})
    print("  blob", path, len(data))

tree_sha = json.loads(gh(["api", "--method", "POST",
                          "repos/%s/%s/git/trees" % (OWNER, REPO), "--input", "-"],
                         stdin=json.dumps({"tree": tree})))["sha"]
commit_sha = json.loads(gh(["api", "--method", "POST",
                            "repos/%s/%s/git/commits" % (OWNER, REPO), "--input", "-"],
                           stdin=json.dumps({"message": "KeyClicker 0.9.0-alpha: Rust + WebView2 rewrite",
                                             "tree": tree_sha, "parents": [base_commit]})))["sha"]
gh(["api", "--method", "PATCH", "repos/%s/%s/git/refs/heads/%s" % (OWNER, REPO, branch),
    "--input", "-"], stdin=json.dumps({"sha": commit_sha, "force": True}))
print("PUSHED:", commit_sha)
