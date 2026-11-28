"""Build the native-only alpha installer from the already verified CI inputs."""
import hashlib
import pathlib
import shutil
import struct
import subprocess
import os
import json

root = pathlib.Path(__file__).resolve().parents[1]
out = root / "build-output"
stage = out / "stage"
if stage.exists():
    shutil.rmtree(stage)
(stage / "runtime").mkdir(parents=True)
(stage / "model").mkdir()
manifest = json.loads((root.parent / "model-manifest.json").read_text())
source = root / "native-smoke"
archive = source / manifest["filename"]
assert archive.stat().st_size == manifest["size"]
assert hashlib.sha256(archive.read_bytes()).hexdigest() == manifest["sha256"]
shutil.copy2(archive, stage / "model")
for dll in source.glob("*.dll"):
    shutil.copy2(dll, stage / "runtime")
assert (stage / "runtime/libvosk.dll").is_file()
shutil.copy2(root / "target/release/voice-invoker-native.exe", stage)
shutil.copy2(root / "README.md", stage)
png = (root.parent / "icon.png").read_bytes()
width, height = struct.unpack(">II", png[16:24])
assert 0 < width <= 256 and 0 < height <= 256
ico = out / "icon.ico"
ico.write_bytes(struct.pack("<HHHBBBBHHII", 0, 1, 1, width % 256, height % 256, 0, 0, 1, 32, len(png), 22) + png)
remove = out / "remove.nsh"
lines = []
for path in stage.rglob("*"):
    if path.is_file():
        lines.append('Delete "$INSTDIR\\' + str(path.relative_to(stage)).replace("$", "$$") + '"')
for directory in sorted((p for p in stage.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
    lines.append('RMDir "$INSTDIR\\' + str(directory.relative_to(stage)).replace("$", "$$") + '"')
remove.write_text("\n".join(lines)+"\n", encoding="utf-8")
version = "2.0.0-alpha.1"
exe = out / f"VoiceInvoker-Native-Setup-{version}.exe"
nsis = pathlib.Path(os.environ["ProgramFiles(x86)"]) / "NSIS/makensis.exe"
subprocess.run([str(nsis), f"/DVERSION={version}", f"/DSTAGE={stage}", f"/DOUTFILE={exe}", f"/DREMOVEFILES={remove}", f"/DICONFILE={ico}", str(root/"installer.nsi")], check=True, timeout=300)
digest = hashlib.sha256(exe.read_bytes()).hexdigest()
(out/"SHA256SUMS.txt").write_text(f"{digest}  {exe.name}\n",encoding="ascii")
print(f"Built {exe.name}, {exe.stat().st_size:,} bytes")
