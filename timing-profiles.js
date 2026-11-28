// Normal preserves existing custom delays. Fast and turbo are opt-in.
const NORMAL = Object.freeze({ keyDelayMs: 35, castDelayMs: 90, clickDelayMs: 60, altDelayMs: 30, chainGapMs: 40 });
const FAST = Object.freeze({ keyDelayMs: 20, castDelayMs: 90, clickDelayMs: 30, altDelayMs: 20, chainGapMs: 20 });
// Experimental Turbo: SetTimer clamps positive intervals below 10 ms.
const TURBO = Object.freeze({ keyDelayMs: 10, castDelayMs: 90, clickDelayMs: 10, altDelayMs: 10, chainGapMs: 10 });
const PROFILES = Object.freeze(['normal', 'fast', 'turbo']);
const MAX_CAST_ID = 0x3ffffff;
function normalizeProfile(value) { return PROFILES.includes(value) ? value : 'normal'; }
function profileLabel(profile) { return { normal: 'обычный', fast: 'ускоренный', turbo: 'турбо' }[normalizeProfile(profile)]; }
function getTiming(config, profile = config.timingProfile) {
  const normal = Object.fromEntries(Object.entries(NORMAL).map(([key, value]) => [key, Number.isInteger(config[key]) && config[key] >= 0 && config[key] <= 5000 ? config[key] : value]));
  profile = normalizeProfile(profile);
  if (profile === 'normal') return normal;
  const preset = profile === 'turbo' ? TURBO : FAST;
  const override = profile === 'turbo' ? config.turboTiming || {} : config.fastTiming || {};
  return Object.fromEntries(Object.entries(preset).map(([key, value]) => {
    const candidate = Number.isInteger(override[key]) && override[key] >= 0 && override[key] <= 5000 ? override[key] : value;
    return [key, Math.min(normal[key], candidate)];
  }));
}
// 3 bits for action, 2 for profile; the request ID remains in signed 32-bit range.
function encodeCast(action, profile, id) {
  if (!Number.isInteger(id) || id < 1 || id > MAX_CAST_ID || ![1,2,3,4,5].includes(action)) throw new RangeError('Invalid cast request');
  return id * 32 + PROFILES.indexOf(normalizeProfile(profile)) * 8 + action;
}
function decodeCast(value) {
  const id = Math.floor(value / 32), action = value & 7;
  const profile = PROFILES[(value >>> 3) & 3];
  if (!Number.isInteger(value) || id < 1 || id > MAX_CAST_ID || !profile || ![1,2,3,4,5].includes(action)) throw new RangeError('Invalid cast message');
  return { id, action, profile };
}
module.exports = { NORMAL, FAST, TURBO, PROFILES, MAX_CAST_ID, normalizeProfile, profileLabel, getTiming, encodeCast, decodeCast };
