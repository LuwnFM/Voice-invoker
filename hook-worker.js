// Отдельный поток с глобальным хуком клавиатуры Windows (WH_KEYBOARD_LL).
// Поток крутит цикл сообщений GetMessageW, а хук вызывается внутри него.
// Главный процесс присылает сюда команды каста через PostThreadMessageW,
// поток выполняет их как последовательность нажатий с паузами (таймер WM_TIMER).
const { parentPort, workerData } = require('worker_threads');
const koffi = require('koffi');
const SPELLS = [...require('./spells'), ...require('./items').ITEM_SLOTS];
const { createVoiceCast } = require('./logic');
const { decodeCast } = require('./timing-profiles');
const { WM_APP_VOICE_READY, WM_APP_QUIT, WM_APP_CAST, WM_APP_TOGGLE } = require('./messages');

const config = workerData.config;
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const KBDLLHOOKSTRUCT = koffi.struct('KBDLLHOOKSTRUCT', {
  vkCode: 'uint32',
  scanCode: 'uint32',
  flags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
const MSLLHOOKSTRUCT = koffi.struct('MSLLHOOKSTRUCT', {
  x: 'int32',
  y: 'int32',
  mouseData: 'uint32',
  flags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
const HookProc = koffi.proto('intptr_t __stdcall HookProc(int nCode, uintptr_t wParam, void *lParam)');

const SetWindowsHookExW = user32.func('void * __stdcall SetWindowsHookExW(int idHook, HookProc *lpfn, void *hmod, uint32 dwThreadId)');
const UnhookWindowsHookEx = user32.func('bool __stdcall UnhookWindowsHookEx(void *hhk)');
const CallNextHookEx = user32.func('intptr_t __stdcall CallNextHookEx(void *hhk, int nCode, uintptr_t wParam, void *lParam)');
const GetMessageW = user32.func('int __stdcall GetMessageW(void *lpMsg, void *hWnd, uint32 wMsgFilterMin, uint32 wMsgFilterMax)');
const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, void *lpString, int nMaxCount)');
const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(void *lpModuleName)');
const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()');
const PostThreadMessageW = user32.func('bool __stdcall PostThreadMessageW(uint32 idThread, uint32 Msg, uintptr_t wParam, intptr_t lParam)');
const MapVirtualKeyW = user32.func('uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)');
const SetTimer = user32.func('uintptr_t __stdcall SetTimer(void *hWnd, uintptr_t nIDEvent, uint32 uElapse, void *lpTimerFunc)');
const KillTimer = user32.func('bool __stdcall KillTimer(void *hWnd, uintptr_t uIDEvent)');

// INPUT = type + union { MOUSEINPUT (32 байта), KEYBDINPUT (24 байта), HARDWAREINPUT }
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32',
  dy: 'int32',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
const KEY_INPUT = koffi.struct('KEY_INPUT', { type: 'uint32', ki: KEYBDINPUT, _pad: koffi.array('uint8', 8) });
const MOUSE_INPUT = koffi.struct('MOUSE_INPUT', { type: 'uint32', mi: MOUSEINPUT });
const SendKeyInput = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(KEY_INPUT), 'int']);
const SendMouseInput = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(MOUSE_INPUT), 'int']);

const WH_KEYBOARD_LL = 13;
const WH_MOUSE_LL = 14;
const WM_MBUTTONDOWN = 0x207;
const WM_MBUTTONUP = 0x208;
const WM_XBUTTONDOWN = 0x20b;
const WM_XBUTTONUP = 0x20c;
const LLMHF_INJECTED = 0x1;
const WM_KEYDOWN = 0x100;
const WM_SYSKEYDOWN = 0x104;
const WM_TIMER = 0x113;
const LLKHF_INJECTED = 0x10;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x2;
const KEYEVENTF_SCANCODE = 0x8;
const MOUSEEVENTF_LEFTDOWN = 0x2;
const MOUSEEVENTF_LEFTUP = 0x4;
const MOUSEEVENTF_MIDDLEDOWN = 0x20;
const MOUSEEVENTF_MIDDLEUP = 0x40;
const MOUSEEVENTF_XDOWN = 0x80;
const MOUSEEVENTF_XUP = 0x100;
// Кнопки мыши как «клавиши» (коды из logic.js): колёсико, боковые 4 и 5
const VK_MBUTTON = 0x04;
const VK_XBUTTON1 = 0x05;
const VK_XBUTTON2 = 0x06;
const isMouseVk = (vk) => vk === VK_MBUTTON || vk === VK_XBUTTON1 || vk === VK_XBUTTON2;
// Метка наших собственных нажатий — хук их всегда пропускает
const OWN_INPUT_TAG = 0x564f4943;

// Программные нажатия (клавиши — со скан-кодом, так их видят игры)
function keyInput(vk, up) {
  return {
    type: INPUT_KEYBOARD,
    ki: { wVk: vk, wScan: MapVirtualKeyW(vk, 0), dwFlags: KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0), time: 0, dwExtraInfo: OWN_INPUT_TAG },
    _pad: [0, 0, 0, 0, 0, 0, 0, 0],
  };
}
const mouseInput = (flags, data = 0) => ({
  type: INPUT_MOUSE,
  mi: { dx: 0, dy: 0, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: OWN_INPUT_TAG },
});
// Нажатие или отпускание кнопки мыши, назначенной вместо клавиши
function mouseButtonInput(vk, up) {
  if (vk === VK_MBUTTON) return mouseInput(up ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_MIDDLEDOWN);
  return mouseInput(up ? MOUSEEVENTF_XUP : MOUSEEVENTF_XDOWN, vk === VK_XBUTTON1 ? 1 : 2);
}
const pressKey = (vk) =>
  isMouseVk(vk)
    ? SendMouseInput(2, [mouseButtonInput(vk, false), mouseButtonInput(vk, true)], koffi.sizeof(MOUSE_INPUT))
    : SendKeyInput(2, [keyInput(vk, false), keyInput(vk, true)], koffi.sizeof(KEY_INPUT));
// Только нажать или только отпустить (Alt для каста на себя)
const keyEdge = (vk, up) =>
  isMouseVk(vk)
    ? SendMouseInput(1, [mouseButtonInput(vk, up)], koffi.sizeof(MOUSE_INPUT))
    : SendKeyInput(1, [keyInput(vk, up)], koffi.sizeof(KEY_INPUT));
const leftClick = () =>
  SendMouseInput(2, [mouseInput(MOUSEEVENTF_LEFTDOWN), mouseInput(MOUSEEVENTF_LEFTUP)], koffi.sizeof(MOUSE_INPUT));

const threadId = GetCurrentThreadId();
const titleBuf = Buffer.alloc(512);
function isGameActive() {
  if (!config.windowTitle) return true;
  const hwnd = GetForegroundWindow();
  if (!hwnd) return false;
  const n = GetWindowTextW(hwnd, titleBuf, 256);
  return titleBuf.toString('utf16le', 0, n * 2) === config.windowTitle;
}

const voice = createVoiceCast(config, {
  isGameActive,
  emit: (msg) => parentPort.postMessage({ type: 'state', ...msg }),
  quit: () => parentPort.postMessage({ type: 'quit-request' }),
  openSettings: () => parentPort.postMessage({ type: 'settings' }),
});

// ---------- Выполнение последовательности нажатий ----------
let seq = null;
let seqIdx = 0;
let seqTimer = 0;
let request = null;
let altHeld = false;

function finishSequence(ok, reason = '') {
  if (seqTimer) { KillTimer(null, seqTimer); seqTimer = 0; }
  if (altHeld) { keyEdge(0xa4, true); altHeld = false; }
  const done = request;
  seq = null;
  request = null;
  if (done) parentPort.postMessage({ type: 'cast-complete', id: done.id, ok, reason, profile: done.profile, elapsedMs: Number(process.hrtime.bigint() - done.started) / 1e6 });
}

function runSequence() {
  while (seq && seqIdx < seq.length) {
    if (!voice.state.enabled) return finishSequence(false, 'Voice casting disabled');
    if (!isGameActive()) return finishSequence(false, 'Dota lost focus');
    const step = seq[seqIdx];
    if (step.wait > 0 && !step.waited) {
      step.waited = true;
      seqTimer = SetTimer(null, 0, step.wait, null);
      if (!seqTimer) finishSequence(false, 'SetTimer failed');
      return;
    }
    if (config.debugSteps) parentPort.postMessage({ type: 'step', step: step.type === 'click' ? 'click' : step.vk, edge: step.type, elapsedMs: Number(process.hrtime.bigint() - request.started) / 1e6 });
    let count;
    if (step.type === 'click') count = leftClick();
    else if (step.type === 'down' || step.type === 'up') {
      count = keyEdge(step.vk, step.type === 'up');
      if (count === 1 && step.vk === 0xa4) altHeld = step.type === 'down';
    } else count = pressKey(step.vk);
    if (count !== (step.type === 'down' || step.type === 'up' ? 1 : 2)) {
      // A partial down/up pair must not leave a key held.
      if (count === 1 && step.type === 'key') keyEdge(step.vk, true);
      if (count === 1 && step.type === 'click') SendMouseInput(1, [mouseInput(MOUSEEVENTF_LEFTUP)], koffi.sizeof(MOUSE_INPUT));
      return finishSequence(false, 'SendInput failed');
    }
    seqIdx++;
  }
  finishSequence(true);
}

function startCast(spell, encoded) {
  const command = decodeCast(encoded);
  if (!spell || !voice.state.enabled || !isGameActive() || seq) {
    parentPort.postMessage({ type: 'cast-complete', id: command.id, ok: false, reason: 'Cast not accepted', profile: command.profile, elapsedMs: 0 });
    return;
  }
  request = { ...command, started: process.hrtime.bigint() };
  seq = voice.buildSequence(spell, command.action, command.profile);
  seqIdx = 0;
  runSequence();
}

function proc(nCode, wParam, lParam) {
  try {
    if (nCode === 0) {
      const k = koffi.decode(lParam, KBDLLHOOKSTRUCT);
      const own = Number(k.dwExtraInfo) === OWN_INPUT_TAG;
      if (!own && (config.acceptInjected || !(k.flags & LLKHF_INJECTED))) {
        const w = Number(wParam);
        const isDown = w === WM_KEYDOWN || w === WM_SYSKEYDOWN;
        if (voice.handleKey(k.vkCode, isDown)) return 1;
      }
    }
  } catch (e) {
    parentPort.postMessage({ type: 'log', text: 'Ошибка хука: ' + e.stack });
  }
  return CallNextHookEx(null, nCode, wParam, lParam);
}

// Хук мыши: колёсико и боковые кнопки идут в ту же логику, что и клавиши
// (голосовой чат или Invoke могут стоять на кнопке мыши). Остальные события не трогаем.
function mouseProc(nCode, wParam, lParam) {
  try {
    const w = Number(wParam);
    if (nCode === 0 && (w === WM_MBUTTONDOWN || w === WM_MBUTTONUP || w === WM_XBUTTONDOWN || w === WM_XBUTTONUP)) {
      const m = koffi.decode(lParam, MSLLHOOKSTRUCT);
      const own = Number(m.dwExtraInfo) === OWN_INPUT_TAG;
      if (!own && (config.acceptInjected || !(m.flags & LLMHF_INJECTED))) {
        const isDown = w === WM_MBUTTONDOWN || w === WM_XBUTTONDOWN;
        let vk = VK_MBUTTON;
        if (w === WM_XBUTTONDOWN || w === WM_XBUTTONUP) vk = m.mouseData >>> 16 === 1 ? VK_XBUTTON1 : VK_XBUTTON2;
        if (voice.handleKey(vk, isDown)) return 1;
      }
    }
  } catch (e) {
    parentPort.postMessage({ type: 'log', text: 'Ошибка хука мыши: ' + e.stack });
  }
  return CallNextHookEx(null, nCode, wParam, lParam);
}

// Release callbacks only after Windows has stopped using them. Never terminate
// this worker while a registered callback can still be invoked.
let callback, mouseCallback, hook, mouseHook;
try {
  callback = koffi.register(proc, koffi.pointer(HookProc));
  hook = SetWindowsHookExW(WH_KEYBOARD_LL, callback, GetModuleHandleW(null), 0);
  if (!hook) throw new Error('Не удалось установить хук клавиатуры');
  mouseCallback = koffi.register(mouseProc, koffi.pointer(HookProc));
  mouseHook = SetWindowsHookExW(WH_MOUSE_LL, mouseCallback, GetModuleHandleW(null), 0);
  if (!mouseHook) parentPort.postMessage({ type: 'log', text: 'Не удалось установить хук мыши — кнопки мыши работать не будут' });
  parentPort.postMessage({ type: 'ready', threadId });
  voice.send('ready');
  const msg = Buffer.alloc(64);
  while (GetMessageW(msg, null, 0, 0) > 0) {
    const type = msg.readUInt32LE(8);
    const wParam = Number(msg.readBigUInt64LE(16));
    const lParam = Number(msg.readBigInt64LE(24));
    if (type === WM_APP_QUIT) break;
    try {
      if (type === WM_APP_CAST) {
        startCast(SPELLS[wParam - 1], lParam);
      } else if (type === WM_TIMER && wParam === seqTimer) {
        KillTimer(null, seqTimer);
        seqTimer = 0;
        runSequence();
      } else if (type === WM_APP_TOGGLE) {
        voice.toggle();
        if(!voice.state.enabled&&seq)finishSequence(false,'Voice casting disabled');
      } else if (type === WM_APP_VOICE_READY) {
        voice.setVoiceReady(wParam === 1);
      }
    } catch (e) {
      finishSequence(false, e.message);
      parentPort.postMessage({ type: 'log', text: 'Ошибка потока хука: ' + e.stack });
    }
  }
} finally {
  try { finishSequence(false, 'Application quit'); }
  finally {
    const mouseReleased = !mouseHook || UnhookWindowsHookEx(mouseHook);
    const keyboardReleased = !hook || UnhookWindowsHookEx(hook);
    if (mouseCallback && mouseReleased) koffi.unregister(mouseCallback);
    if (callback && keyboardReleased) koffi.unregister(callback);
    parentPort.postMessage({ type: 'stopped', clean: mouseReleased && keyboardReleased });
    parentPort.close();
  }
}
