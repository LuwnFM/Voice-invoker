"""Exercise the actual installer in an isolated profile, without audio hardware or game input."""
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile

root=pathlib.Path(__file__).resolve().parents[1]
out=root/"build-output"
installer=next(out.glob("VoiceInvoker-Native-Setup-*.exe"))
manifest=json.loads((root.parent/"model-manifest.json").read_text())
with tempfile.TemporaryDirectory(prefix="vi-native-installer-") as tmp:
    base=pathlib.Path(tmp)
    dest=base/"Installed Native"
    env=os.environ.copy()
    env["APPDATA"]=str(base/"AppData")
    env["LOCALAPPDATA"]=str(base/"Local")
    env["PATH"]=os.pathsep.join([str(pathlib.Path(os.environ["SystemRoot"])/"System32"),os.environ["SystemRoot"]])
    def run(*args):
        subprocess.run([str(x) for x in args],check=True,env=env,timeout=180)
    run(installer,"/S",f"/D={dest}")
    exe=dest/"voice-invoker-native.exe"
    run(exe,"check-install")
    legacy=base/"legacy.json"
    legacy.write_text(json.dumps({"voiceChatKey":"T","custom":{"keep":42}}),encoding="utf-8")
    run(exe,"init-config",legacy)
    config=base/"AppData/VoiceInvokerNative/config.json"
    saved=config.read_bytes()
    model=dest/"model"/manifest["filename"]
    model.write_bytes(b"damaged fixture")
    run(installer,"/S",f"/D={dest}")
    assert config.read_bytes()==saved
    assert hashlib.sha256(model.read_bytes()).hexdigest()==manifest["sha256"]
    dota=base/"Dota"
    game=dota/"game/bin/win64"
    game.mkdir(parents=True)
    (game/"dota2.exe").write_bytes(b"fixture")
    cfg=dota/"game/dota/cfg/gamestate_integration/gamestate_integration_voice_invoke.cfg"
    cfg.parent.mkdir(parents=True)
    cfg.write_bytes(b"old integration")
    run(exe,"gsi-install",dota,config)
    assert cfg.read_bytes()!=b"old integration"
    # NSIS uninstall runs from a temporary copy; _?= keeps it synchronous.
    run(dest/"Uninstall.exe","/S",f"_?={dest}")
    assert cfg.read_bytes()==b"old integration"
    assert config.read_bytes()==saved
    assert not exe.exists()
print("PASS: native installer, no system Node on PATH, model repair, migration and GSI restore")
