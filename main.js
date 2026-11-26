// Голосовой каст Инвокера: говоришь название способности — она собирается и применяется.
// Хук клавиатуры и нажатия — в отдельном потоке (hook-worker.js), распознавание речи —
// офлайн через Vosk в окне оверлея, состояние способностей — из Dota GSI.
const { app, BrowserWindow, screen, session, Tray, Menu, dialog, shell } = require('electron');
const { Worker } = require('worker_threads');
// Acquire before touching logs, model or native hooks. Same app name across releases.
if (!app.requestSingleInstanceLock()) {
  console.log('Voice Invoker уже запущен. Открываю настройки существующего экземпляра.');
  app.exit(0);
  return;
}
let settingsRequested = process.env.VI_REOPEN_SETTINGS === '1' || process.argv.includes('--vi-reopen-settings');
let serverReady = false;
let tray = null;
app.on('second-instance', () => {
  if (serverReady && !shutdown) openSettings();
  else settingsRequested = true;
});
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const koffi = require('koffi');
const SPELLS = require('./spells');
const { ITEM_KEYS, ITEM_SLOTS, readInventory, planItem } = require('./items');
const { readModelWords } = require('./model-words');
const { validateItemPhrases } = require('./item-phrases');
const { importBindings } = require('./dota-bindings');
const { processStatus } = require('./diagnostics');
const { ACTION, vkOf } = require('./logic');
const { decodeVoiceCommand } = require('./phrase-parser');
const { normalizeProfile, getTiming, encodeCast, MAX_CAST_ID, profileLabel } = require('./timing-profiles');
const { WM_APP_VOICE_READY, WM_APP_CAST, WM_APP_QUIT, WM_APP_TOGGLE } = require('./messages');

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
  timingProfile: 'normal',
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
    // Исторические варианты для исходной модели сохранены; точные названия добавляет V2.
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
const { catalog, exclusions, enabledPhrases } = require('./phrase-preferences');
const { experimentalModel } = require('./experimental-model');
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

const { prepareExpandedModel } = require('./model-selection');
const MODEL_DIR = path.join(__dirname, 'model');
const RU_NAME = 'vosk-model-small-ru-0.22';
const RU_URL = `https://alphacephei.com/vosk/models/${RU_NAME}.zip`;
let RU_PATH = path.join(MODEL_DIR, RU_NAME + '.tar.gz');
const phraseToSpell = {};
const skipped = [];
const allPhrases = catalog(Object.fromEntries(Object.entries(config.phrases).filter(([id])=>SPELLS.some(s=>s.id===id))), EXTRA_PHRASES);
let modelWords=null;
let modelInfo = { active: false, reason: 'initializing' }, experimental = null;
let voiceInfo = {ready:false, message:''}, lastTest = null;
const testOnly = config.testOnly === true;

// Build the command set only after the local/downloaded model has been selected.
function configurePhrases(useExpanded) {
  config.phrases = enabledPhrases(allPhrases, exclusions(config.disabledPhrases, allPhrases), EXTRA_PHRASES, useExpanded);
  const isRussian = (phrase) => /[а-яё]/i.test(phrase);
  // Фраза -> способность. Английские фразы русская модель не распознаёт — их пропускаем.
  const reserved=enabledPhrases(allPhrases,exclusions(config.disabledPhrases,allPhrases),EXTRA_PHRASES,true);
  const custom=validateItemPhrases(config.itemPhrases,modelWords,reserved,{strict:false});
  if(custom.errors.length)log('Пропущенные фразы предметов:',custom.errors.join('; '));
  Object.assign(config.phrases,custom.phrases);
  for (const s of [...SPELLS, ...ITEM_SLOTS]) {
    for (const p of config.phrases[s.id] || []) {
      if (isRussian(p) || s.itemSlot) phraseToSpell[p.toLowerCase()] = s.id;
      else skipped.push(p);
    }
  }
}

// Лог идёт в консоль и в файл log.txt (перезаписывается при каждом запуске)
const LOG_FILE = path.join(__dirname, 'log.txt');
try {
  if (fs.existsSync(LOG_FILE)) fs.copyFileSync(LOG_FILE, path.join(__dirname, 'log.previous.txt'));
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
let hookWorker = null;
let shutdown = null;
let exiting = false;
let voiceReady = false;
const toHook = (msg, wParam, lParam = 0) => (!shutdown || msg === WM_APP_QUIT) && hookThreadId && PostThreadMessageW(hookThreadId, msg, wParam, lParam);

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
  gsi = {
    at: Date.now(),
    hero: data.hero?.name || null,
    alive: data.hero?.alive !== false,
    scepter: data.hero?.aghanims_scepter, // undefined, если игра не сообщает
    abilities,
    slots,
    items: readInventory(data.items),
  };
  checkSlot();
  // Очередь могла ждать свежих данных об Invoke
  if (queue.length) pump();
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
function plan(spell, prepareOnly = false) {
  if (spell.itemSlot) return planItem(spell,gsi,config,prepareOnly);
  const fresh = gsi && Date.now() - gsi.at < 5000 && gsi.hero;
  if (!fresh) {
    if (!gsiWarned) log('Нет данных от Dota (GSI) — кастую вслепую: сферы + Invoke + слот 1');
    gsiWarned = true;
    return prepareOnly ? { action: ACTION.PREPARE, unconfirmed: true } : { action: ACTION.INVOKE };
  }
  gsiWarned = false;
  if (gsi.hero !== 'npc_dota_hero_invoker') return { refuse: 'Герой не Инвокер' };
  if (!gsi.alive) return { refuse: 'Герой мёртв' };

  if (!prepareOnly && spell.needsScepter && gsi.scepter === false) return { refuse: `${spell.name}: нужен Аганим` };

  // Cataclysm — это Sun Strike, поэтому смотрим на слот базовой способности
  const id = spell.base || spell.id;
  const pr = prediction();
  if (!prepareOnly && pr && pr.used.has(id)) return { refuse: `${spell.name} на перезарядке` };
  const slot = (pr ? pr.slots : gsi.slots).indexOf(id);
  if (slot >= 0) {
    if (prepareOnly) return gsi.slots.includes(id) ? { prepared: true } : { wait: true };
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
  return { action: prepareOnly ? ACTION.PREPARE : ACTION.INVOKE };
}

// ---------- Очередь кастов ----------
// Способности, названные подряд, применяются одна за другой: следующая начинается, как только
// поток хука закончит нажатия предыдущей.
const queue = [];          // { spell, phrase, at }
let busyUntil = 0;         // пауза после подтверждённой серии
let activeCast = null;
let castRequestId = 0;
let pumpTimer = null;
let gsiWaitUntil = 0;
let lastQueued = { id: null, at: 0 };
const GSI_WAIT_MS = 400;   // сколько ждём данных Dota об Invoke перед следующей сборкой
const QUEUE_TTL_MS = 3000; // слишком долго ждавшие команды выбрасываем
// Only one request can be in flight; no estimated completion from nominal waits.
function dispatchCast(spell, action, profile) {
  if (activeCast) return false;
  castRequestId = castRequestId % MAX_CAST_ID + 1;
  const id = castRequestId;
  if (!toHook(WM_APP_CAST, (spell.itemSlot ? SPELLS.length + spell.itemSlot : SPELLS.indexOf(spell) + 1), encodeCast(action, profile, id))) return false;
  activeCast = { id, spell, action, profile, timedOut: false };
  const timing = getTiming(config, profile);
  // Fail closed if the worker stops responding; do not send another series until it replies.
  const limit = 5000 + 3 * timing.keyDelayMs + timing.castDelayMs + timing.clickDelayMs + 2 * timing.altDelayMs;
  activeCast.watchdog = setTimeout(() => {
    if (activeCast?.id !== id) return;
    activeCast.timedOut = true;
    discardWaiting();
    log('Поток ввода не подтвердил завершение; новые команды остановлены до ответа');
  }, limit);
  return true;
}

function handleCastComplete(m) {
  if (!activeCast || m.id !== activeCast.id) return;
  const finished = activeCast;
  clearTimeout(finished.watchdog);
  activeCast = null;
  if (finished.timedOut) m = { ...m, ok: false, reason: 'Тайм-аут подтверждения ввода' };
  if (config.debugSteps || !m.ok) log('Каст:', finished.spell.name, m.profile, Math.round(m.elapsedMs) + ' мс', m.ok ? 'OK' : m.reason);
  if (!m.ok) {
    discardWaiting();
    predicted = null;
    busyUntil = 0;
    return broadcast({ ...last, event: 'refuse', spell: finished.spell, reason: m.reason || 'Ошибка ввода' });
  }
  if (finished.action === ACTION.PREPARE && awaitingSlot && last?.state.enabled) {
    if (awaitingSlot.prepareOnly && awaitingSlot.unconfirmed) {
      const waiting = awaitingSlot;
      awaitingSlot = null;
      busyUntil = Date.now() + getTiming(config, waiting.profile).chainGapMs;
      notifyPrepared(waiting.spell, false);
    } else {
      awaitingSlot.timer = setTimeout(slotTimeout, config.slotWaitMs);
      checkSlot();
    }
  } else {
    busyUntil = Date.now() + getTiming(config, finished.profile).chainGapMs;
    if (predicted) predicted.after = busyUntil;
  }
  pump();
}

function discardWaiting() {
  queue.length = 0;
  if (awaitingSlot) clearTimeout(awaitingSlot.timer);
  awaitingSlot = null;
  clearTimeout(pumpTimer);
  pumpTimer = null;
  gsiWaitUntil = 0;
}

function castByPhrase(command) {
  const { phrase, prepareOnly } = decodeVoiceCommand(command);
  const id=phraseToSpell[phrase];
  const spell = SPELLS.find(s=>s.id===id) || (id?.startsWith('item_slot_') ? ITEM_SLOTS.find(s=>s.id===id) : null);
  if (!spell) return;
  if (!last || !last.state.enabled || activeCast?.timedOut) return;
  // Одну и ту же фразу могут услышать обе модели — второй раз не кастуем
  const dedupId = (prepareOnly ? 'prepare:' : 'cast:') + spell.id;
  if (lastQueued.id === dedupId && Date.now() - lastQueued.at < 2500) return;
  lastQueued = { id: dedupId, at: Date.now() };
  queue.push({ spell, phrase, prepareOnly, at: Date.now() });
  pump();
}


function pump() {
  clearTimeout(pumpTimer);
  pumpTimer = null;
  if (!last?.state.enabled) { discardWaiting(); return; }
  while (queue.length && !awaitingSlot && !activeCast) {
    const now = Date.now();
    if (now < busyUntil) {
      pumpTimer = setTimeout(pump, busyUntil - now);
      return;
    }
    const { spell, phrase, at, prepareOnly } = queue[0];
    if (now - at > QUEUE_TTL_MS) {
      queue.shift();
      log(`"${phrase}" -> пропущено: слишком долго ждало в очереди`);
      continue;
    }
    let p = plan(spell, prepareOnly);
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
    cast(spell, phrase, p, normalizeProfile(last?.state.timingProfile || config.timingProfile), prepareOnly);
  }
}

function cast(spell, phrase, p, profile = normalizeProfile(config.timingProfile), prepareOnly = false) {
  if (p.refuse) {
    log(`"${phrase}" -> отказ: ${p.refuse}`);
    return broadcast({ ...last, event: 'refuse', spell, reason: p.refuse });
  }
  if (p.itemSlot) {
    const item=ITEM_SLOTS[p.itemSlot-1];
    if(!dispatchCast(item,p.action,profile))return cast(spell,phrase,{refuse:'Поток ввода недоступен'});
    log('Предмет: '+item.name);
    return broadcast({...last,event:'item',spell:item});
  }
  if (prepareOnly) {
    if (p.prepared) return notifyPrepared(spell, true);
    if (p.action !== ACTION.PREPARE) return cast(spell, phrase, { refuse: 'Невозможно подготовить способность' });
    log(`"${phrase}" -> подготовка ${spell.name}`);
    const from = Date.now();
    if (!dispatchCast(spell, ACTION.PREPARE, profile)) return cast(spell, phrase, { refuse: 'Поток ввода недоступен' });
    awaitingSlot = { spell, phrase, from, profile, prepareOnly: true, unconfirmed: !!p.unconfirmed, timer: null };
    return;
  }
  // Есть данные от Dota: собираем и ждём, пока способность появится в слоте (см. checkSlot).
  // Вслепую остаётся только фиксированная пауза castDelayMs.
  if (p.action === ACTION.INVOKE && gsi && Date.now() - gsi.at < 5000) {
    log(`"${phrase}" -> ${spell.name}: Invoke, жду появления в слоте`);
    const from = Date.now();
    if (!dispatchCast(spell, ACTION.PREPARE, profile)) return cast(spell, phrase, { refuse: 'Поток ввода недоступен' });
    awaitingSlot = { spell, phrase, from, profile, timer: null };
    return;
  }
  const how = { [ACTION.SLOT1]: 'уже в слоте 1', [ACTION.SLOT2]: 'уже в слоте 2', [ACTION.INVOKE]: 'Invoke + слот 1' }[p.action];
  press(spell, phrase, p.action, how, profile);
}

// ---------- Ожидание способности в слоте после Invoke ----------
// Из-за пинга способность появляется в слоте не сразу. Клавишу слота нажимаем, только когда
// пакет GSI показал её там, — а не через фиксированную паузу.
let awaitingSlot = null; // { spell, phrase, from, timer }

function notifyPrepared(spell, confirmed) {
  const displaySpell = SPELLS.find(s => s.id === (spell.base || spell.id)) || spell;
  log(confirmed ? 'Подготовлено:' : 'Invoke отправлен без подтверждения GSI:', displaySpell.name);
  broadcast({ ...last, event: confirmed ? 'prepared' : 'prepare-unconfirmed', spell: displaySpell });
}

function checkSlot() {
  if (!awaitingSlot || activeCast || !gsi || !last?.state.enabled) return;
  const { spell, phrase, from, timer, profile, prepareOnly } = awaitingSlot;
  if (gsi.at < from) return;
  const id = spell.base || spell.id;
  const slot = gsi.slots.indexOf(id);
  if (slot < 0) return;
  clearTimeout(timer);
  awaitingSlot = null;
  if (prepareOnly) {
    predicted = null;
    busyUntil = Date.now() + getTiming(config, profile).chainGapMs;
    notifyPrepared(spell, true);
    return pump();
  }
  const own = gsi.abilities[id];
  if (own && own.cooldown > 0) {
    cast(spell, phrase, { refuse: `${spell.name} на перезарядке (${Math.ceil(own.cooldown)} сек)` });
    return pump();
  }
  press(spell, phrase, slot === 1 ? ACTION.SLOT2 : ACTION.SLOT1, `в слоте ${slot + 1} через ${Date.now() - from} мс`, profile);
}

function slotTimeout() {
  const { spell, phrase } = awaitingSlot;
  awaitingSlot = null;
  cast(spell, phrase, { refuse: `${spell.name} не появилась в слоте` });
  pump();
}

function press(spell, phrase, action, how, profile) {
  log(`"${phrase}" -> ${spell.name} (${how})${queue.length ? `, дальше в очереди: ${queue.length}` : ''}`);
  if (!dispatchCast(spell, action, profile)) return cast(spell, phrase, { refuse: 'Поток ввода недоступен' });
  if (gsi) {
    const pr = prediction() || { slots: [...gsi.slots], used: new Set(), invoked: false };
    const id = spell.base || spell.id;
    if (action === ACTION.INVOKE) {
      pr.slots = [id, ...pr.slots.filter((x) => x !== id)].slice(0, 2);
      pr.invoked = true;
    }
    pr.used.add(id);
    pr.after = Infinity;
    predicted = pr;
  }
  // Положение курсора для плашки способности (подходит и для OBS)
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
    phraseCatalog: allPhrases,
    disabledPhrases: exclusions(userConfig.disabledPhrases||config.disabledPhrases, allPhrases),
    itemPhrases: userConfig.itemPhrases||{},
    dictionaryReady: !!modelWords,
    itemSlots: ITEM_SLOTS.map(({id,name,key})=>({id,name,key})),
    firstRun: !userConfig.keys,
    experimentalFrames: userConfig.experimentalFrames === true,
    testOnly: userConfig.testOnly === true,
    slotCastModes: userConfig.slotCastModes || {},
  };
}

// Берём из присланного только известные поля с допустимыми значениями и дописываем их
// в config.json, не трогая остальное (свои фразы, паузы и т.д.)
function saveSettings(body) {
  const out = { ...userConfig };
  const keys = {};
  for (const n of KEY_NAMES) if (okKey(body.keys?.[n])) keys[n] = body.keys[n].toUpperCase();
  for (const n of ITEM_KEYS) if (body.keys?.[n]===''||okKey(body.keys?.[n])) keys[n]=body.keys[n].toUpperCase();
  out.keys = { ...config.keys, ...keys };
  if (okKey(body.voiceChatKey)) out.voiceChatKey = body.voiceChatKey.toUpperCase();
  if (['click', 'quickcast'].includes(body.castMode)) out.castMode = body.castMode;
  if (['hold', 'always'].includes(body.listen)) out.listen = body.listen;
  if (typeof body.microphone === 'string') out.microphone = body.microphone.slice(0, 200);
  if (Array.isArray(body.blockKeys)) out.blockKeys = body.blockKeys.filter((n) => KEY_NAMES.includes(n));
  if (body.disabledPhrases !== undefined) out.disabledPhrases = exclusions(body.disabledPhrases, allPhrases);
  if (typeof body.experimentalFrames === 'boolean') out.experimentalFrames = body.experimentalFrames;
  if (typeof body.testOnly === 'boolean') out.testOnly = body.testOnly;
  if (body.slotCastModes && typeof body.slotCastModes === 'object') out.slotCastModes = Object.fromEntries(Object.entries(body.slotCastModes).filter(([k,v])=>['slot1','slot2',...ITEM_KEYS].includes(k)&&['click','quickcast'].includes(v)));
  // Check the proposed configuration as a whole; disabled spell aliases can be reused.
  const reserved=enabledPhrases(allPhrases,exclusions(out.disabledPhrases,allPhrases),EXTRA_PHRASES,true);
  if(body.itemPhrases!==undefined || out.itemPhrases!==undefined)out.itemPhrases=validateItemPhrases(body.itemPhrases??out.itemPhrases,modelWords,reserved).phrases;
  delete out.itemCastModes;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + '\n');
  userConfig = out;
  log('Настройки сохранены в config.json');
}

let repairingGsi=false;
async function repairGsi(){
  if(repairingGsi)return {ok:false,error:'Восстановление уже выполняется'};
  repairingGsi=true;
  const run=folder=>new Promise((resolve,reject)=>{
    const args=['-NoProfile','-NonInteractive','-File',path.join(__dirname,'setup-dota.ps1'),'-NoPrompt'];
    if(folder)args.push('-DotaPath',folder);
    execFile('powershell.exe',args,{cwd:__dirname,windowsHide:true,timeout:30000},(error,stdout,stderr)=>{
      if(error)reject(new Error(String(stderr||stdout||error.message)));else resolve();
    });
  });
  try {
    const confirm=await dialog.showMessageBox({type:'question',buttons:['Восстановить','Отмена'],defaultId:1,cancelId:1,title:'Voice Invoker',message:'Проверить и восстановить только файл GSI Voice Invoker?',detail:'Steam и Dota не будут закрыты, личные бинды и параметры Steam не изменяются.'});
    if(confirm.response!==0)return {ok:false,error:'Отменено'};
    try {await run();}catch(e){
      if(!e.message.includes('DOTA_NOT_FOUND'))throw e;
      const choice=await dialog.showOpenDialog({title:'Выбери папку установки Dota 2 (с папкой game)',properties:['openDirectory']});
      if(choice.canceled||!choice.filePaths[0])return {ok:false,error:'Папка не выбрана'};
      await run(choice.filePaths[0]);
    }
    return {ok:true,message:'GSI проверен. Если игра была открыта, перезапусти Dota для загрузки файла.'};
  }catch(e){log('Ошибка восстановления GSI:',e.message);return {ok:false,error:'Не удалось восстановить GSI. Проверь журнал и разрешения Windows; при блокировке скрипта используй start.bat.'};}
  finally{repairingGsi=false;}
}
async function diagnostics() {
  let installed = false, cfgMatches = false, itemsConfigured = false, dotaFound = false;
  const process = await processStatus();
  try {
    const record = JSON.parse(fs.readFileSync(path.join(__dirname,'.dota-install.json'),'utf8').replace(/^\uFEFF/,''));
    installed = fs.existsSync(record.target);
    const game=path.resolve(path.dirname(record.target),'..','..','..');
    dotaFound=fs.existsSync(path.join(game,'bin','win64','dota2.exe'));
    if (installed) {
      const raw=fs.readFileSync(record.target,'utf8');
      cfgMatches=raw.includes('http://127.0.0.1:'+config.port+'/gsi')&&raw.includes('"'+config.authToken+'"');
      itemsConfigured=/"items"\s*"1"/.test(raw);
    }
  } catch {}
  return {version:require('./package.json').version, dotaFound, ...process, itemsConfigured, gsiInstalled:installed, gsiConfigMatches:cfgMatches, gsiAgeMs:gsi?Date.now()-gsi.at:null, hero:gsi?.hero||null, modelVerified:modelInfo.active, experimentalActive:!!experimental, voiceReady:voiceInfo.ready, hookReady:!!hookThreadId, enabled:!!last?.state.enabled, profile:last?.state.timingProfile||config.timingProfile, port:config.port, serverReady, testOnly, lastTest, activePhrases:Object.keys(phraseToSpell).length};
}
let settingsWin = null;
function openSettings() {
  if (shutdown || !serverReady) return;
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    return settingsWin.focus();
  }
  settingsWin = new BrowserWindow({
    width: 640, height: 760, minWidth: 480, title: 'Voice Invoke — настройки',
    backgroundColor: '#0b0e11', autoHideMenuBar: true, alwaysOnTop: true,
  });
  settingsWin.setMenu(null);
  settingsWin.loadURL(`http://localhost:${config.port}/settings`).catch(e => log('Не удалось открыть настройки:', e.message));
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
  if (p === '/sounds/keys.wav') return sendFile(res, path.join(__dirname, 'keys.wav'), 'audio/wav');
  if (p === '/vosk.js') return sendFile(res, require.resolve('vosk-browser/dist/vosk.js'), 'text/javascript');
  if (p === '/voice-capture.js') return sendFile(res, path.join(__dirname, 'voice-capture.js'), 'text/javascript');
  if (p === '/phrase-parser.js') return sendFile(res, path.join(__dirname, 'phrase-parser.js'), 'text/javascript');
  if (p === '/settings') return sendFile(res, path.join(__dirname, 'settings.html'), 'text/html; charset=utf-8');
  if (p === '/repair-gsi' && req.method === 'POST' && String(req.headers['content-type']||'').startsWith('application/json')) {
    res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(await repairGsi()));
  }
  if (p === '/open-logs' && req.method === 'POST' && String(req.headers['content-type']||'').startsWith('application/json')) {
    await shell.openPath(__dirname);return done();
  }
  if (p === '/import-bindings' && req.method === 'POST' && String(req.headers['content-type']||'').startsWith('application/json')) {
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    try {return res.end(JSON.stringify({ok:true,...importBindings()}));} catch(e){return res.end(JSON.stringify({ok:false,error:String(e.message).slice(0,180)}));}
  }
  if (p === '/diagnostics' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
    return res.end(JSON.stringify(await diagnostics()));
  }
  if (p === '/dictionary' && req.method === 'GET') {
    const q=(new URL(req.url,'http://localhost').searchParams.get('q')||'').trim().toLowerCase().slice(0,100);
    const matches=[];if(modelWords&&q.length>=2)for(const word of modelWords){if(word.startsWith(q))matches.push(word);if(matches.length>=30)break;}
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ready:!!modelWords,exact:!!modelWords?.has(q),matches}));
  }
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
      return requestShutdown(true);
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
    if (shutdown) return done();
    const { text, texts } = await readJson(req);
    if (testOnly) {
      lastTest = {...lastTest,matched:(Array.isArray(texts)?texts:[text]).map(t=>String(t||'').slice(0,200)).slice(0,20), at:Date.now()};
      return done();
    }
    for (const t of Array.isArray(texts) ? texts : [text]) castByPhrase(String(t || '').trim().toLowerCase());
    return done();
  }
  if (req.method === 'POST' && p === '/voice-test-result') {
    if(testOnly){const {transcript}=await readJson(req);lastTest={...lastTest,transcript:String(transcript||'').slice(0,400),at:Date.now()};}
    return done();
  }
  if (req.method === 'POST' && p === '/voice-status') {
    const { ready, message } = await readJson(req);
    if (message) log('Голос:', message);
    voiceReady = !!ready;
    voiceInfo = {ready:voiceReady,message:String(message||'')};
    toHook(WM_APP_VOICE_READY, voiceReady ? 1 : 0);
    return done();
  }
  res.writeHead(404);
  res.end();
});
setInterval(() => clients.forEach((res) => res.write(': ping\n\n')), 15000);

// ---------- Хук клавиатуры ----------
function startWorker() {
  if (shutdown) return;
  const worker = hookWorker = new Worker(path.join(__dirname, 'hook-worker.js'), { workerData: { config: testOnly ? {...config,blockKeys:[]} : config } });
  worker.on('message', (m) => {
    if (m.type === 'quit-request') return requestShutdown(false);
    if (m.type === 'stopped') {
      if (!m.clean) log('Не удалось подтвердить освобождение всех хуков');
      return;
    }
    if (m.type === 'log') return log(m.text);
    if (m.type === 'cast-complete') return handleCastComplete(m);
    if (m.type === 'step' && config.debugSteps) return log('Шаг:', m.edge, m.step, Math.round(m.elapsedMs) + ' мс');
    if (m.type === 'settings') return openSettings();
    if (m.type === 'ready') {
      hookThreadId = m.threadId;
      log('Хук клавиатуры установлен');
      if (shutdown) return toHook(WM_APP_QUIT, 0);
      return toHook(WM_APP_VOICE_READY, voiceReady ? 1 : 0);
    }
    if (m.type === 'state') {
      if (shutdown) return;
      last = { state: m.state };
      if (!m.state.enabled) discardWaiting();
      broadcast({ ...last, event: m.event });
      if (m.event === 'profile') log('Режим задержек:', profileLabel(m.state.timingProfile));
      if (m.event === 'blocked') log('Клавиша заблокирована: способности только голосом');
      if (m.event === 'toggle') log(m.state.enabled ? 'Голосовой каст ВКЛЮЧЁН' : 'Голосовой каст ВЫКЛЮЧЕН');
    }
  });
  worker.on('error', (e) => log('Ошибка потока хука:', e.stack || e));
  worker.on('exit', (code) => {
    hookWorker = null;
    hookThreadId = 0;
    if (shutdown) return finishShutdown();
    log('Поток ввода завершён, код:', code);
    if (activeCast) handleCastComplete({ id: activeCast.id, ok: false, reason: 'Поток ввода завершён', profile: activeCast.profile, elapsedMs: 0 });
  });
}

// Shutdown is cooperative: wait for worker exit, not merely a message or timer.
function requestShutdown(restart = false, code = 0) {
  if (shutdown || exiting) return;
  shutdown = { restart, code, retry: null };
  discardWaiting();
  if (last) {
    last = { state: { ...last.state, enabled: false } };
    broadcast({ ...last, event: 'toggle' });
  }
  if (!hookWorker) return finishShutdown();
  const started = Date.now();
  const request = () => {
    if (!hookWorker) return;
    if (hookThreadId) toHook(WM_APP_QUIT, 0);
    if (Date.now() - started > 5000 && !shutdown.warned) {
      shutdown.warned = true;
      log('Ожидаю завершения потока ввода; принудительное завершение отключено.');
    }
  };
  request();
  shutdown.retry = setInterval(request, 250);
}
function finishShutdown() {
  if (!shutdown || hookWorker || exiting) return;
  exiting = true;
  clearInterval(shutdown.retry);
  for (const client of clients) client.end();
  clients.clear();
  serverReady = false;
  if (tray && !tray.isDestroyed()) tray.destroy();
  // Wait for the listening socket to close before allowing another process.
  const exit = () => {
    try { experimental?.cleanup(); } catch(e) { log('Не удалось удалить временную модель:', e.message); }
    if (shutdown.restart && process.env.VI_SUPERVISED !== '1') {
      app.relaunch({ args: [...process.argv.slice(1).filter(a => a !== '--vi-reopen-settings'), '--vi-reopen-settings'] });
    }
    app.exit(shutdown.restart && process.env.VI_SUPERVISED === '1' ? 75 : shutdown.code);
  };
  server.close(exit);
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
}
app.on('before-quit', (event) => {
  if (!exiting) { event.preventDefault(); requestShutdown(false); }
});

async function createTray() {
  try {
    const icon = await app.getFileIcon(process.execPath, { size: 'small' });
    if (shutdown) return;
    tray = new Tray(icon);
    tray.setToolTip('Voice Invoker — работает');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Настройки', click: openSettings },
      { label: 'Включить / выключить распознавание', click: () => toHook(WM_APP_TOGGLE,0) },
      { label: 'Перезапустить', click: () => requestShutdown(true) },
      { label: 'Открыть журнал', click: () => shell.openPath(LOG_FILE).then(error => { if (error) log(error); }) },
      { label: 'Папка журналов', click: () => shell.openPath(__dirname) },
      { type: 'separator' },
      { label: 'Выйти из Voice Invoker', click: () => requestShutdown(false) },
    ]));
    tray.on('double-click', openSettings);
  } catch (e) { log('Не удалось создать значок в трее:', e.message); }
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
  let recoveries=0;
  win.webContents.on('render-process-gone', () => {
    if(shutdown||win.isDestroyed())return;
    voiceReady=false; voiceInfo={ready:false,message:'Оверлей завершился'}; toHook(WM_APP_VOICE_READY,0); discardWaiting();
    if(++recoveries<=3)setTimeout(()=>{if(!shutdown&&!win.isDestroyed())win.reload();},1000);
    else log('Оверлей неоднократно завершился; требуется перезапуск');
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
  let retry;
  const load = () => { if (!shutdown && !win.isDestroyed()) win.loadURL(url).catch(() => { if (!shutdown && !win.isDestroyed()) retry = setTimeout(load, 1000); }); };
  load();
  const topTimer = setInterval(() => !win.isDestroyed() && win.moveTop(), 3000);
  win.on('closed', () => { clearInterval(topTimer); clearTimeout(retry); });
}

app.whenReady().then(async () => {
  try {
    const modelSelection = modelInfo = await prepareExpandedModel(MODEL_DIR, userConfig.expandedVocabulary, { log });
    if (modelSelection.active) RU_PATH = modelSelection.file;
    log('Vosk:', modelSelection.active ? 'Invoker V2 (SHA-256 OK)' : 'stock ru-0.22; expanded model: ' + modelSelection.reason);
    await ensureModel();
    try {modelWords=readModelWords(RU_PATH);log('Словарь модели:',modelWords.size,'слов');}catch(e){log('Словарь предметов недоступен:',e.message);}
    configurePhrases(modelSelection.active);
    if (config.experimentalFrames === true && modelSelection.active) {
      try { experimental=experimentalModel(RU_PATH); RU_PATH=experimental.file; log('Экспериментальная модель: frames-per-chunk=3'); }
      catch(e) { log('Экспериментальная модель недоступна, использую обычную V2:',e.message); }
    }
  } catch (e) {
    log('Не удалось подготовить модель распознавания, голос работать не будет:', e.message);
  }
  if (shutdown) return;
  if (skipped.length) log(`Фразы не по-русски пропущены (слушает только русская модель): ${skipped.join(', ')}`);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`Порт ${config.port} уже занят (плагин уже запущен или порт занят другой программой).`);
      log('Проверь владельца порта: Get-NetTCPConnection -LocalPort ' + config.port + ' -State Listen');
      dialog.showErrorBox('Voice Invoker: порт занят', 'Порт ' + config.port + ' уже используется. Закрой предыдущий Voice Invoker или проверь владельца порта. Порт автоматически не меняется.');
    } else log('Ошибка сервера:', e.message);
    requestShutdown(false, 1);
  });
  server.listen(config.port, '127.0.0.1', () => {
    if (shutdown) return;
    serverReady = true;
    const k = config.keys;
    log(`Голосовой каст запущен. Оверлей для OBS: http://localhost:${config.port}/overlay.html`);
    log(`Сферы ${k.quas}/${k.wex}/${k.exort}, Invoke ${k.invoke}, слоты ${k.slot1}/${k.slot2}, каст: ${config.castMode}`);
    log(config.listen === 'always' || !config.voiceChatKey
      ? 'Слушаю микрофон постоянно'
      : `Слушаю, пока зажата клавиша голосового чата ${String(config.voiceChatKey).toUpperCase()}`);
    log('Ctrl+Shift+F7 — вкл/выкл, Ctrl+Shift+F8 — выход, Ctrl+Shift+F9 — настройки клавиш, Ctrl+Shift+F10 — обычный режим, Ctrl+Shift+F11 — ускоренный, Ctrl+Shift+F12 — турбо');
    startWorker();
    createWindow();
    createTray();
    if (firstRun || settingsRequested) { settingsRequested = false; openSettings(); }
  });
});
app.on('window-all-closed', () => requestShutdown(false));
