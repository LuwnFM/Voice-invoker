# Migration contract (1.1.1 → native 2.0)

Baseline: `ff689524fa1d9a7ef3aa041fd408f38dc7c1e2c1`. The JavaScript source is the reference and remains runnable in this branch; main stays on 1.1.1 until the native program has feature and behavior parity.

Method: [Rust Anything](https://github.com/erkamyaman/rust-anything) uses analyze, record, diff, and gate per unit. The standalone Rust project already has a JSONL differential harness executing real reference functions. The external CLI is pinned in a separate read-only analysis workflow, not an installed runtime dependency. No auto-agent execution, generated NAPI bridge or automatic source replacement. The analyzer is advisory because desktop behavior cannot be validated by its CLI/server/library recorder alone.

| Unit | Status | Evidence required |
|---|---|---|
| Catalog, parser, recognition gate | Ported | 2091-case differential suite, including other pure units below |
| VK mapping, timing, sequences, VDF | Ported | Differential suite; more invalid config and GSI edge cases |
| Audio speech-session dedup and idle | Implemented | Regression tests; direct JS differential replay pending |
| GSI state machine | Partial | Real packet traces, prediction/timeout/refusal parity |
| Native Vosk | Smoke-tested on Windows and Linux | Original model hash, Windows DLL, real recorded utterances and latency |
| CPAL/WASAPI | Implemented, not device-tested | Real Windows 10 mic; PTT, disconnect, 16/48 kHz, preroll |
| Win32 hook | Observe-only | Lifecycle, focus, release and input acknowledgements; no active input yet |
| Steam synchronization | Partial | Atomic replacement, active account, live application, individual item quickcast |
| UI / tray / overlay / OBS | Pending | Visual parity, click-through and OBS compatibility |
| Persistence / diagnostics / installer | Partial | Atomic native settings and read-only Steam discovery implemented; full diagnostics, runtime integration and installer pending |

Decisions already established: Windows x64; original V2 SHA-256 unchanged; optional frame chunk experiment; no forced Steam writes or Blink feature; existing timings and phrases; keep settings HTML/CSS and OBS interface where possible, native game overlay. A change to behavior must be separate from a port and explicitly documented. No system Node is required for native production; only reference tests and migration tooling use Node.

Rust Anything 4.1.0 analysis completed on the development tree (24 units, 22 ready, main.js caution, test scripts blocked); scope is now pinned to the original 1.1.1 commit so the migration tests are not mistaken for application modules. No bridge or automatic cutover has been performed. For safety, native settings live in %APPDATA%/VoiceInvokerNative until the migration is validated. Legacy settings are read/copied only, unknown fields preserved. Steam selection remains conservative; malformed manifest paths are rejected rather than traversed.

Unified Windows session implemented: microphone capture, Vosk reset, 250 ms preroll, recognition session, GSI receiver, observe-only hook, acknowledged execution adapter. Dry run by default; --live is experimental and checks focus before sending input, releases held keys on cancellation. Not yet parity-tested on a real game or physical microphone. No key suppression or live rebinding yet. Latest rust-anything npm release resolved once per analysis run, logged and reused for that run.

Live hook integration: suppression of configured keys and matched hotkeys is armed only in experimental live mode, key-up tracking survives binding changes, snapshots include chat/enable/PTT, and new key maps are acknowledged on the hook thread. Steam registry discovery and event-based rebinding implemented; no writes to Steam. Scan-code input and paired SendInput restored. Windows CI and real-game tests required.

Explicit native GSI install/restore uses a separate recovery record, preserves externally modified files, and does not claim ownership of identical legacy GSI. Real input requires a focused process named dota2.exe as well as the configured title. Binding persistence is restricted to the exact native configuration file; legacy/explicit external configs remain read-only.

Settings and OBS HTTP/SSE adapters added using the original HTML/CSS and native audio state. Native settings save/restart, dictionary search, report, GSI repair and bindings import wired. Browser is temporary settings host; native game overlay/tray still pending. No browser-side capture or WASM runtime.

Native Win32 tray and overlay adapter implemented, with lifecycle smoke test. Settings currently open in default browser; native WebView2 settings window remains a possible separate host. The game overlay is now native rather than a Chromium renderer; exact visual parity and multi-monitor behavior are not yet verified.

Native NSIS packaging, installed-engine verification, single-instance guard, restart and installer upgrade/removal tests added. Installer is a branch artifact only, live shortcut is explicit. Remaining: real microphone/recognition benchmarking, actual Dota casts, native settings host, detailed overlay visual parity, dependency locking/audit and final end-to-end testing.
