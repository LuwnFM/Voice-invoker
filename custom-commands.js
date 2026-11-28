const {namedItemTargets}=require('./items');
const SPELLS=require('./spells');
const {mergeCatalog,exclusions,enabledPhrases}=require('./phrase-preferences');
const {validatePhrases,validateItemPhrases}=require('./item-phrases');
// A single validation pass over the proposed state: built-in and custom spell
// aliases first, then item slots. Disabled aliases never reserve an active phrase.
function resolveCommands(base, extra, preferences, words, expanded, {strict=true}={}){
  const shown=mergeCatalog(base,preferences.customSpellPhrases);
  const disabled=exclusions(preferences.disabledPhrases,shown);
  const reservedBase=enabledPhrases(base,disabled,extra,true);
  const custom=validatePhrases(preferences.customSpellPhrases,words,reservedBase,{
    strict,targets:SPELLS.map(({id,name})=>({id,name})),excluded:disabled,ownCatalog:base
  });
  const all=mergeCatalog(base,custom.phrases);
  const reserved=enabledPhrases(all,disabled,extra,true);
  const items=validateItemPhrases(preferences.itemPhrases,words,reserved,{strict});
  let targets=[],targetError=[];
  try{targets=namedItemTargets(preferences.namedItemPhrases);}catch(e){if(strict)throw e;targetError.push(e.message);}
  const named=validatePhrases(preferences.namedItemPhrases,words,{...reserved,...items.phrases},{strict,targets});
  return {
    active:{...enabledPhrases(all,disabled,extra,expanded),...items.phrases,...named.phrases},
    customSpellPhrases:custom.phrases,itemPhrases:items.phrases,namedItemPhrases:named.phrases,
    disabledPhrases:exclusions(disabled,all),errors:[...custom.errors,...items.errors,...targetError,...named.errors]
  };
}
module.exports={resolveCommands};
