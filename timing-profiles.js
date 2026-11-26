// Keep existing custom normal delays; the experimental profile is opt-in.
const NORMAL = Object.freeze({ keyDelayMs: 35, castDelayMs: 90, clickDelayMs: 60, altDelayMs: 30, chainGapMs: 40 });
const FAST = Object.freeze({ keyDelayMs: 20, castDelayMs: 90, clickDelayMs: 30, altDelayMs: 20, chainGapMs: 20 });
function normalizeProfile(value) { return value === 'fast' ? 'fast' : 'normal'; }
function getTiming(config, profile = config.timingProfile) {
  const normal = Object.fromEntries(Object.entries(NORMAL).map(([key, value]) => [key, Number.isInteger(config[key]) && config[key] >= 0 && config[key] <= 5000 ? config[key] : value]));
  if (normalizeProfile(profile) !== 'fast') return normal;
  const override = config.fastTiming || {};
  return Object.fromEntries(Object.entries(FAST).map(([key, value]) => {
    const candidate = Number.isInteger(override[key]) && override[key] >= 0 && override[key] <= 5000 ? override[key] : value;
    return [key, Math.min(normal[key], candidate)];
  }));
}
// The profile and request ID travel with the action, even across split GSI casts.
function encodeCast(action, profile, id) {
  if (!Number.isInteger(id) || id < 1 || id > 0x7ffffff || ![1,2,3,4].includes(action)) throw new RangeError('Invalid cast request');
  return id * 16 + (normalizeProfile(profile) === 'fast' ? 8 : 0) + action;
}
function decodeCast(value) {
  const id = Math.floor(value / 16), action = value & 7;
  if (!Number.isInteger(value) || id < 1 || id > 0x7ffffff || ![1,2,3,4].includes(action)) throw new RangeError('Invalid cast message');
  return { id, action, profile: value & 8 ? 'fast' : 'normal' };
}
module.exports = { NORMAL, FAST, normalizeProfile, getTiming, encodeCast, decodeCast };
