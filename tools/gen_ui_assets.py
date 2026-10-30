import os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # keyclicker-rs
ui = os.path.join(root, "ui")
out = os.path.join(root, "src", "ui_assets.rs")
exts = {".html", ".css", ".js", ".svg", ".png", ".ico"}
files = []
for dirpath, _dirs, names in os.walk(ui):
    for n in names:
        if os.path.splitext(n)[1].lower() in exts:
            full = os.path.join(dirpath, n)
            rel = os.path.relpath(full, ui).replace("\\", "/")
            files.append((rel, full))
files.sort()
lines = ["// 自动生成：内嵌 UI 资源（勿手改）", "pub static FILES: &[(&str, &[u8])] = &["]
for rel, full in files:
    inc = os.path.relpath(full, os.path.join(root, "src")).replace("\\", "/")
    lines.append('    ("%s", include_bytes!("%s")),' % (rel, inc))
lines.append("];")
lines.append("")
open(out, "w", encoding="utf-8").write("\n".join(lines))
print("generated", out, "with", len(files), "files")
