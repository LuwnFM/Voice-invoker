// Голосовой каст Инвокера: говоришь название способности — она собирается и применяется.
// Хук клавиатуры и нажатия — в отдельном потоке (hook-worker.js), распознавание речи —
// офлайн через Vosk в окне оверлея, состояние способностей — из Dota GSI.
const { app, BrowserWindow, screen, session } = require('electron');
const { Worker } = require('worker_threads');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const koffi = require('koffi');
const SPELLS = require('./spells');
const { ACTION, createVoiceCast, vkOf } = require('./logic');
const { WM_APP_VOICE_READY, WM_APP_CAST } = require('./messages');

const config = {
  port: 3055,
  // Должен совпадать с "token" в gamestate_integration_voice_invoke.cfg
  authToken: 'voice_invoke',
  // Клавиши Dota: сферы, Invoke и два слота собранных способностей
  keys: { quas: 'Q', wex: 'W', exort: 'E', invoke: 'R', slot1: 'D', slot2: 'F' },
  // Клавиша голосового чата Dota: плагин слушает, пока она зажата
  voiceChatKey: 'G',
  // Клавиши, которые игроку нажимать нельзя (имена из keys): способности только голосом.
  // ["invoke"] — нельзя собирать руками; добавь "slot1", "slot2", чтобы нельзя было и применять.
  blockKeys: ['invoke'],
  // "hold" — слушать, пока зажата voiceChatKey; "always" — слушать постоянно
  listen: 'hold',
  // Как применять способность с целью:
  //   "click"     — нажать клавишу и кликнуть левой кнопкой (обычный каст в Dota)
  //   "quickcast" — только клавиша (в Dota включён быстрый каст)
  castMode: 'click',
  // Паузы между нажатиями, мс
  keyDelayMs: 35,
  castDelayMs: 90,   // после Invoke перед клавишей способности (только без данных от Dota)
  slotWaitMs: 1500,  // сколько ждём появления способности в слоте после Invoke
  clickDelayMs: 60,  // после клавиши способности перед кликом
  altDelayMs: 30,    // Alt зажат за столько до клавиши и отпускается через столько после (Cataclysm)
  chainGapMs: 40,    // между способностями, названными подряд в одной фразе
  // Название микрофона, как в окне настроек ("" — системный по умолчанию)
  microphone: '',
  // Работать только когда активно окно с этим заголовком ("" — всегда)
  windowTitle: 'Dota 2',
  // Фразы, по которым узнаются способности. Слушает только русская модель, поэтому фразы
  // пишутся по-русски (английские названия — как слышатся: «сан страйк»). Слова должны
  // быть в словаре модели: если слова нет, при запуске в консоли будет предупреждение —
  // подбери похожее по звучанию.
  phrases: {
    // Слов «снэп», «алакрити», «дефенинг», «форж» в словаре нет — они записаны похожими по звучанию.
    // Реплики Инвокера: имена собственные (Садрон, Корикс, Шимарэ, Торнарус, Харлек...) и редкие
    // слова тоже разбиты на похожие слова из словаря («сад рона», «торна руса», «хар лека»).
    invoker_cold_snap: ['колд с нэп', 'колд', 'холод', 'заморозка',
      'длительная дрожь сад рона', 'длительная дрожь', 'обрати хрупкость льда', 'хрупкость льда'],
    invoker_ghost_walk: ['гост волк', 'походка призрака', 'я ускользая из вида', 'я ускользает из вида',
      'дух летаргии', 'призрак мира', 'призрак мирона'],
    invoker_ice_wall: ['айс вол', 'бастион горести', 'стенка', 'ледяная стена',
      'гибельной стена кори икса', 'гибельной стена', 'белая пустошь зовёт', 'белая пустошь'],
    invoker_emp: ['эмп', 'и эм пи', 'импульс',
      'экстра мана пульс', 'мана пульс', 'пульс шима ре', 'недоброе коло вращение эндо леона', 'недоброе коло вращение'],
    invoker_tornado: ['мои враги парят', 'ветра', 'торнадо', 'когти торна руса', 'когти торнадо'],
    invoker_alacrity: ['ала кри ти', 'рвение экспорта', 'ускорение',  // «алакрити», «рвение эксорта»
      'узри истинную скорость', 'истинную скорость', 'заклятие стремительности гас тера', 'заклятие стремительности'],
    invoker_sun_strike: ['сан страйк', 'солнечный удар', 'заклятье испепелить хар лека', 'заклятье испепеляющий',
      'экспорт трио нис', 'экспорт три солар'],
    invoker_forge_spirit: ['морж спирит', 'форс спирит', 'моржи', 'духи',  // «форж спирит», «форжи»
      'элементы горя', 'элемент али горя', 'хитроумные конструкции кальвина', 'хитроумные конструкции',
      'разрушители из воли и брони', 'союзник из ниоткуда'],
    // «чаос метеор» модель слышит как «хаос метеор»; «узрите тефтель» — как «узрите теплеть»
    invoker_chaos_meteor: ['котлета', 'метеор', 'хаос метеор', 'узрите теплеть', 'узрите тефлон',
      'пиро класс бездны', 'огонь небес тара ка', 'огонь небес', 'небесное инферно',
      'карно сфера бездны галла рона', 'карно сфера бездны'],
    invoker_deafening_blast: ['де фен инг бласт', 'бласт', 'звуковой бум',  // «дефенинг бласт»
      'три сферический взрыв', 'оглушающий трио', 'звуковой обездвижить булл фонтан', 'звуковой обездвижить'],
    // Слова «катаклизм» в словаре нет — модель слышала вместо него «сан страйк»
    invoker_cataclysm: ['катаклизма', 'катаклизмы', 'катаклизмов', 'ката клизм'],
  },
  // Для отладки
  acceptInjected: false,
  debugSteps: false,
};
const EXTRA_PHRASES = require('./extra-phrases.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
let userConfig = {};
try {
  userConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  Object.assign(config, userConfig, {
    keys: { ...config.keys, ...(userConfig.keys || {}) },
    phrases: { ...config.phrases, ...(userConfig.phrases || {}) },
  });
} catch (e) {
  if (e.code !== 'ENOENT') console.error('config.json не прочитан:', e.message);
}
// Клавиши ещё ни разу не настраивались — при запуске откроем окно настроек
const firstRun = !userConfig.keys;

// Activate new words only with a separately rebuilt and tested graph.
const expandedModel = path.join(__dirname, 'model', 'vosk-model-small-ru-invoker.tar.gz');
const useExpanded = userConfig.expandedVocabulary === true && fs.existsSync(expandedModel);
for (const [suffix, extra] of Object.entries(EXTRA_PHRASES)) {
  const id = 'invoker_' + suffix;
  config.phrases[id] = [...new Set([...(config.phrases[id] || []), ...extra.ready, ...(useExpanded ? extra.pending : [])])];
}

const isRussian = (phrase) => /[а-яё]/i.test(phrase);
// Фраза -> способность. Английские фразы русская модель не распознаёт — их пропускаем.
const phraseToSpell = {};
const skipped = [];
for (const s of SPELLS) {
  for (const p of config.phrases[s.id] || []) {
    if (isRussian(p)) phraseToSpell[p.toLowerCase()] = s.id;
    else skipped.push(p);
  }
}

const MODEL_DIR = path.join(__dirname, 'model');
// Русская модель раздаётся архивом .zip, а библиотеке нужен .tar.gz — перепаковываем
const RU_NAME = 'vosk-model-small-ru-0.22';
const RU_URL = `https://alphacephei.com/vosk/models/${RU_NAME}.zip`;
const RU_PATH = useExpanded ? expandedModel : path.join(MODEL_DIR, RU_NAME + '.tar.gz');

// Лог идёт в консоль и в файл log.txt (перезаписывается при каждом запуске)
const LOG_FILE = path.join(__dirname, 'log.txt');
try {
  fs.writeFileSync(LOG_FILE, '');
} catch {}
function log(...a) {
  const line = [new Date().toLocaleTimeString(), ...a].join(' ');
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

// ---------- Модель распознавания (скачивается один раз, ~45 МБ) ----------
async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.writeFileSync(file + '.part', Buffer.from(await res.arrayBuffer()));
  fs.renameSync(file + '.part', file);
}

async function ensureModel() {
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  if (fs.existsSync(RU_PATH)) return;
  log('Скачиваю русскую модель распознавания (~45 МБ, один раз)...');
  const zip = path.join(MODEL_DIR, RU_NAME + '.zip');
  await download(RU_URL, zip);
  // tar.exe входит в Windows 10 и новее, умеет читать .zip
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-xf', zip], { cwd: MODEL_DIR });
  execFileSync(tar, ['-czf', RU_PATH, RU_NAME], { cwd: MODEL_DIR });
  fs.rmSync(path.join(MODEL_DIR, RU_NAME), { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  log('Русская модель скачана');
}

// ---------- Связь с потоком хука ----------
const user32 = koffi.load('user32.dll');
const PostThreadMessageW = user32.func('bool __stdcall PostThreadMessageW(uint32 idThread, uint32 Msg, uintptr_t wParam, intptr_t lParam)');
let hookThreadId = 0;
let voiceReady = false;
const toHook = (msg, wParam, lParam = 0) => hookThreadId && PostThreadMessageW(hookThreadId, msg, wParam, lParam);

// ---------- Состояние игры из Dota GSI ----------
let gsi = null; // { at, hero, abilities: { name: {cooldown, can_cast, level} }, slots: [name, name] }
let gsiWarned = false;

function handleGsi(data) {
  if (config.authToken && data?.auth?.token !== config.authToken) return;
  const abilities = {};
  const slots = [];
  // Порядок ability0..N совпадает с порядком на панели: два слота способностей идут
  // после сфер (invoker_empty1/2, пока слот пуст)
  const keys = Object.keys(data.abilities || {}).sort((a, b) => parseInt(a.slice(7)) - parseInt(b.slice(7)));
  for (const k of keys) {
    const a = data.abilities[k];
    if (!a || !a.name) continue;
    abilities[a.name] = a;
    if (a.name.startsWith('invoker_empty') || SPELLS.some((s) => s.id === a.name)) slots.push(a.name);
  }
  if (!gsi) log('Данные от Dota получены (GSI работает)');
  detectSunStrikeKill(data, abilities);
  gsi = {
    at: Date.now(),
    hero: data.hero?.name || null,
    alive: data.hero?.alive !== false,
    scepter: data.hero?.aghanims_scepter, // undefined, если игра не сообщает
    kills: data.player?.kills,
    abilities,
    slots,
  };
  checkSlot();
  // Очередь могла ждать свежих данных об Invoke
  if (queue.length) pump();
}

// ---------- Убийство Sun Strike ----------
// Игра не сообщает, чем убит герой. Считаем убийство «с санстрайка», если счётчик убийств
// вырос через 1.4–4 сек после его применения: удар падает через 1.7 сек (Cataclysm — позже).
const SUN_KILL_MIN_MS = 1400;
const SUN_KILL_MAX_MS = 4000;
let sunStrikeAt = 0;
let killsWarned = false;

function detectSunStrikeKill(data, abilities) {
  if (!gsi) return;
  const now = Date.now();
  // Sun Strike ушёл на перезарядку — применён (в том числе руками, без голоса)
  const was = gsi.abilities.invoker_sun_strike, is = abilities.invoker_sun_strike;
  if (was && is && was.cooldown === 0 && is.cooldown > 0) sunStrikeAt = now;
  const kills = data.player?.kills;
  if (kills === undefined && data.hero?.name && !killsWarned) {
    killsWarned = true;
    log('Dota не присылает счётчик убийств — анимация за Sun Strike не сработает. Скопируй файл .cfg в папку Dota заново и перезапусти игру.');
  }
  if (!(kills > gsi.kills)) return;
  const since = now - sunStrikeAt;
  if (since < SUN_KILL_MIN_MS || since > SUN_KILL_MAX_MS) return;
  log(`Убийство через ${since} мс после Sun Strike — показываю анимацию`);
  broadcast({ ...last, event: 'sunkill' });
}

// Пока Dota не прислала данные после нашего каста, состояние слотов считаем сами:
// собранная способность встаёт в слот 1, бывшая из слота 1 уходит во второй.
// { after, slots, used, invoked } — сбрасывается первым пакетом GSI, пришедшим позже after.
let predicted = null;
function prediction() {
  if (predicted && gsi && gsi.at > predicted.after) predicted = null;
  return predicted;
}

// Решаем, что нажимать для способности: { action }, { refuse: причина } или { wait: true }
function plan(spell) {
  const fresh = gsi && Date.now() - gsi.at < 5000 && gsi.hero;
  if (!fresh) {
    if (!gsiWarned) log('Нет данных от Dota (GSI) — кастую вслепую: сферы + Invoke + слот 1');
    gsiWarned = true;
    return { action: ACTION.INVOKE };
  }
  gsiWarned = false;
  if (gsi.hero !== 'npc_dota_hero_invoker') return { refuse: 'Герой не Инвокер' };
  if (!gsi.alive) return { refuse: 'Герой мёртв' };

  if (spell.needsScepter && gsi.scepter === false) return { refuse: `${spell.name}: нужен Аганим` };

  // Cataclysm — это Sun Strike, поэтому смотрим на слот базовой способности
  const id = spell.base || spell.id;
  const pr = prediction();
  if (pr && pr.used.has(id)) return { refuse: `${spell.name} на перезарядке` };
  const slot = (pr ? pr.slots : gsi.slots).indexOf(id);
  if (slot >= 0) {
    const own = gsi.abilities[id];
    if (own && own.cooldown > 0) return { refuse: `${spell.name} на перезарядке (${Math.ceil(own.cooldown)} сек)` };
    if (own && own.can_cast === false) return { refuse: `${spell.name}: нельзя применить (мана или контроль)` };
    return { action: slot === 1 ? ACTION.SLOT2 : ACTION.SLOT1 };
  }
  // Invoke только что нажат — его перезарядку узнаем из следующего пакета Dota
  if (pr && pr.invoked) return { wait: true };
  const invoke = gsi.abilities.invoker_invoke;
  if (invoke && invoke.cooldown > 0) return { refuse: `Invoke на перезарядке (${Math.ceil(invoke.cooldown)} сек)` };
  if (invoke && invoke.can_cast === false) return { refuse: 'Invoke: нельзя применить (мана или контроль)' };
  return { action: ACTION.INVOKE };
}

// ---------- Очередь кастов ----------
// Способности, названные подряд, применяются одна за другой: следующая начинается, как только
// поток хука закончит нажатия предыдущей.
const queue = [];          // { spell, phrase, at }
let busyUntil = 0;         // до этого момента поток хука выполняет предыдущую серию нажатий
let pumpTimer = null;
let gsiWaitUntil = 0;
let lastQueued = { id: null, at: 0 };
const GSI_WAIT_MS = 400;   // сколько ждём данных Dota об Invoke перед следующей сборкой
const QUEUE_TTL_MS = 3000; // слишком долго ждавшие команды выбрасываем
// Те же шаги, что выполнит поток хука, — чтобы знать длительность серии нажатий
const sequencer = createVoiceCast(config, { isGameActive: () => true, emit() {}, quit() {} });
const sequenceMs = (spell, action) => sequencer.buildSequence(spell, action).reduce((t, st) => t + (st.wait || 0), 0);

function castByPhrase(phrase) {
  const spell = SPELLS.find((s) => s.id === phraseToSpell[phrase]);
  if (!spell) return;
  if (!last || !last.state.enabled) return;
  // Одну и ту же фразу могут услышать обе модели — второй раз не кастуем
  if (lastQueued.id === spell.id && Date.now() - lastQueued.at < 2500) return;
  lastQueued = { id: spell.id, at: Date.now() };
  queue.push({ spell, phrase, at: Date.now() });
  pump();
}


function pump() {
  clearTimeout(pumpTimer);
  pumpTimer = null;
  while (queue.length && !awaitingSlot) {
    const now = Date.now();
    if (now < busyUntil) {
      pumpTimer = setTimeout(pump, busyUntil - now);
      return;
    }
    const { spell, phrase, at } = queue[0];
    if (now - at > QUEUE_TTL_MS) {
      queue.shift();
      log(`"${phrase}" -> пропущено: слишком долго ждало в очереди`);
      continue;
    }
    let p = plan(spell);
    if (p.wait) {
      if (!gsiWaitUntil) gsiWaitUntil = now + GSI_WAIT_MS;
      if (now < gsiWaitUntil) {
        pumpTimer = setTimeout(pump, 25); // а скорее раньше — с приходом пакета GSI
        return;
      }
      p = { refuse: 'Invoke на перезарядке' };
    }
    gsiWaitUntil = 0;
    queue.shift();
    cast(spell, phrase, p);
  }
}

function cast(spell, phrase, p) {
  if (p.refuse) {
    log(`"${phrase}" -> отказ: ${p.refuse}`);
    return broadcast({ ...last, event: 'refuse', spell, reason: p.refuse });
  }
  // Есть данные от Dota: собираем и ждём, пока способность появится в слоте (см. checkSlot).
  // Вслепую остаётся только фиксированная пауза castDelayMs.
  if (p.action === ACTION.INVOKE && gsi && Date.now() - gsi.at < 5000) {
    log(`"${phrase}" -> ${spell.name}: Invoke, жду появления в слоте`);
    toHook(WM_APP_CAST, SPELLS.indexOf(spell) + 1, ACTION.PREPARE);
    const from = Date.now();
    busyUntil = from + sequenceMs(spell, ACTION.PREPARE);
    awaitingSlot = { spell, phrase, from, timer: setTimeout(slotTimeout, config.slotWaitMs) };
    return;
  }
  const how = { [ACTION.SLOT1]: 'уже в слоте 1', [ACTION.SLOT2]: 'уже в слоте 2', [ACTION.INVOKE]: 'Invoke + слот 1' }[p.action];
  press(spell, phrase, p.action, how);
}

// ---------- Ожидание способности в слоте после Invoke ----------
// Из-за пинга способность появляется в слоте не сразу. Клавишу слота нажимаем, только когда
// пакет GSI показал её там, — а не через фиксированную паузу.
let awaitingSlot = null; // { spell, phrase, from, timer }

function checkSlot() {
  if (!awaitingSlot) return;
  const { spell, phrase, from, timer } = awaitingSlot;
  const id = spell.base || spell.id;
  const slot = gsi.slots.indexOf(id);
  if (slot < 0) return;
  clearTimeout(timer);
  awaitingSlot = null;
  const own = gsi.abilities[id];
  if (own && own.cooldown > 0) return cast(spell, phrase, { refuse: `${spell.name} на перезарядке (${Math.ceil(own.cooldown)} сек)` });
  press(spell, phrase, slot === 1 ? ACTION.SLOT2 : ACTION.SLOT1, `в слоте ${slot + 1} через ${Date.now() - from} мс`);
}

function slotTimeout() {
  const { spell, phrase } = awaitingSlot;
  awaitingSlot = null;
  cast(spell, phrase, { refuse: `${spell.name} не появилась в слоте` });
  pump();
}

function press(spell, phrase, action, how) {
  log(`"${phrase}" -> ${spell.name} (${how})${queue.length ? `, дальше в очереди: ${queue.length}` : ''}`);
  toHook(WM_APP_CAST, SPELLS.indexOf(spell) + 1, action);
  busyUntil = Date.now() + sequenceMs(spell, action) + config.chainGapMs;
  if ((spell.base || spell.id) === 'invoker_sun_strike') sunStrikeAt = Date.now();
  if (gsi) {
    const pr = prediction() || { slots: [...gsi.slots], used: new Set(), invoked: false };
    const id = spell.base || spell.id;
    if (action === ACTION.INVOKE) {
      pr.slots = [id, ...pr.slots.filter((x) => x !== id)].slice(0, 2);
      pr.invoked = true;
    }
    pr.used.add(id);
    pr.after = busyUntil;
    predicted = pr;
  }
  // Положение курсора в долях экрана — для хитмаркера в оверлее (подходит и для OBS)
  const { bounds } = screen.getPrimaryDisplay();
  const pt = screen.getCursorScreenPoint();
  const aim = { x: (pt.x - bounds.x) / bounds.width, y: (pt.y - bounds.y) / bounds.height };
  broadcast({ ...last, event: 'cast', spell, aim });
}

// ---------- HTTP + SSE для оверлея ----------
let last = null;
const clients = new Set();
function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

function sendFile(res, file, type) {
  fs.stat(file, (err, st) => {
    if (err) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- Настройки клавиш (окно settings.html пишет в config.json) ----------
const KEY_NAMES = ['quas', 'wex', 'exort', 'invoke', 'slot1', 'slot2'];
const okKey = (k) => typeof k === 'string' && vkOf(k) > 0;

function settingsData() {
  return {
    keys: config.keys,
    voiceChatKey: config.voiceChatKey,
    castMode: config.castMode,
    listen: config.listen,
    blockKeys: config.blockKeys || [],
    microphone: config.microphone || '',
  };
}

// Берём из присланного только известные поля с допустимыми значениями и дописываем их
// в config.json, не трогая остальное (свои фразы, паузы и т.д.)
function saveSettings(body) {
  const out = { ...userConfig };
  const keys = {};
  for (const n of KEY_NAMES) if (okKey(body.keys?.[n])) keys[n] = body.keys[n].toUpperCase();
  out.keys = { ...config.keys, ...keys };
  if (okKey(body.voiceChatKey)) out.voiceChatKey = body.voiceChatKey.toUpperCase();
  if (['click', 'quickcast'].includes(body.castMode)) out.castMode = body.castMode;
  if (['hold', 'always'].includes(body.listen)) out.listen = body.listen;
  if (typeof body.microphone === 'string') out.microphone = body.microphone.slice(0, 200);
  if (Array.isArray(body.blockKeys)) out.blockKeys = body.blockKeys.filter((n) => KEY_NAMES.includes(n));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + '\n');
  userConfig = out;
  log('Настройки сохранены в config.json');
}

let settingsWin = null;
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    return settingsWin.focus();
  }
  settingsWin = new BrowserWindow({
    width: 640, height: 760, minWidth: 480, title: 'Voice Invoke — настройки',
    backgroundColor: '#0b0e11', autoHideMenuBar: true, alwaysOnTop: true,
  });
  settingsWin.setMenu(null);
  settingsWin.loadURL(`http://localhost:${config.port}/settings`);
  settingsWin.on('closed', () => (settingsWin = null));
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://localhost').pathname;
  const done = () => {
    res.writeHead(204);
    res.end();
  };
  if (req.method === 'POST' && p === '/gsi') {
    handleGsi(await readJson(req));
    return done();
  }
  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (last) res.write(`data: ${JSON.stringify({ ...last, event: null })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/' || p === '/overlay.html') return sendFile(res, path.join(__dirname, 'overlay.html'), 'text/html; charset=utf-8');
  if (p === '/sounds/keys.wav') return sendFile(res, path.join(__dirname, 'sounds', 'keys.wav'), 'audio/wav');
  if (p === '/sounds/hitmarker.mp3') return sendFile(res, path.join(__dirname, 'sounds', 'hitmarker.mp3'), 'audio/mpeg');
  if (p === '/vosk.js') return sendFile(res, require.resolve('vosk-browser/dist/vosk.js'), 'text/javascript');
  if (p === '/media/sunstrike-kill.mp4') return sendFile(res, path.join(__dirname, 'media', 'sunstrike-kill.mp4'), 'video/mp4');
  // Проверка анимации без игры: открой http://localhost:порт/test-kill
  if (p === '/test-kill') {
    broadcast({ ...last, event: 'sunkill' });
    return done();
  }
  if (p === '/settings') return sendFile(res, path.join(__dirname, 'settings.html'), 'text/html; charset=utf-8');
  if (p === '/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(settingsData()));
  }
  // Только application/json: чужая страница в браузере не сможет отправить такой запрос без CORS
  if (req.method === 'POST' && (p === '/config' || p === '/restart')) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      res.writeHead(415);
      return res.end();
    }
    if (p === '/restart') {
      done();
      log('Перезапуск с новыми настройками...');
      app.relaunch();
      return setTimeout(() => app.exit(0), 200);
    }
    try {
      saveSettings(await readJson(req));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    } catch (e) {
      log('Не удалось сохранить настройки:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }
  if (p === '/mic') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ microphone: config.microphone || '' }));
  }
  if (p === '/model-ru.tar.gz') return sendFile(res, RU_PATH, 'application/gzip');
  if (p === '/grammar') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(Object.keys(phraseToSpell)));
  }
  if (req.method === 'POST' && p === '/voice') {
    const { text, texts } = await readJson(req);
    for (const t of Array.isArray(texts) ? texts : [text]) castByPhrase(String(t || '').trim().toLowerCase());
    return done();
  }
  if (req.method === 'POST' && p === '/voice-status') {
    const { ready, message } = await readJson(req);
    if (message) log('Голос:', message);
    voiceReady = !!ready;
    toHook(WM_APP_VOICE_READY, voiceReady ? 1 : 0);
    return done();
  }
  res.writeHead(404);
  res.end();
});
setInterval(() => clients.forEach((res) => res.write(': ping\n\n')), 15000);

// ---------- Хук клавиатуры ----------
function startWorker() {
  const worker = new Worker(path.join(__dirname, 'hook-worker.js'), { workerData: { config } });
  worker.on('message', (m) => {
    if (m.type === 'quit') return app.exit(0);
    if (m.type === 'log') return log(m.text);
    if (m.type === 'settings') return openSettings();
    if (m.type === 'ready') {
      hookThreadId = m.threadId;
      log('Хук клавиатуры установлен');
      return toHook(WM_APP_VOICE_READY, voiceReady ? 1 : 0);
    }
    if (m.type === 'state') {
      last = { state: m.state };
      broadcast({ ...last, event: m.event });
      if (m.event === 'blocked') log('Клавиша заблокирована: способности только голосом');
      if (m.event === 'toggle') log(m.state.enabled ? 'Голосовой каст ВКЛЮЧЁН' : 'Голосовой каст ВЫКЛЮЧЕН');
    }
  });
  worker.on('error', (e) => log('Ошибка потока хука:', e.stack || e));
}

// ---------- Окно поверх игры (в нём же работает распознавание) ----------
function createWindow() {
  // Разрешаем доступ к микрофону для нашей страницы
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media');

  const { bounds } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    title: 'Voice Invoke',
    webPreferences: { backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  // Модель сообщает о словах, которых нет в её словаре, — показываем это в консоли
  const unknown = new Set();
  win.webContents.on('console-message', (...args) => {
    const text = typeof args[2] === 'string' ? args[2] : (args[0] && args[0].message) || '';
    const m = /Ignoring word missing in vocabulary: '(.+?)'/.exec(text);
    if (m && !unknown.has(m[1])) {
      unknown.add(m[1]);
      log(`Слова «${m[1]}» нет в словаре модели — фраза с ним не сработает. Замени на похожее по звучанию.`);
    }
  });
  const url = `http://localhost:${config.port}/overlay.html?voice=1&sound=1`;
  const load = () => win.loadURL(url).catch(() => setTimeout(load, 1000));
  load();
  setInterval(() => !win.isDestroyed() && win.moveTop(), 3000);
}

app.whenReady().then(async () => {
  try {
    await ensureModel();
  } catch (e) {
    log('Не удалось подготовить модель распознавания, голос работать не будет:', e.message);
  }
  if (skipped.length) log(`Фразы не по-русски пропущены (слушает только русская модель): ${skipped.join(', ')}`);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`Порт ${config.port} уже занят (плагин уже запущен или порт занят другой программой).`);
      log('Укажи другой порт в config.json и в файле .cfg для Dota');
    } else log('Ошибка сервера:', e.message);
    setTimeout(() => app.exit(1), 5000);
  });
  server.listen(config.port, '127.0.0.1', () => {
    const k = config.keys;
    log(`Голосовой каст запущен. Оверлей для OBS: http://localhost:${config.port}/overlay.html`);
    log(`Сферы ${k.quas}/${k.wex}/${k.exort}, Invoke ${k.invoke}, слоты ${k.slot1}/${k.slot2}, каст: ${config.castMode}`);
    log(config.listen === 'always' || !config.voiceChatKey
      ? 'Слушаю микрофон постоянно'
      : `Слушаю, пока зажата клавиша голосового чата ${String(config.voiceChatKey).toUpperCase()}`);
    log('Ctrl+Shift+F7 — вкл/выкл, Ctrl+Shift+F8 — выход, Ctrl+Shift+F9 — настройки клавиш');
    startWorker();
    createWindow();
    if (firstRun) openSettings();
  });
});
app.on('window-all-closed', () => app.exit(0));
