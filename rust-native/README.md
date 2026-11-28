# Voice Invoker 1.1.2-Rust

Экспериментальная Rust-ветка. JavaScript 1.1.1 остаётся в корне как эталон; main не меняется. Публикация релиза только после проверки реального микрофона и игры.

## Что перенесено

- Каталог 11 способностей, 143 фразы V2, 96 для штатной модели, 6 префиксов, 8 слотов предметов; парсер, профили задержек, планирование, очередь и split Invoke/GSI.
- Нативные Vosk DLL и CPAL/WASAPI, PTT, 250 мс preroll, защита от повторов, распознавание частичных и финальных результатов. Варианты 16/48 кГц или auto, блоки 256/512/1024/2048, эксперимент frames-per-chunk=3 на отдельной копии. Оригинальный архив V2 проверяется по неизменному SHA-256.
- Win32-хук с подтверждением новых биндов; scan-code исполнение и отпускание клавиш при отмене. Реальный ввод только с явным --live и фокусом Dota. Без --live — проверка распознавания, в том числе вне игры.
- GSI, обнаружение аккаунта и каталога Steam, мониторинг файла биндов без записи в Steam. Отдельная запись восстановления GSI; изменённые извне файлы не перезаписываются.
- Настройки и OBS через локальный HTTP/SSE; интерфейс настроек пока в браузере, нативный GDI-оверлей и трей в отдельном Win32-потоке. Браузер не захватывает звук и не выполняет распознавание.
- Настройки сохраняются в %APPDATA%/VoiceInvokerNative, исходные данные 1.1.1 только читаются. Установщик NSIS включает Rust EXE, DLL Vosk и V2. Нет зависимости от установленного Node, Electron, Python или PowerShell для работы приложения.

## Разработка и проверка

```powershell
cd rust-native
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo build --release
node scripts/parity.cjs
cargo run -- verify-model ../model/vosk-model-small-ru-invoker.tar.gz
cargo run -- extract-model ../model/vosk-model-small-ru-invoker.tar.gz model-extracted
cargo run -- parse "готовь торнадо метеор"
cargo run --release -- recognize-wav C:/trusted-vosk/libvosk.dll model-extracted/vosk-model-small-ru-0.22 sample.wav 512
cargo run --release -- microphone C:/trusted-vosk/libvosk.dll model-extracted/vosk-model-small-ru-0.22 15 512
```

WAV: моно PCM16. DLL должна быть из доверенного пакета Vosk вместе с зависимостями. Microphone — Windows. Можно добавить --rate=16000, --rate=48000 или --rate=auto; если устройство не поддерживает запрошенную частоту, используется системная. Программный ресемплинг и шумоподавление пока не реализованы.

`session DLL MODEL_DIR CONFIG 300` — тестовая сессия; добавление --live экспериментально включает ввод (testOnly имеет приоритет). Закройте 1.1.1 перед запуском. Ctrl+Shift+F8 — выход, Ctrl+Shift+F9 — настройки. Установленный EXE: `launch` — тест распознавания, `launch --live --dota` — экспериментальный игровой режим. `check-install` проверяет нативный движок и V2 без микрофона.

`init-config PATH_TO_1.1.1_CONFIG` — однократное копирование настроек. `inspect-steam STEAM_DIR [ACTIVE_ACCOUNT_ID]` — read-only диагностика. `gsi-install DOTA_DIR CONFIG`, `gsi-remove` — явная установка/восстановление. `watch-binds FILE 15`, `gsi-monitor 3055 15`, `hook-smoke`, `shell-smoke` — изолированные проверки.

## CI и ограничения

2091 дифференциальный сценарий выполняется относительно оригинальных JS-функций. Rust Anything 5.0.2 был запущен в отдельном CI-анализе; последующие запуски определяют последнюю npm-версию один раз и фиксируют её в отчёте. Это вспомогательный анализ, не автоматическая конвертация. Node/Python нужны только разработчику и CI.

CI проверяет настоящий Vosk 0.3.45 с оригинальной V2 на тишине 16/48 кГц, GSI, жизненный цикл Windows-хуков и окон; предусмотрена реальная установка, восстановление повреждённой модели и удаление с восстановлением GSI. Установщик доступен как артефакт только после успешного Windows CI.

Осталось подтвердить работу на Windows 10 с физическим микрофоном и Dota, точность фраз и задержки, визуальное соответствие и несколько мониторов, нативное окно настроек, зависимости и сравнительные показатели CPU/RAM. [Контракт миграции](MIGRATION.md).

Settings open in a separate WebView2 window (Wry/Tao); closing it releases that child process. If WebView2 is unavailable, the default browser is the fallback. No WebView is used for microphone, input, game overlay or recognition. Google Fonts requests removed for offline operation. Session capture uses deterministic software area-average conversion if the requested 16/48 kHz cannot be opened on the device; low-pass quality is basic, not a high-quality DSP resampler. The microphone CLI still reports the device rate. Overlay positioning uses the cursor or game monitor, including negative desktop coordinates. Physical tests remain necessary.

Optional RNNoise (`nnnoiseless` Rust implementation) runs on a separate DSP worker with bounded queues; disabled by default until the real microphone test. The capture callback remains limited to PCM conversion and enqueueing. Audio initialization/disconnect failures switch to diagnostics-only mode with no hook/input, allowing settings changes and restart. Dry-run results appear in diagnostics. The loop avoids cloning unchanged GSI state and slows idle polling.

Версия самостоятельного Rust-проекта — `1.1.2-Rust`, будущий тег `v1.1.2-Rust`, установщик `VoiceInvoker-Native-Setup-1.1.2-Rust.exe`. Публичный релиз пока не создан; CI-артефакты являются тестовыми сборками.
