# Migration contract (1.1.1 → native 2.0)

Baseline: `ff689524fa1d9a7ef3aa041fd408f38dc7c1e2c1`. The JavaScript source is the reference and remains runnable in this branch; main stays on 1.1.1 until the native program has feature and behavior parity.

Method: [Rust Anything](https://github.com/erkamyaman/rust-anything) uses analyze, record, diff, and gate per unit. The standalone Rust project already has a JSONL differential harness executing real reference functions. The external CLI is pinned in a separate read-only analysis workflow, not an installed runtime dependency. No auto-agent execution, generated NAPI bridge or automatic source replacement. The analyzer is advisory because desktop behavior cannot be validated by its CLI/server/library recorder alone.

| Unit | Status | Evidence required |
|---|---|---|
| Catalog, parser, recognition gate | Ported | 2091-case differential suite, including other pure units below |
| VK mapping, timing, sequences, VDF | Ported | Differential suite; more invalid config and GSI edge cases |
| Audio speech-session dedup and idle | Implemented | Regression tests; direct JS differential replay pending |
| GSI state machine | Partial | Real packet traces, prediction/timeout/refusal parity |
| Native Vosk | Smoke-tested on Linux | Original model hash, Windows DLL, real recorded utterances and latency |
| CPAL/WASAPI | Implemented, not device-tested | Real Windows 10 mic; PTT, disconnect, 16/48 kHz, preroll |
| Win32 hook | Observe-only | Lifecycle, focus, release and input acknowledgements; no active input yet |
| Steam synchronization | Partial | Atomic replacement, active account, live application, individual item quickcast |
| UI / tray / overlay / OBS | Pending | Visual parity, click-through and OBS compatibility |
| Persistence / diagnostics / installer | Pending | Preserve 1.1.1 config; standalone signed/unsigned status; safe GSI install/restore |

Decisions already established: Windows x64; original V2 SHA-256 unchanged; optional frame chunk experiment; no forced Steam writes or Blink feature; existing timings and phrases; keep settings HTML/CSS and OBS interface where possible, native game overlay. A change to behavior must be separate from a port and explicitly documented. No system Node is required for native production; only reference tests and migration tooling use Node.
