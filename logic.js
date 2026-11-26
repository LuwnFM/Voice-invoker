// Логика голосового каста без привязки к WinAPI.
// Хук следит за клавишей голосового чата и блокирует клавиши из blockKeys. Кнопки мыши
// (MOUSE3..5) приходят сюда же как обычные клавиши — их передаёт хук мыши. По распознанной способности строится последовательность нажатий.
const { getTiming, normalizeProfile } = require('./timing-profiles');
const VK_ESC = 0x1b;
const VK_RETURN = 0x0d;
const VK_F7 = 0x76;
const VK_F8 = 0x77;
const VK_CTRL = [0x11, 0xa2, 0xa3];
const VK_SHIFT = [0x10, 0xa0, 0xa1];
const VK_ALT = [0x12, 0xa4, 0xa5];

// Что делать с распознанной способностью
// PREPARE — только собрать (сферы + Invoke); клавишу способности нажмём отдельно,
// когда Dota подтвердит, что способность появилась в слоте
const ACTION = { SLOT1: 1, SLOT2: 2, INVOKE: 3, PREPARE: 4 };

const VK_F9 = 0x78;
const VK_F10 = 0x79;
const VK_F11 = 0x7a;
const VK_F12 = 0x7b;

const NAMED_KEYS = {
  TAB: 0x09, SPACE: 0x20, CAPSLOCK: 0x14, BACKSPACE: 0x08,
  INSERT: 0x2d, DELETE: 0x2e, HOME: 0x24, END: 0x23, PAGEUP: 0x21, PAGEDOWN: 0x22,
  UP: 0x26, DOWN: 0x28, LEFT: 0x25, RIGHT: 0x27,
  '`': 0xc0, '-': 0xbd, '=': 0xbb, '[': 0xdb, ']': 0xdd, '\\': 0xdc,
  ';': 0xba, "'": 0xde, ',': 0xbc, '.': 0xbe, '/': 0xbf,
  // Кнопки мыши: колёсико и две боковые
  MOUSE3: 0x04, MOUSE4: 0x05, MOUSE5: 0x06,
  'NUM*': 0x6a, 'NUM+': 0x6b, 'NUM-': 0x6d, 'NUM.': 0x6e, 'NUM/': 0x6f,
};
// Буква, цифра, F1..F24, NUM0..NUM9, MOUSE3..MOUSE5 или имя из NAMED_KEYS -> код клавиши Windows (0 — не задана)
function vkOf(key) {
  const k = String(key || '').toUpperCase().trim();
  if (!k) return 0;
  const f = /^F(\d{1,2})$/.exec(k);
  if (f && f[1] >= 1 && f[1] <= 24) return 0x70 + Number(f[1]) - 1;
  const n = /^NUM(\d)$/.exec(k);
  if (n) return 0x60 + Number(n[1]);
  if (/^[A-Z0-9]$/.test(k)) return k.charCodeAt(0);
  return NAMED_KEYS[k] || 0;
}

function createVoiceCast(config, { isGameActive, emit, quit, openSettings = () => {} }) {
  const orbKey = { Q: config.keys.quas, W: config.keys.wex, E: config.keys.exort };
  const talkVk = vkOf(config.voiceChatKey);
  const always = config.listen === 'always' || !talkVk;
  // config.blockKeys — имена из config.keys, например ["invoke"] или ["invoke", "slot1", "slot2"]
  const blockedVk = new Set((config.blockKeys || []).map((name) => vkOf(config.keys[name])).filter(Boolean));

  const s = {
    enabled: true,
    timingProfile: normalizeProfile(config.timingProfile),
    voiceReady: false,  // модель и микрофон готовы
    listening: always,  // сейчас слушаем микрофон
    chat: false,        // открыт чат Dota (Enter переключает)
    talkKey: always ? '' : String(config.voiceChatKey).toUpperCase(),
  };
  const down = new Set();
  const swallowed = new Set();

  const send = (event) => emit({ state: { ...s }, event: event || null });
  const swallow = (vk) => (swallowed.add(vk), true);
  const held = (list) => list.some((vk) => down.has(vk));

  function setListening(on) {
    if (always || s.listening === on) return;
    s.listening = on;
    send(on ? 'listen' : 'unlisten');
  }

  function setVoiceReady(ready) {
    s.voiceReady = ready;
    send('voice');
  }

  // Возвращает true, если клавишу нужно заблокировать (не пускать в Dota)
  function handleKey(vk, isDown) {
    if (!isDown) {
      down.delete(vk);
      if (vk === talkVk) setListening(false);
      return swallowed.delete(vk);
    }
    const repeat = down.has(vk);
    down.add(vk);

    if (held(VK_CTRL) && held(VK_SHIFT) && ([VK_F7, VK_F8, VK_F9, VK_F10, VK_F11, VK_F12].includes(vk))) {
      if (repeat) return swallow(vk);
      if (vk === VK_F8) {
        quit();
        return swallow(vk);
      }
      if (vk === VK_F9) {
        openSettings();
        return swallow(vk);
      }
      if (vk === VK_F10 || vk === VK_F11 || vk === VK_F12) {
        s.timingProfile = vk === VK_F12 ? 'turbo' : vk === VK_F11 ? 'fast' : 'normal';
        s.enabled = true;
        send('profile');
        return swallow(vk);
      }
      s.enabled = !s.enabled;
      s.chat = false;
      if (!always) s.listening = false;
      send('toggle');
      return swallow(vk);
    }
    // Автоповтор уже заблокированной клавиши тоже не пропускаем
    if (repeat && swallowed.has(vk)) return true;
    if (!s.enabled || repeat || !isGameActive()) return false;

    // Чат: пока он открыт, буквы — это текст, а не голосовой чат
    if (vk === VK_RETURN) s.chat = !s.chat;
    else if (vk === VK_ESC) s.chat = false;
    // Ctrl+клавиша в Dota — прокачка способности, её не трогаем
    if (s.chat || held(VK_CTRL) || held(VK_ALT)) return false;

    if (vk === talkVk) setListening(true);
    // Клавиши, которые игроку нажимать нельзя: способности применяются только голосом.
    // Нажатия самого плагина сюда не попадают (хук пропускает их по метке).
    if (blockedVk.has(vk)) {
      send('blocked');
      return swallow(vk);
    }
    return false;
  }

  // Последовательность шагов для каста. Шаг: { type: 'key' | 'click', vk, wait },
  // wait — пауза в мс перед шагом.
  function buildSequence(spell, action, profile = s.timingProfile) {
    const timing = getTiming(config, profile);
    const steps = [];
    const key = (k, wait) => steps.push({ type: 'key', vk: vkOf(k), wait });
    const gap = timing.keyDelayMs;

    let slot = config.keys.slot1; // новая способность всегда встаёт в первый слот
    let wait = 0;
    if (action === ACTION.INVOKE || action === ACTION.PREPARE) {
      [...spell.combo].forEach((c, i) => key(orbKey[c], i ? gap : 0));
      key(config.keys.invoke, gap);
      if (action === ACTION.PREPARE) return steps;
      wait = timing.castDelayMs;
    } else if (action === ACTION.SLOT2) {
      slot = config.keys.slot2;
    }
    if (spell.selfCast) {
      // Каст на себя (Cataclysm): Alt зажимается отдельным шагом, чтобы Dota успела его
      // увидеть до клавиши способности
      steps.push({ type: 'down', vk: VK_ALT[1], wait });
      key(slot, timing.altDelayMs);
      steps.push({ type: 'up', vk: VK_ALT[1], wait: timing.altDelayMs });
    } else key(slot, wait);
    if (config.castMode === 'click' && spell.target) steps.push({ type: 'click', wait: timing.clickDelayMs });

    return steps;
  }

  return { handleKey, setVoiceReady, buildSequence, state: s, send };
}

module.exports = { createVoiceCast, vkOf, ACTION };
