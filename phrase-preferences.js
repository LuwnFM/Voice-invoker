// Store exclusions separately from the built-in vocabulary, including V2-only aliases.
const normalize = value => String(value).trim().toLowerCase().replace(/\s+/g,' ');
/** @param {Record<string,string[]>} base @param {Record<string,{ready:string[],pending:string[]}>} extra @returns {Record<string,string[]>} */
function catalog(base, extra) {
  return Object.fromEntries(Object.entries(base).map(([id,phrases]) => {
    const more=extra[id.replace(/^invoker_/,'')] || {ready:[],pending:[]};
    const retired=id==='invoker_sun_strike'?['сан']:id==='invoker_cataclysm'?['ката','катак']:[];
    return [id,[...new Set([...phrases,...more.ready,...more.pending].map(normalize))].filter(p=>p&&!retired.includes(p))];
  }));
}
/** @param {Record<string,string[]>|undefined} value @param {Record<string,string[]>} all @returns {Record<string,string[]>} */
function exclusions(value, all) {
  /** @type {Record<string,string[]>} */
  const result={};
  if (!value || typeof value!=='object' || Array.isArray(value)) return result;
  for(const [id,phrases] of Object.entries(all)) {
    if(!Array.isArray(value[id])) continue;
    const valid=new Set(phrases);
    result[id]=[...new Set(value[id].filter(p=>typeof p==='string').map(normalize))].filter(p=>valid.has(p));
  }
  return result;
}
/** @param {Record<string,string[]>} all @param {Record<string,string[]>} excluded @param {Record<string,{ready:string[],pending:string[]}>} extra @param {boolean} expanded @returns {Record<string,string[]>} */
function enabledPhrases(all, excluded, extra, expanded) {
  return Object.fromEntries(Object.entries(all).map(([id,phrases])=>{
    const denied=new Set(excluded[id]||[]);
    const pending=extra[id.replace(/^invoker_/,'')]?.pending||[];
    return [id,phrases.filter(p=>!denied.has(p)&&(expanded||!pending.includes(p)))];
  }));
}
// Historical manually edited config.phrases is additive, not a replacement of defaults.
/** @param {Record<string,string[]>} base @param {Record<string,string[]>|undefined} additions @returns {Record<string,string[]>} */
function mergeCatalog(base, additions) {
  return Object.fromEntries(Object.entries(base).map(([id,list])=>[
    id,[...new Set([...list,...(Array.isArray(additions?.[id])?additions[id].filter(p=>typeof p==='string'):[])].map(normalize).filter(Boolean))]
  ]));
}
module.exports={catalog,exclusions,enabledPhrases,mergeCatalog};
