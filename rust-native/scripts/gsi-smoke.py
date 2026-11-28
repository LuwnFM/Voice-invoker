import json
import pathlib
import subprocess
import sys
import urllib.request
import urllib.error

root = pathlib.Path(__file__).resolve().parents[1]
exe = root / "target/release" / ("voice-invoker-native.exe" if sys.platform == "win32" else "voice-invoker-native")
p = subprocess.Popen([str(exe), "gsi-monitor", "0", "15"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    line = p.stdout.readline()
    assert line.startswith("GSI monitor http://127.0.0.1:"), line
    base = line.strip().split()[-1]
    packet = {"auth": {"token": "wrong"}, "hero": {"name": "npc_dota_hero_invoker", "alive": True}}
    def post(data, origin=None):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        request = urllib.request.Request(base + "/gsi", data=json.dumps(data).encode(), headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code
    assert post(packet) == 401
    packet["auth"]["token"] = "voice_invoke"
    assert post(packet, "https://example.invalid") == 403
    assert post(packet) == 204
    with urllib.request.urlopen(base + "/status", timeout=5) as response:
        status = json.load(response)
    assert status["hero"] == "npc_dota_hero_invoker" and status["alive"]
    assert post({"padding": "x" * (300 * 1024)}) == 413
    print("PASS: loopback HTTP GSI, authentication, origin checks, size limit and actual packet")
finally:
    p.terminate()
    p.communicate(timeout=10)
