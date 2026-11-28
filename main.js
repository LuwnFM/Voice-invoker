// Голосовой каст Инвокера: говоришь название способности — она собирается и применяется.
// Хук клавиатуры и нажатия — в отдельном потоке (hook-worker.js), распознавание речи —
// офлайн через Vosk в окне оверлея, состояние способностей — из Dota GSI.
const { app, BrowserWindow, screen, session, Tray, Menu, dialog, shell, clipboard, nativeImage } = require('electron');
const { Worker } = require('worker_threads');
// Acquire before touching logs, model or native hooks. Same app name across releases.
if (!app.requestSingleInstanceLock()) {
  console.log('Voice Invoker уже запущен. Открываю настройки существующего экземпляра.');
  app.exit(0);
} else {
let settingsRequested = process.env.VI_REOPEN_SETTINGS === '1' || process.argv.includes('--vi-reopen-settings');
let serverReady = false;
let tray = null;
let trayStateKey='', diagnosticsAutoOpened=false, voiceEverReady=false, fatalShown=false;
let setupFailedAtStartup=process.env.VI_SETUP_FAILED==='1', startupDiagnosticTimer=null;
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
const { ITEM_KEYS, ITEM_SLOTS, readInventory, planItem, validateItemCastModes, namedItemTargets } = require('./items');
const { readModelWords, checkDictionary } = require('./model-words');
const { resolveCommands } = require('./custom-commands');
const { importBindings } = require('./dota-bindings');
const { processStatus, supportReport, bindingSignature } = require('./diagnostics');
const {bindingUpdate,watchBindingFile,BUFFER_SIZE,writeBindingUpdate}=require('./binding-sync');
const { allowedHost, allowedOrigin, jsonContentType, readJson } = require('./local-http');
const { validateKeys } = require('./key-validation');
const { saveJsonAtomic } = require('./config-storage');
const { ACTION, vkOf, SELECT_HERO_ACTION } = require('./logic');
const { decodeVoiceCommand } = require('./phrase-parser');
const { normalizeProfile, getTiming, encodeCast, MAX_CAST_ID, profileLabel } = require('./timing-profiles');
const { WM_APP_VOICE_READY, WM_APP_CAST, WM_APP_QUIT, WM_APP_TOGGLE, WM_APP_BINDINGS } = require('./messages');

/** @type {{port:number,authToken:string,keys:Record<string,string>,voiceChatKey:string,blockKeys:string[],listen:string,castMode:string,timingProfile:string,keyDelayMs:number,castDelayMs:number,slotWaitMs:number,clickDelayMs:number,altDelayMs:number,chainGapMs:number,microphone:string,windowTitle:string,phrases:Record<string,string[]>,acceptInjected:boolean,debugSteps:boolean,experimentalFrames?:boolean,testOnly?:boolean,disabledPhrases?:Record<string,string[]>,customSpellPhrases?:Record<string,string[]>,itemPhrases?:Record<string,string[]>,expandedVocabulary?:boolean,slotCastModes?:Record<string,string>,itemCastModes?:Record<string,string>,namedItemPhrases?:Record<string,string[]>,syncedItemCastModes?:Record<string,string>,autoSyncBindings?:boolean,syncQuickcast?:boolean}} */
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
  autoSyncBindings:true,syncQuickcast:true,
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
const { catalog, exclusions, mergeCatalog } = require('./phrase-preferences');
const { experimentalModel } = require('./experimental-model');
const {initializeUserData}=require('./user-data');
let DATA_DIR;
try {DATA_DIR=initializeUserData(__dirname);}
catch(e){
 dialog.showErrorBox('Voice Invoker — ошибка данных','Не удалось открыть папку пользовательских данных: '+e.message+'\nСтарые настройки не удалены.');
 process.exit(1);
}
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
/** User configuration is extensible JSON; accepted settings are validated before saving. @type {Record<string, any>} */
let userConfig = {};
let configInvalid=false, configBackup=false;
try {
  const loaded=JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/,''));
  if(!loaded||typeof loaded!=='object'||Array.isArray(loaded))throw Error('Invalid settings object');
  userConfig=loaded;
  Object.assign(config, userConfig, {
    keys: { ...config.keys, ...(userConfig.keys || {}) },
    phrases: mergeCatalog(config.phrases,userConfig.phrases),
  });
} catch (e) {
  if (e.code !== 'ENOENT') {
    configInvalid=true;userConfig={};
    try {fs.copyFileSync(CONFIG_FILE,CONFIG_FILE+'.broken',fs.constants.COPYFILE_EXCL);configBackup=true;}catch {configBackup=fs.existsSync(CONFIG_FILE+'.broken');}
    console.error('config.json не прочитан:', e.message);
  }
}
// Клавиши ещё ни разу не настраивались — при запуске откроем окно настроек
const firstRun = !userConfig.keys;

const { prepareExpandedModel } = require('./model-selection');
const MODEL_DIR = path.join(__dirname, 'model');
const RU_NAME = 'vosk-model-small-ru-0.22';
const RU_URL = `https://alphacephei.com/vosk/models/${RU_NAME}.zip`;
let RU_PATH = path.join(MODEL_DIR, RU_NAME + '.tar.gz');
const phraseToSpell = Object.create(null);
const skipped = [];
const allPhrases = catalog(Object.fromEntries(Object.entries(config.phrases).filter(([id])=>SPELLS.some(s=>s.id===id))), EXTRA_PHRASES);
let modelWords=null;
let modelInfo = { active: false, reason: 'initializing' }, experimental = null;
let voiceInfo = {ready:false, message:''}, lastTest = null;
const testOnly = config.testOnly === true;

// Build the command set only after the local/downloaded model has been selected.
function configurePhrases(useExpanded) {
  const commands=resolveCommands(allPhrases,EXTRA_PHRASES,config,modelWords,useExpanded,{strict:false});
  config.phrases=commands.active;
  const isRussian = (phrase) => /[а-яё]/i.test(phrase);
  if(commands.errors.length)log('Пропущенные пользовательские фразы:',commands.errors.join('; '));
  for (const s of [...SPELLS, ...ITEM_SLOTS,...namedItemTargets(commands.namedItemPhrases)]) {
    for (const p of config.phrases[s.id] || []) {
      if (isRussian(p) || 'itemSlot' in s || 'itemName' in s || commands.customSpellPhrases[s.id]?.includes(p)) phraseToSpell[p.toLowerCase()] = s.id;
      else skipped.push(p);
    }
  }
}

// Лог идёт в консоль и в файл log.txt (перезаписывается при каждом запуске)
const LOG_FILE = path.join(DATA_DIR, 'log.txt');
try {
  if (fs.existsSync(LOG_FILE)) fs.copyFileSync(LOG_FILE, path.join(DATA_DIR, 'log.previous.txt'));
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
let gsiRejectedAt = null;


function handleGsi(data) {
  if (config.authToken && data?.auth?.token !== config.authToken) {
    gsiRejectedAt = Date.now();
    return;
  }
  gsiRejectedAt = null;
  const abilities = {};
  const slots = [];
  // Порядок ability0..N совпадает с порядком на панели: два слота способностей идут
  // после сфер (invoker_empty1/2, пока слот пуст)
  const keys = Object.keys(data.abilities || {}).sort((a, b) => parseInt(a.slice(7)) - parseInt(b.slice(7)));
  for (const k of keys) {
    const a = data.abilities[k];
    if (!a || !a.name) continue;
    abilities[a.name] = a;
    if ((a.name.startsWith('invoker_empty') || SPELLS.some((s) => s.id === a.name)) && slots.length<2) slots.push(a.name);
  }
  if (!gsi || Date.now()-gsi.at>30000) {log('Данные от Dota получены (GSI работает)');void watchBindings(true);}
  gsi = {
    at: Date.now(),
    hero: data.hero?.name || null,
    alive: data.hero?.alive === true,
    selected: typeof data.hero?.selected_unit==='boolean'?data.hero.selected_unit:null,
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
  if (spell.itemSlot||spell.itemName) return planItem(spell,gsi,config,prepareOnly,Date.now());
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
let lastClickAt=null,lastSelectAt=null,selectionTimer=null;
// Selection packets are optional in GSI. Only use explicit booleans; never infer
// selection from the hero name or treat missing data as a different hero.
function selectionStatus(now){
  return gsi&&now-gsi.at<5000&&gsi.hero==='npc_dota_hero_invoker'&&gsi.alive===true?gsi.selected:null;
}
function ensureSelection(entry,profile,resume){
  const now=Date.now(),selected=selectionStatus(now);
  const freshHero=gsi&&now-gsi.at<5000&&gsi.hero;
  const wrongHero=!!freshHero&&freshHero!=='npc_dota_hero_invoker';
  clearTimeout(selectionTimer);selectionTimer=null;
  const delay=ms=>{selectionTimer=setTimeout(resume,ms);return {wait:true};};
  if(selected===true&&(lastClickAt===null||gsi.at>lastClickAt)){lastClickAt=null;}
  if(entry.selectionAt!==undefined){
    if(now<busyUntil)return delay(busyUntil-now);
    if(selected===true&&gsi.at>entry.selectionAt){lastClickAt=null;return {};}
    if(entry.confirmHero&&freshHero==='npc_dota_hero_invoker'&&gsi.alive===true&&selected!==false&&gsi.at>entry.selectionAt){lastClickAt=null;return {};}
    if(selected===false||entry.confirmSelection||entry.confirmHero||wrongHero){
      if(now<entry.selectionAt+1000)return delay(50);
      return {refuse:'Инвокер не выбран после восстановления; выбери героя вручную'};
    }
    // Older clients omit selected_unit. One confirmed key dispatch, no retry loop.
    lastClickAt=null;return {};
  }
  if(selected!==false&&lastClickAt===null)return {};
  if(!vkOf(config.keys?.selectHero)){
    if(selected===false)return {refuse:'Инвокер не выбран; назначь клавишу «Выбрать героя» в настройках'};
    return {}; // legacy config without a verified selection key
  }
  // Avoid double-tapping the selection key (which can center the camera).
  if(lastSelectAt!==null&&now-lastSelectAt<450)return delay(450-(now-lastSelectAt));
  entry.selectionAt=now;entry.confirmSelection=selected===false;entry.confirmHero=!!wrongHero;
  if(!dispatchCast(entry.spell,SELECT_HERO_ACTION,profile))return {refuse:'Не удалось восстановить выбор Инвокера'};
  lastSelectAt=now;
  return {wait:true};
}
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
  if (!toHook(WM_APP_CAST, (action===SELECT_HERO_ACTION?1:spell.itemSlot ? SPELLS.length + spell.itemSlot : SPELLS.indexOf(spell) + 1), encodeCast(action, profile, id))) return false;
  activeCast = { id, spell, action, profile, timedOut: false, watchdog: null };
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
  lastCastStatus=m.ok?'sent':'failed';
  if(m.clicked===true||m.selectionRisk===true)lastClickAt=Date.now();
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
  if(finished.action===SELECT_HERO_ACTION){
    busyUntil=Date.now()+60;
    log('Восстановление выбора Инвокера: клавиша отправлена');
    if(awaitingSlot)checkSlot();else pump();
    return;
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
  clearTimeout(selectionTimer);selectionTimer=null;
  if (awaitingSlot) clearTimeout(awaitingSlot.timer);
  awaitingSlot = null;
  clearTimeout(pumpTimer);
  pumpTimer = null;
  gsiWaitUntil = 0;
}

function castByPhrase(command) {
  const { phrase, prepareOnly } = decodeVoiceCommand(command);
  const id=phraseToSpell[phrase];
  const spell = SPELLS.find(s=>s.id===id) || ITEM_SLOTS.find(s=>s.id===id) || (id?.startsWith('item_')?{id,name:id,itemName:id}:null);
  if (!spell) return;
  if (!last || !last.state.enabled || !last.state.voiceReady || activeCast?.timedOut) return;
  if(queue.length>=32)return;
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
  if (!last?.state.enabled || !last.state.voiceReady) { discardWaiting(); return; }
  while (queue.length && !awaitingSlot && !activeCast) {
    const now = Date.now();
    if (now < busyUntil) {
      pumpTimer = setTimeout(pump, busyUntil - now);
      return;
    }
    const entry=queue[0];
    const { spell, phrase, at, prepareOnly } = entry;
    if (now - at > QUEUE_TTL_MS) {
      queue.shift();
      log(`"${phrase}" -> пропущено: слишком долго ждало в очереди`);
      continue;
    }
    const profile=normalizeProfile(last?.state.timingProfile || config.timingProfile);
    const selection=ensureSelection(entry,profile,pump);
    if(selection.wait)return;
    if(selection.refuse){queue.shift();cast(spell,phrase,selection,profile,prepareOnly);continue;}
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
    cast(spell, phrase, p, profile, prepareOnly);
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
    log('Предмет: '+(spell.itemName||gsi?.items?.[p.itemSlot-1]?.name||item.name)+' / '+item.name+' / '+(p.action===ACTION.SLOT1?'обычный каст':'Quickcast'));
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
  if (p.action === ACTION.INVOKE && gsi?.hero && Date.now() - gsi.at < 5000) {
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
  if (!awaitingSlot || activeCast || !gsi || !last?.state.enabled || !last.state.voiceReady) return;
  const { spell, phrase, from, timer, profile, prepareOnly } = awaitingSlot;
  if (gsi.at < from) return;
  // When the unit was deselected during Invoke, restore selection before
  // interpreting the slot list; an enemy packet may have no Invoker slots.
  if(!prepareOnly&&(gsi.selected===false||awaitingSlot.selectionAt!==undefined||(lastClickAt!==null&&gsi.hero!=='npc_dota_hero_invoker'))){
    const selection=ensureSelection(awaitingSlot,profile,checkSlot);
    if(selection.wait)return;
    if(selection.refuse){clearTimeout(timer);awaitingSlot=null;cast(spell,phrase,selection,profile);return pump();}
  }
  if(gsi.hero!=='npc_dota_hero_invoker'||gsi.alive!==true||(!prepareOnly&&spell.needsScepter&&gsi.scepter===false)){
    clearTimeout(timer);awaitingSlot=null;
    cast(spell,phrase,{refuse:'Состояние героя изменилось после Invoke'});return pump();
  }
  const id = spell.base || spell.id;
  const slot = gsi.slots.indexOf(id);
  if (slot < 0) return;
  if(!prepareOnly&&awaitingSlot.selectionAt===undefined){
    const selection=ensureSelection(awaitingSlot,profile,checkSlot);
    if(selection.wait)return;
    if(selection.refuse){clearTimeout(timer);awaitingSlot=null;cast(spell,phrase,selection,profile);return pump();}
  }
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
  if(own?.can_cast===false){cast(spell,phrase,{refuse:spell.name+': нельзя применить'});return pump();}
  press(spell, phrase, slot === 1 ? ACTION.SLOT2 : ACTION.SLOT1, `в слоте ${slot + 1} через ${Date.now() - from} мс`, profile);
}

function slotTimeout() {
  if(!awaitingSlot)return;
  const { spell, phrase } = awaitingSlot;
  awaitingSlot = null;clearTimeout(selectionTimer);selectionTimer=null;predicted=null;
  if(selectionStatus(Date.now())!==true)lastClickAt=Date.now();
  log('Invoke не подтверждён:',gsi?`GSI ${Date.now()-gsi.at} мс; выделение ${gsi.selected??'неизвестно'}; Invoke cooldown ${gsi.abilities?.invoker_invoke?.cooldown??'неизвестно'}`:'нет GSI');
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
    keys: {...config.keys,...userConfig.keys},
    voiceChatKey: userConfig.voiceChatKey??config.voiceChatKey,
    castMode: userConfig.castMode??config.castMode,
    listen: userConfig.listen??config.listen,
    blockKeys: userConfig.blockKeys??config.blockKeys??[],
    microphone: userConfig.microphone??config.microphone??'',
    phraseCatalog: allPhrases,
    customSpellPhrases: userConfig.customSpellPhrases||{},
    disabledPhrases: exclusions(userConfig.disabledPhrases||config.disabledPhrases, mergeCatalog(allPhrases,userConfig.customSpellPhrases)),
    itemPhrases: userConfig.itemPhrases||{},namedItemPhrases:userConfig.namedItemPhrases||{},
    dictionaryReady: !!modelWords,
    itemSlots: ITEM_SLOTS.map(({id,name,key})=>({id,name,key})),
    firstRun: !userConfig.keys,
    experimentalFrames: userConfig.experimentalFrames === true,
    testOnly: userConfig.testOnly === true,
    slotCastModes: userConfig.slotCastModes || {},
    autoSyncBindings:userConfig.autoSyncBindings!==false,syncQuickcast:userConfig.syncQuickcast!==false,bindingNotifications:userConfig.bindingNotifications!==false,bindingGeneration,
    itemCastModes: userConfig.itemCastModes || {},
  };
}

// Берём из присланного только известные поля с допустимыми значениями и дописываем их
// в config.json, не трогая остальное (свои фразы, паузы и т.д.)
function saveSettings(body) {
  if(bindingInFlight||bindingPending)throw Error('Подожди завершения синхронизации клавиш.');
  if(body.bindingGeneration!==undefined&&body.bindingGeneration!==bindingGeneration)throw Error('Клавиши изменились. Считай их заново перед сохранением.');
  const out = { ...userConfig };
  for(const k of ['autoSyncBindings','syncQuickcast','bindingNotifications'])if(typeof body[k]==='boolean')out[k]=body[k];
  const keys = {};
  for (const n of KEY_NAMES) if (okKey(body.keys?.[n])) keys[n] = body.keys[n].toUpperCase();
  for (const n of [...ITEM_KEYS,'selectHero']) if (body.keys?.[n]===''||okKey(body.keys?.[n])) keys[n]=body.keys[n].toUpperCase();
  out.keys = { ...config.keys, ...userConfig.keys, ...keys };
  if (okKey(body.voiceChatKey)) out.voiceChatKey = body.voiceChatKey.toUpperCase();
  validateKeys(out.keys,out.voiceChatKey||config.voiceChatKey);
  if (['click', 'quickcast'].includes(body.castMode)) out.castMode = body.castMode;
  if (['hold', 'always'].includes(body.listen)) out.listen = body.listen;
  if (typeof body.microphone === 'string') out.microphone = body.microphone.slice(0, 200);
  if (Array.isArray(body.blockKeys)) out.blockKeys = body.blockKeys.filter((n) => KEY_NAMES.includes(n));
  if (body.disabledPhrases !== undefined) out.disabledPhrases = body.disabledPhrases;
  if (body.customSpellPhrases !== undefined) out.customSpellPhrases = body.customSpellPhrases;
  if (typeof body.experimentalFrames === 'boolean') out.experimentalFrames = body.experimentalFrames;
  if (typeof body.testOnly === 'boolean') out.testOnly = body.testOnly;
  if (body.slotCastModes && typeof body.slotCastModes === 'object') out.slotCastModes = Object.fromEntries(Object.entries(body.slotCastModes).filter(([k,v])=>['slot1','slot2',...ITEM_KEYS].includes(k)&&['click','quickcast'].includes(v)));
  // Validate spell and item preferences together before writing anything.
  if(body.itemPhrases!==undefined)out.itemPhrases=body.itemPhrases;
  if(body.namedItemPhrases!==undefined)out.namedItemPhrases=body.namedItemPhrases;
  const commands=resolveCommands(allPhrases,EXTRA_PHRASES,out,modelWords,modelInfo.active);
  out.customSpellPhrases=commands.customSpellPhrases;
  out.itemPhrases=commands.itemPhrases;out.namedItemPhrases=commands.namedItemPhrases;
  out.disabledPhrases=commands.disabledPhrases;
  if(body.itemCastModes!==undefined)out.itemCastModes=validateItemCastModes(body.itemCastModes);
  saveJsonAtomic(CONFIG_FILE, out);
  const syncOptionsChanged=out.autoSyncBindings!==userConfig.autoSyncBindings||out.syncQuickcast!==userConfig.syncQuickcast;
  userConfig = out;
  configInvalid=false;
  if(out.autoSyncBindings===false){bindingPending=null;clearTimeout(bindingRetry);}
  else if(syncOptionsChanged){lastBindingSignature=null;bindingWatcher?.refresh();}
  log('Настройки сохранены в config.json');
}

let repairingGsi=false, repairFailed=false, hookFailed=false, hookError='', lastCastStatus=null;
let bindingWatcher=null, watchedBindingFile=null, lastBindingSignature=null, bindingsChanged=false, checkingBindings=false;
let bindingPending=null,bindingInFlight=null,bindingRetry=null,bindingAckTimer=null,bindingGeneration=0,bindingNotice='',latestBindings=null;
const bindingBuffer=new SharedArrayBuffer(BUFFER_SIZE);
async function repairGsi(pick=false){
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
    const choose=async()=>{
      const choice=await dialog.showOpenDialog({title:'Выбери папку установки Dota 2 (с папкой game)',properties:['openDirectory']});
      if(choice.canceled||!choice.filePaths[0])return null;
      let folder=choice.filePaths[0];
      for(let i=0;i<5;i++){
        if(fs.existsSync(path.join(folder,'game','bin','win64','dota2.exe')))return folder;
        const parent=path.dirname(folder);if(parent===folder)break;folder=parent;
      }
      throw Error('INVALID_DOTA_FOLDER');
    };
    if(pick){const folder=await choose();if(!folder)return {ok:false,error:'Папка не выбрана'};await run(folder);}
    else try{await run();}catch(e){
      if(!e.message.includes('DOTA_NOT_FOUND'))throw e;
      const folder=await choose();if(!folder)return {ok:false,error:'Папка не выбрана'};await run(folder);
    }
    repairFailed=false;setupFailedAtStartup=false;
    return {ok:true,message:'GSI проверен. Если игра была открыта, перезапусти Dota для загрузки файла.'};
  }catch(e){repairFailed=true;log('Ошибка восстановления GSI:',e.message);return {ok:false,error:e.message.includes('INVALID_DOTA_FOLDER')?'В выбранной папке не найдена Dota 2.':e.message.includes('Dota moved')?'Привязка GSI осталась к другой папке. Сначала восстанови предыдущую интеграцию через setup-dota.ps1 -Uninstall.':e.message.includes('changed externally')?'GSI изменён вне приложения. Исходный файл сохранён; проверь журнал.':'Не удалось восстановить GSI. Проверь журнал и разрешения Windows; при блокировке скрипта используй start.bat.'};}
  finally{repairingGsi=false;}
}
function bindingAlert(message){
  bindingNotice=message;bindingsChanged=true;updateTray();log(message);
  if(userConfig.bindingNotifications!==false&&tray&&!tray.isDestroyed())try{tray.displayBalloon({title:'Voice Invoker — клавиши Dota',content:message});}catch{}
}
function maybeApplyBindings(){
  clearTimeout(bindingRetry);bindingRetry=null;
  if(shutdown||!bindingPending||bindingInFlight)return;
  if(userConfig.autoSyncBindings===false){bindingPending=null;return;}
  if(activeCast||awaitingSlot||queue.length||!hookThreadId){bindingRetry=setTimeout(maybeApplyBindings,100);return;}
  const patch=bindingPending;bindingPending=null;
  const id=bindingGeneration+1;
  try{
    writeBindingUpdate(bindingBuffer,patch);
    bindingInFlight={id,patch};
    if(last)broadcast({...last,event:'bindings-reset'});
    if(!toHook(WM_APP_BINDINGS,id))throw Error('Поток ввода недоступен');
    bindingAckTimer=setTimeout(()=>fatalError('Синхронизация клавиш',Error('Хук не подтвердил новые клавиши')),4000);
  }catch(e){bindingInFlight=null;bindingAlert('Синхронизация не выполнена: '+e.message);}
}
function applyBindingResult(m){
  if(!bindingInFlight||m.id!==bindingInFlight.id)return;
  clearTimeout(bindingAckTimer);
  const {patch}=bindingInFlight;bindingInFlight=null;
  if(!m.ok){bindingAlert('Синхронизация не выполнена: '+m.reason);maybeApplyBindings();return;}
  Object.assign(config,patch);bindingGeneration=m.id;
  try{
    const out={...userConfig,...patch};saveJsonAtomic(CONFIG_FILE,out);userConfig=out;
    bindingsChanged=false;bindingNotice='Клавиши Dota синхронизированы без перезапуска.';log(bindingNotice);
    if(userConfig.bindingNotifications!==false&&tray&&!tray.isDestroyed())try{tray.displayBalloon({title:'Voice Invoker — клавиши Dota',content:bindingNotice});}catch{}
  }catch(e){bindingAlert('Клавиши применены, но не сохранены: '+e.message);}
  updateTray();maybeApplyBindings();
}
function onBindingRead(bindings){
  if(shutdown)return;
  latestBindings=bindings;
  const signature=bindingSignature(bindings);
  if(!signature||signature===lastBindingSignature)return;
  const first=lastBindingSignature===null;lastBindingSignature=signature;
  if(userConfig.autoSyncBindings===false){if(!first)bindingAlert('Бинды изменились. Автосинхронизация выключена.');return;}
  try{
    if(configInvalid)throw Error('Сначала восстанови повреждённые настройки.');
    const differs=(a,b)=>Object.keys({...a,...b}).some(k=>a?.[k]!==b?.[k]);
    if((userConfig.keys&&differs({...config.keys,...userConfig.keys},config.keys))||(userConfig.voiceChatKey&&userConfig.voiceChatKey!==config.voiceChatKey)||(userConfig.slotCastModes&&differs(userConfig.slotCastModes,config.slotCastModes||{})))throw Error('Есть сохранённые настройки, ожидающие перезапуска.');
    const patch=bindingUpdate(bindings,config,userConfig.syncQuickcast!==false);
    if(!bindingInFlight&&!differs(patch.keys,config.keys)&&patch.voiceChatKey===config.voiceChatKey&&!differs(patch.slotCastModes,config.slotCastModes||{})&&!differs(patch.syncedItemCastModes??config.syncedItemCastModes,config.syncedItemCastModes||{})){bindingPending=null;bindingsChanged=false;return;}
    bindingPending=patch;queue.length=0;bindingsChanged=true;bindingNotice='Ожидается завершение текущего каста.';maybeApplyBindings();
  }catch(e){bindingPending=null;bindingAlert('Бинды не изменены: '+e.message);}
}
async function watchBindings(force=false){
  if(shutdown||checkingBindings)return;
  checkingBindings=true;
  try{
    const proc=await processStatus(force);
    if(shutdown)return;
    // Lifecycle CI uses a private fixture, never a Steam account.
    const file=(process.env.VI_LIFECYCLE_DIR&&process.env.VI_BINDINGS_FILE)||proc.bindingFile||null;
    if(file===watchedBindingFile&&bindingWatcher&&!bindingWatcher.closed){if(force)bindingWatcher.refresh();return;}
    bindingWatcher?.close();bindingWatcher=null;watchedBindingFile=file;lastBindingSignature=null;latestBindings=null;bindingPending=null;
    if(!file)return;
    bindingWatcher=watchBindingFile(file,onBindingRead,e=>{latestBindings=null;lastBindingSignature=null;bindingPending=null;bindingAlert('Не удалось прочитать бинды Dota: '+e.message);});
  }catch(e){bindingAlert('Наблюдение за биндами недоступно: '+e.message);}
  finally{checkingBindings=false;}
}
async function diagnostics(force=false) {
  let installed = false, cfgMatches = false, itemsConfigured = false, dotaFound = false, gsiPath = '', tracked=false;
  const proc = await processStatus(force);
  try {
    const record = JSON.parse(fs.readFileSync(path.join(__dirname,'.dota-install.json'),'utf8').replace(/^\uFEFF/,''));
    if(typeof record.target==='string'&&path.basename(record.target)==='gamestate_integration_voice_invoke.cfg'){
      const game=path.resolve(path.dirname(record.target),'..','..','..');
      if(fs.existsSync(path.join(game,'bin','win64','dota2.exe'))){gsiPath=record.target;dotaFound=true;tracked=true;}
    }
  } catch {}
  if(!dotaFound&&proc.dotaPath){dotaFound=true;gsiPath=path.join(proc.dotaPath,'game','dota','cfg','gamestate_integration','gamestate_integration_voice_invoke.cfg');}
  try {
    installed=!!gsiPath&&fs.existsSync(gsiPath);
    if(installed){const raw=fs.readFileSync(gsiPath,'utf8');cfgMatches=raw.includes('http://127.0.0.1:'+config.port+'/gsi')&&raw.includes('"'+config.authToken+'"');itemsConfigured=/"items"\s*"1"/.test(raw);}
  }catch{}
  const binds=watchedBindingFile?latestBindings:proc.bindings;
  const required=['quas','wex','exort','invoke','slot1','slot2','voice'];
  const bindingMatches=binds ? required.every(k=>!!binds.keys[k]) && Object.entries(binds.keys).every(([key,value])=>(key==='voice'?config.voiceChatKey:config.keys[key])===value) && Object.entries(binds.slotCastModes).every(([key,value])=>(config.slotCastModes?.[key]||(ITEM_KEYS.includes(key)?'quickcast':config.castMode))===value) : null;
  const effectiveSettings={castMode:config.castMode,listen:config.listen,keys:Object.fromEntries([...KEY_NAMES,...ITEM_KEYS,'selectHero'].filter(k=>okKey(config.keys[k])).map(k=>[k,config.keys[k]])),voiceChatKey:okKey(config.voiceChatKey)?config.voiceChatKey:null,slotCastModes:Object.fromEntries(Object.entries(config.slotCastModes||{}).filter(([k,v])=>['slot1','slot2',...ITEM_KEYS].includes(k)&&['click','quickcast'].includes(v))),microphone:config.microphone?'selected':'default',itemCastModes:Object.fromEntries(Object.entries(config.itemCastModes||{}).filter(([k,v])=>/^item_[a-z0-9_]{1,100}$/.test(k)&&['click','quickcast'].includes(v)))};
  const gameName=value=>typeof value==='string'&&/^[a-z0-9_]{1,100}$/i.test(value)?value:null;
  const abilities=gsi?Object.fromEntries(Object.values(gsi.abilities).filter(a=>gameName(a.name)).map(a=>[a.name,{level:Number.isFinite(a.level)?a.level:null,cooldown:Number.isFinite(a.cooldown)?a.cooldown:null,canCast:a.can_cast===true}])):null;
  return {version:require('./package.json').version,electron:process.versions.electron,os:require('node:os').release(),dotaFound,running:proc.running,steamRunning:proc.steamRunning,launchFlag:proc.launchFlag,savedLaunchFlag:proc.savedLaunchFlag,bindingMatches,bindingGeneration,bindingNotice,bindingsChanged,bindingWatching:!!bindingWatcher&&!bindingWatcher.closed,bindingsIssue:binds?null:proc.bindingsIssue,bindingWarningsCount:binds?.warnings.length||0,gsiRejected:gsiRejectedAt!==null&&Date.now()-gsiRejectedAt<15000,local:{gsiPath,tracked,dataDir:DATA_DIR,steamFound:!!proc.steamPath,voiceMessage:voiceInfo.message,hookError,keys:config.keys,voiceChatKey:config.voiceChatKey,slotCastModes:config.slotCastModes||{},bindingWarnings:binds?.warnings||[]},itemsConfigured,gsiInstalled:installed,gsiConfigMatches:cfgMatches,gsiAgeMs:gsi?Date.now()-gsi.at:null,hero:gameName(gsi?.hero),alive:gsi?.alive??null,selected:gsi?.selected??null,slots:gsi?.slots.map(gameName)||null,abilities,items:gsi?.items?.map(x=>gameName(x?.name))||null,modelVerified:modelInfo.active,modelAvailable:fs.existsSync(RU_PATH),modelDictionaryReady:!!modelWords,configInvalid,configBackup,experimentalActive:!!experimental,voiceReady:voiceInfo.ready,voiceFailed:!voiceInfo.ready&&!!voiceInfo.message,hookReady:!!hookThreadId,hookFailed,enabled:!!last?.state.enabled,profile:last?.state.timingProfile||config.timingProfile,port:config.port,serverReady,testOnly,lastTest,activePhrases:Object.keys(phraseToSpell).length,repairFailed,setupFailedAtStartup,lastCastStatus,effectiveSettings};
}
let settingsWin = null;
function openStartupDiagnostics(){
  if(diagnosticsAutoOpened||shutdown||!serverReady)return;
  diagnosticsAutoOpened=true;
  if(!settingsWin||settingsWin.isDestroyed()||!settingsWin.isVisible())openSettings(false);
}
function openSettings(focus=true) {
  void watchBindings(true);
  if (shutdown || !serverReady) return;
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    if(focus){settingsWin.show();return settingsWin.focus();}
    settingsWin.showInactive();return;
  }
  settingsWin = new BrowserWindow({
    width: Math.min(680,screen.getPrimaryDisplay().workAreaSize.width), height: Math.min(880,screen.getPrimaryDisplay().workAreaSize.height), minWidth: 480, title: 'Voice Invoke — настройки',
    backgroundColor: '#0b0e11', autoHideMenuBar: true, alwaysOnTop: true, show:focus, icon: path.join(__dirname,'icon.png'),
  });
  if(!focus)settingsWin.once('ready-to-show',()=>settingsWin?.showInactive());
  settingsWin.setMenu(null);
  settingsWin.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  settingsWin.webContents.on('will-navigate',e=>e.preventDefault());
  settingsWin.loadURL(`http://localhost:${config.port}/settings`).catch(e => log('Не удалось открыть настройки:', e.message));
  settingsWin.on('closed', () => (settingsWin = null));
}

const server = http.createServer((req,res)=>{
  handleRequest(req,res).catch(e=>{
    if(res.headersSent){res.end();return;}
    res.writeHead(e.statusCode||500,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:false,error:e.statusCode?e.message:'Local request failed'}));
    if(!e.statusCode)log('Ошибка HTTP:',e.message);
  });
});
async function handleRequest(req,res){
  if(!allowedHost(req.headers.host,config.port)||!allowedOrigin(req.headers.origin,config.port)){
    res.writeHead(403);return res.end();
  }
  const p = new URL(req.url, 'http://localhost').pathname;
  const done = () => {
    res.writeHead(204);
    res.end();
  };
  if(req.method==='POST'&&p!=='/gsi'&&!jsonContentType(req.headers['content-type'])){res.writeHead(415);return res.end();}
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
  if (p === '/icon.png') return sendFile(res,path.join(__dirname,'icon.png'),'image/png');
  if (p === '/sounds/keys.wav') return sendFile(res, path.join(__dirname, 'keys.wav'), 'audio/wav');
  if (p === '/vosk.js') return sendFile(res, require.resolve('vosk-browser/dist/vosk.js'), 'text/javascript');
  if (p === '/voice-capture.js') return sendFile(res, path.join(__dirname, 'voice-capture.js'), 'text/javascript');
  if (p === '/phrase-parser.js') return sendFile(res, path.join(__dirname, 'phrase-parser.js'), 'text/javascript');
  if (p === '/settings') return sendFile(res, path.join(__dirname, 'settings.html'), 'text/html; charset=utf-8');
  if ((p === '/repair-gsi'||p === '/pick-dota') && req.method === 'POST') {
    res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(await repairGsi(p==='/pick-dota')));
  }
  if (p === '/open-logs' && req.method === 'POST') {
    const error=await shell.openPath(DATA_DIR);if(error){res.writeHead(500);return res.end();}return done();
  }
  if (p === '/import-bindings' && req.method === 'POST') {
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    try {return res.end(JSON.stringify({ok:true,...importBindings(),bindingGeneration}));} catch(e){return res.end(JSON.stringify({ok:false,error:String(e.message).slice(0,180)}));}
  }
  // Visual-only overlay preview: never enters the voice parser, queue or native hook.
  if (p === '/preview-sun-strike' && req.method === 'POST') {
    if (!last || !hookThreadId || shutdown) {res.writeHead(409);return res.end();}
    broadcast({...last,event:'preview',spell:SPELLS.find(s=>s.id==='invoker_sun_strike'),aim:{x:0.5,y:0.5}});
    return done();
  }
  if(p==='/copy-launch-flag'&&req.method==='POST'){clipboard.writeText('-gamestateintegration');return done();}
  if (p === '/copy-report' && req.method === 'POST') {
    clipboard.writeText(supportReport(await diagnostics()));return done();
  }
  if (p === '/diagnostics' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
    return res.end(JSON.stringify(await diagnostics(new URL(req.url,'http://localhost').searchParams.get('refresh')==='1')));
  }
  if (p === '/dictionary' && req.method === 'GET') {
    const q=(new URL(req.url,'http://localhost').searchParams.get('q')||'').trim().toLowerCase().slice(0,100);
    const matches=[];if(modelWords&&q.length>=2)for(const word of modelWords){if(word.startsWith(q))matches.push(word);if(matches.length>=30)break;}
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ready:!!modelWords,exact:!!modelWords?.has(q),matches}));
  }
  if (p === '/dictionary/check' && req.method === 'POST') {
    const body=await readJson(req);
    let result;
    try{result=checkDictionary(modelWords,body.phrases);}catch(e){res.writeHead(400,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:e.message}));}
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify(result));
  }
  if (p === '/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(settingsData()));
  }
  // Только application/json: чужая страница в браузере не сможет отправить такой запрос без CORS
  if (req.method === 'POST' && (p === '/config' || p === '/restart')) {
    if (p === '/restart') {
      done();
      log('Перезапуск с новыми настройками...');
      return requestShutdown(true);
    }
    const body = await readJson(req);
    try {
      saveSettings(body);
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
    if(!voiceReady||bindingPending||bindingInFlight)return done();
    for (const t of (Array.isArray(texts) ? texts : [text]).slice(0,32)) if(typeof t==='string'&&t.length<=200)castByPhrase(t.trim().toLowerCase());
    return done();
  }
  if (req.method === 'POST' && p === '/voice-test-result') {
    if(testOnly){const {transcript}=await readJson(req);lastTest={...lastTest,transcript:String(transcript||'').slice(0,400),at:Date.now()};}
    return done();
  }
  if (req.method === 'POST' && p === '/voice-status') {
    const { ready, message } = await readJson(req);
    if (message) log('Голос:', message);
    voiceReady = ready === true;
    if(!voiceReady){
      discardWaiting();
      if(last){last={state:{...last.state,voiceReady:false}};broadcast({...last,event:'voice'});}
    }
    voiceInfo = {ready:voiceReady,message:String(message||'')};
    if(voiceReady)voiceEverReady=true;
    else if(!voiceEverReady&&message)openStartupDiagnostics();
    toHook(WM_APP_VOICE_READY, voiceReady ? 1 : 0);
    return done();
  }
  res.writeHead(404);
  res.end();
}
setInterval(() => clients.forEach((res) => res.write(': ping\n\n')), 15000);

// ---------- Хук клавиатуры ----------
function startWorker() {
  if (shutdown) return;
  const worker = hookWorker = new Worker(path.join(__dirname, 'hook-worker.js'), { workerData: { config: testOnly ? {...config,blockKeys:[]} : config, bindingBuffer } });
  worker.on('message', (m) => {
    if (m.type === 'quit-request') return requestShutdown(false);
    if (m.type === 'stopped') {
      if (!m.clean) log('Не удалось подтвердить освобождение всех хуков');
      return;
    }
    if (m.type === 'log') return log(m.text);
    if (m.type === 'bindings-applied') return applyBindingResult(m);
    if (m.type === 'cast-complete') return handleCastComplete(m);
    if (m.type === 'step' && config.debugSteps) return log('Шаг:', m.edge, m.step, Math.round(m.elapsedMs) + ' мс');
    if (m.type === 'settings') return openSettings();
    if (m.type === 'ready') {
      hookThreadId = m.threadId;hookFailed=false;hookError='';
      log('Хук клавиатуры установлен');
      if (shutdown) return toHook(WM_APP_QUIT, 0);
      return toHook(WM_APP_VOICE_READY, voiceReady ? 1 : 0);
    }
    if (m.type === 'state') {
      if (shutdown) return;
      last = { state: m.state };
      updateTray();
      if (!m.state.enabled || !m.state.voiceReady) discardWaiting();
      broadcast({ ...last, event: m.event });
      if (m.event === 'profile') log('Режим задержек:', profileLabel(m.state.timingProfile));
      if (m.event === 'blocked') log('Клавиша заблокирована: способности только голосом');
      if (m.event === 'toggle') log(m.state.enabled ? 'Голосовой каст ВКЛЮЧЁН' : 'Голосовой каст ВЫКЛЮЧЕН');
    }
  });
  worker.on('error', (e) => {hookFailed=true;hookError=String(e.message||e);log('Ошибка потока хука:', e.stack || e);fatalError('Нативный хук завершился с ошибкой',e);});
  worker.on('exit', (code) => {
    hookWorker = null;
    hookThreadId = 0;
    if (shutdown) return finishShutdown();
    hookFailed=true;hookError='Код завершения: '+code;
    log('Поток ввода завершён, код:', code);
    discardWaiting();
    if(last){last={state:{...last.state,enabled:false,listening:false}};broadcast({...last,event:'toggle'});}
    if (activeCast) handleCastComplete({ id: activeCast.id, ok: false, reason: 'Поток ввода завершён', profile: activeCast.profile, elapsedMs: 0 });
    fatalError('Поток ввода неожиданно завершился',new Error('Код: '+code));
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
  bindingWatcher?.close();clearTimeout(bindingRetry);clearTimeout(bindingAckTimer);
  clearTimeout(startupDiagnosticTimer);
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

function fatalError(title,error){
  if(fatalShown||shutdown)return;
  fatalShown=true;
  const message=String(error?.message||error||'Неизвестная ошибка');
  log('Критическая ошибка:',title,error?.stack||message);
  requestShutdown(false,1);
  dialog.showErrorBox('Voice Invoker — '+title,message+'\n\nЖурнал: '+LOG_FILE+'\nНастройки сохранены. Приложение завершает работу.');
}
function updateTray(){
  if(!tray||tray.isDestroyed()||shutdown)return;
  const enabled=!!last?.state.enabled;
  const key=String(enabled)+':'+bindingsChanged+':'+testOnly;
  if(trayStateKey===key)return;trayStateKey=key;
  tray.setToolTip('Voice Invoker — '+(testOnly?'тест без нажатий':enabled?'каст включён':'каст выключен'));
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'Настройки / диагностика',click:()=>openSettings()},
    {label:testOnly?'Тестовое распознавание':'Голосовой каст',type:'checkbox',checked:enabled,click:()=>toHook(WM_APP_TOGGLE,0)},
    ...(bindingsChanged?[{label:'Клавиши Dota изменились — проверить',click:()=>openSettings()}]:[]),
    {label:'Перезапустить',click:()=>requestShutdown(true)},
    {label:'Скопировать отчёт',click:()=>{diagnostics().then(d=>clipboard.writeText(supportReport(d))).catch(e=>log('Ошибка отчёта:',e.message));}},
    {label:'Открыть журнал',click:()=>shell.openPath(LOG_FILE).then(error=>{if(error)log(error);})},
    {label:'Папка журналов',click:()=>shell.openPath(DATA_DIR)},
    {type:'separator'},
    {label:'Выйти из Voice Invoker',click:()=>requestShutdown(false)}
  ]));
}
async function createTray() {
  try {
    let icon=nativeImage.createFromPath(path.join(__dirname,'icon.png'));
    if(icon.isEmpty())icon=await app.getFileIcon(process.execPath,{size:'small'});
    if(shutdown)return;
    tray=new Tray(icon);trayStateKey='';updateTray();
    tray.on('double-click',()=>openSettings());
  }catch(e){log('Не удалось создать значок в трее:',e.message);openStartupDiagnostics();}
}

// ---------- Окно поверх игры (в нём же работает распознавание) ----------
function createWindow() {
  // Разрешаем доступ к микрофону для нашей страницы
  const ownOrigin=url=>{try{return new URL(url).origin==='http://localhost:'+config.port;}catch{return false;}};
  session.defaultSession.setPermissionRequestHandler((wc,permission,cb,details)=>cb(permission==='media'&&ownOrigin(wc?.getURL())&&ownOrigin(details.requestingUrl||wc?.getURL())&&(!('mediaTypes' in details)||!details.mediaTypes||details.mediaTypes.every(t=>t==='audio'))));
  session.defaultSession.setPermissionCheckHandler((wc,permission,origin,details)=>permission==='media'&&ownOrigin(origin)&&(!details.mediaType||details.mediaType==='audio'));


  const { bounds } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...bounds, icon:path.join(__dirname,'icon.png'),
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
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',e=>e.preventDefault());
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
    voiceInfo={ready:false,message:'Не удалось подготовить модель: '+e.message};
  }
  if (shutdown) return;
  if (skipped.length) log(`Фразы не по-русски пропущены (слушает только русская модель): ${skipped.join(', ')}`);
  server.on('error', (e) => {
    if ('code' in e && e.code === 'EADDRINUSE') {
      log(`Порт ${config.port} уже занят (плагин уже запущен или порт занят другой программой).`);
      log('Проверь владельца порта: Get-NetTCPConnection -LocalPort ' + config.port + ' -State Listen');
      fatalError('Порт занят',new Error('Порт '+config.port+' уже используется. Проверь владельца порта. Порт автоматически не меняется.'));
    } else fatalError('Ошибка локального сервера',e);
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
    void watchBindings();
    createWindow();
    createTray();
    if (firstRun || settingsRequested) { settingsRequested = false; openSettings(); }
    if(configInvalid||!modelWords||!modelInfo.active||voiceInfo.message||setupFailedAtStartup)openStartupDiagnostics();
    startupDiagnosticTimer=setTimeout(()=>{diagnostics().then(d=>{
      if(!d.dotaFound||!d.gsiInstalled||!d.gsiConfigMatches||!d.itemsConfigured||(d.running===true&&d.launchFlag===false))openStartupDiagnostics();
    }).catch(e=>log('Проверка старта:',e.message));},10000);
  });
}).catch(e=>fatalError('Ошибка запуска',e));
process.on('uncaughtException',e=>fatalError('Критическая ошибка',e));
process.on('unhandledRejection',e=>fatalError('Необработанная ошибка',e));
app.on('window-all-closed', () => requestShutdown(false));
}
