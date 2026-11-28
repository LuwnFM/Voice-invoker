"""CI fixture only: download the pinned official Vosk wheel without installing Python bindings."""
import hashlib
import json
import pathlib
import subprocess
import sys
import urllib.request
import wave
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "native-smoke"
OUT.mkdir(exist_ok=True)
WINDOWS = sys.platform == "win32"
FILES = {
    True: ("vosk-0.3.45-py3-none-win_amd64.whl", "6994ddc68556c7e5730c3b6f6bad13320e3519b13ce3ed2aa25a86724e7c10ac"),
    False: ("vosk-0.3.45-py3-none-manylinux_2_12_x86_64.manylinux2010_x86_64.whl", "25e025093c4399d7278f543568ed8cc5460ac3a4bf48c23673ace1e25d26619f"),
}
filename, expected = FILES[WINDOWS]

def download(url, target, digest):
    req = urllib.request.Request(url, headers={"User-Agent": "VoiceInvoker-native-CI/2.0"})
    with urllib.request.urlopen(req, timeout=120) as response:
        data = response.read(100_000_001)
    if len(data) > 100_000_000 or hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError(f"Checksum failed: {target.name}")
    target.write_bytes(data)

with urllib.request.urlopen("https://pypi.org/pypi/vosk/0.3.45/json", timeout=30) as response:
    metadata = json.load(response)
url = next(item["url"] for item in metadata["urls"] if item["filename"] == filename)
wheel = OUT / filename
download(url, wheel, expected)
with zipfile.ZipFile(wheel) as archive:
    for name in archive.namelist():
        path = pathlib.PurePosixPath(name)
        if path.parts[0] == "vosk" and path.suffix in (".dll", ".so"):
            (OUT / path.name).write_bytes(archive.read(name))
dll = OUT / ("libvosk.dll" if WINDOWS else "libvosk.so")
assert dll.is_file()
manifest = json.loads((ROOT.parent / "model-manifest.json").read_text())
model = OUT / manifest["filename"]
download("https://github.com/LuwnFM/Voice-invoker/releases/download/v1.1.0-rc.6/" + manifest["filename"], model, manifest["sha256"])
exe = ROOT / "target/release" / ("voice-invoker-native.exe" if WINDOWS else "voice-invoker-native")
subprocess.run([str(exe), "verify-model", str(model)], check=True, timeout=30)
destination = OUT / "model"
subprocess.run([str(exe), "extract-model", str(model), str(destination)], check=True, timeout=90)
for rate in (16000, 48000):
    wav = OUT / f"silence-{rate}.wav"
    with wave.open(str(wav), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(rate)
        stream.writeframes(b"\x00\x00" * rate)
    result = subprocess.run([str(exe), "recognize-wav", str(dll), str(destination / "vosk-model-small-ru-0.22"), str(wav), "512"], check=True, timeout=90, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(result.stdout)
    assert "final:" in result.stdout, "No final recognition result"
    assert "=> []" in result.stdout and "Command {" not in result.stdout, "Silence produced a command"
print("PASS: verified original V2, actual native Vosk, dictionary and silent PCM at 16/48 kHz; no commands")
