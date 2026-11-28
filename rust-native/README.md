# Voice Invoker native 2.0 — alpha.1

Экспериментальный перенос с 1.1.1. Старое приложение остаётся в корне репозитория как проверяемый эталон. Эта ветка не публикует релизы и не посылает игровые нажатия.

- Rust-каталог извлечён из исходников 1.1.1: 11 способностей, 143 фразы V2, 96 для штатной модели, 6 префиксов, 8 слотов предметов.
- Перенесены чистые функции парсера, проверки фраз и клавиш, профили задержек, планирование шагов и начальная очередь с подтверждением. Добавлен отдельный автомат split Invoke/GSI с подтверждением, тайм-аутом, отменой при потере готовности микрофона и фиксацией профиля; пока не связан с реальным вводом.
- Нативный Vosk через локальную DLL и CPAL/WASAPI. CLI для WAV и теста микрофона; никаких нажатий. Встроенный Node/Electron не нужен для CLI.
- Проверка исходного архива V2 по прежнему манифесту и распаковка в новую папку. Чтение словаря FST; модель не меняется.
- Перенесён read-only VDF-парсер и валидация импортированных биндов. Добавлены локальный HTTP GSI-приёмник и наблюдающий Win32-хук клавиатуры/мыши с собственным циклом сообщений. Пока отсутствуют связка хука с исполнением, автоматическое определение аккаунта Steam и применение обновлений к рабочему хуку, трей, окно настроек, нативный оверлей, OBS, полноценная миграция и установщик. Нет принудительного программного ресемплинга, шумоподавления и измеренного сравнения с Electron. Выбор 16/48 кГц запрашивает поддерживаемую конфигурацию устройства, иначе явно возвращается к системной частоте.

## Разработка

```powershell
cd rust-native
cargo test
cargo run -- verify-model ../model/vosk-model-small-ru-invoker.tar.gz
cargo run -- extract-model ../model/vosk-model-small-ru-invoker.tar.gz model-extracted
cargo run -- parse "готовь торнадо метеор"
cargo run --release -- recognize-wav C:/trusted-vosk/libvosk.dll model-extracted/vosk-model-small-ru-0.22 sample.wav 512
cargo run --release -- microphone C:/trusted-vosk/libvosk.dll model-extracted/vosk-model-small-ru-0.22 15 512
```

WAV: моно PCM16. DLL должна быть из доверенного пакета Vosk вместе с её зависимостями. Команда microphone только Windows. Устройство по умолчанию или имя устройства последним аргументом. Используется фактическая частота устройства. Лог выводит гипотезы и совпадения, но не отправляет их в игру. Пользовательские настройки 1.1.1 читаются только при явном указании файла для WAV, не перезаписываются.

## Следующие этапы

1. Проверить Rust CI, настоящую V2 с нативным Vosk и воспроизводимые записи голоса.
2. Перенести полный автомат GSI, очередь с подтверждением, нативный поток ввода Win32 с безопасным завершением.
3. Синхронизация биндов, Quickcast предметов, диагностика, сохранение настроек.
4. Нативный трей и оверлей, отдельное окно настроек, OBS.
5. Сравнить потребление CPU/RAM и задержки с 1.1.1 на одинаковых записях. Установщик и ручная проверка Windows 10 до выпуска.

CI загружает официальный пакет Vosk 0.3.45 для Windows/Linux x64 (SHA-256 из PyPI), извлекает DLL/SO без установки Python-биндингов, проверяет оригинальную V2 и запускает нативный распознаватель на PCM тишине 16/48 кГц. Это smoke-test движка, не измерение точности речи.

Дополнительные команды: `cargo run -- gsi-monitor 3055 15` — локальный GSI-монитор (без игровых действий); `cargo run -- hook-smoke` — три цикла установки и удаления нативных Windows-хуков в режиме наблюдения, без блокировки клавиш. CI проверяет HTTP-авторизацию, origin, размер запроса, реальный пакет и жизненный цикл хука.

`extract-model ARCHIVE NEW_DIR --frames-per-chunk=3` создаёт только экспериментальную распакованную копию. `microphone ... --rate=16000` / `--rate=48000` / `--rate=auto` позволяет сравнивать режимы. `watch-binds FILE 15` использует уведомления ОС о родительской папке и читает бинды без записи в Steam. Ветка пока не посылает игровые нажатия.

## Проверка миграции по эталонному поведению

`node scripts/parity.cjs` после `cargo build --release` записывает реальные ответы оригинальных функций JavaScript и прогоняет те же входы через Rust JSONL-адаптер. Проверяются точные результаты всех 143 фраз, префиксов, промежуточных гипотез, кодов клавиш, всех комбинаций способностей и профилей скорости, VDF. Это подход record/replay, аналогичный rust-anything, без зависимости от стороннего инструмента. Сам rust-anything пока не установлен и не запускался. Нативный ввод, аудиоустройства, GUI и GSI требуют отдельных интеграционных проверок. Node используется исключительно в CI для эталона, не в Rust-приложении.

[Migration contract and progress](MIGRATION.md). The external rust-anything CLI analysis runs separately in GitHub Actions using a pinned npm version; the existing differential test is the actual mandatory behavior gate. Speech-session state now deduplicates partial/final hypotheses, enforces 2500 ms repeat protection and 1200 ms idle termination, and does not commit tentative preparation commands at release. The microphone CLI is still test-only and does not implement full PTT capture.

`init-config PATH_TO_1.1.1_CONFIG` explicitly copies preferences into `%APPDATA%/VoiceInvokerNative` once. The original remains untouched. `inspect-steam STEAM_DIR [ACTIVE_ACCOUNT_ID]` reports read-only discovery/binding readiness without exposing paths or tokens. These helpers are not yet connected to a full native desktop session.

Unified Windows session: `cargo run --release -- session DLL MODEL_DIR CONFIG 300` (dry run; PTT in Dota or testOnly/always). `--live` explicitly enables experimental input, disabled by testOnly. No key suppression or live binding reload yet; close 1.1.1 before running to avoid port conflicts. Ctrl+Shift+F8 exits. Physical microphone and Dota behavior have not been verified. This is not a replacement release.
