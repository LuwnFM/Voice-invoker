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
    strict,targets:SPELLS,excluded:disabled,ownCatalog:base
  });
  const all=mergeCatalog(base,custom.phrases);
  const reserved=enabledPhrases(all,disabled,extra,true);
  const items=validateItemPhrases(preferences.itemPhrases,words,reserved,{strict});
  return {
    active:{...enabledPhrases(all,disabled,extra,expanded),...items.phrases},
    customSpellPhrases:custom.phrases,itemPhrases:items.phrases,
    disabledPhrases:exclusions(disabled,all),errors:[...custom.errors,...items.errors]
  };
}
module.exports={resolveCommands};
