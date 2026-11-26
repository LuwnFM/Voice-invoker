// Сообщения потоку хука (PostThreadMessageW)
module.exports = {
  WM_APP_VOICE_READY: 0x8003, // wParam: 1 — распознавание готово
  WM_APP_QUIT: 0x8005,
  WM_APP_TOGGLE: 0x8007,
  WM_APP_CAST: 0x8006,        // wParam: номер способности + 1, lParam: encoded action, profile and request ID (timing-profiles.js)
};
