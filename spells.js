// target: способности нужна цель или точка (после клавиши нужен клик, если нет быстрого каста)
// base:   команда применяет другую способность особым образом (Cataclysm = Sun Strike на себя)
module.exports = [
  { id: 'invoker_cold_snap',       name: 'Cold Snap',       combo: 'QQQ', target: true },
  { id: 'invoker_ghost_walk',      name: 'Ghost Walk',      combo: 'QQW', target: false },
  { id: 'invoker_ice_wall',        name: 'Ice Wall',        combo: 'QQE', target: false },
  { id: 'invoker_emp',             name: 'EMP',             combo: 'WWW', target: true },
  { id: 'invoker_tornado',         name: 'Tornado',         combo: 'WWQ', target: true },
  { id: 'invoker_alacrity',        name: 'Alacrity',        combo: 'WWE', target: true },
  { id: 'invoker_sun_strike',      name: 'Sun Strike',      combo: 'EEE', target: true },
  { id: 'invoker_forge_spirit',    name: 'Forge Spirit',    combo: 'EEQ', target: false },
  { id: 'invoker_chaos_meteor',    name: 'Chaos Meteor',    combo: 'EEW', target: true },
  { id: 'invoker_deafening_blast', name: 'Deafening Blast', combo: 'QWE', target: true },
  // Cataclysm: Sun Strike с Аганимом, применённый на себя (Alt+клавиша)
  { id: 'invoker_cataclysm', name: 'Cataclysm', combo: 'EEE', target: false, base: 'invoker_sun_strike', selfCast: true, needsScepter: true },
];
