(function (root) {
  const PREPARE_PREFIXES = Object.freeze(['запиши в фолиант', 'записать в фолиант', 'подготовить', 'подготовь']);
  const prefixTokens = PREPARE_PREFIXES.map(p => p.split(' '));
  const cueWords = new Set([...prefixTokens.map(p => p[0]), 'фолиант']);
  const wordsOf = text => String(text || '').toLowerCase().split(/\s+/).filter(w => w && w !== '[unk]');
  const hasPreparationCue = text => wordsOf(text).some(w => cueWords.has(w));
  const prepareCommand = phrase => 'подготовить ' + phrase;
  function decodeVoiceCommand(text) {
    const phrase = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const prefix = PREPARE_PREFIXES.find(p => phrase.startsWith(p + ' '));
    return { phrase: prefix ? phrase.slice(prefix.length + 1) : phrase, prepareOnly: Boolean(prefix) };
  }
  function recognitionGrammar(grammar) {
    return [...new Set([...grammar, ...PREPARE_PREFIXES, ...PREPARE_PREFIXES.flatMap(prefix => grammar.map(phrase => prefix + ' ' + phrase))])];
  }
  function createPhraseParser(grammar) {
    const index = new Map();
    for (const phrase of grammar) {
      const tokens = phrase.split(' ');
      if (!index.has(tokens[0])) index.set(tokens[0], []);
      index.get(tokens[0]).push({ phrase, tokens });
    }
    for (const entries of index.values()) entries.sort((a, b) => b.tokens.length - a.tokens.length);
    return (text) => {
      const words = wordsOf(text);
      const matches = [];
      let prepareOnly = false, blocked = false;
      for (let i = 0; i < words.length;) {
        const prefix = prefixTokens.find(tokens => tokens.every((word, j) => words[i + j] === word));
        if (prefix) { prepareOnly = true; blocked = false; i += prefix.length; continue; }
        // An incomplete preparation cue must not turn the following spell into a cast.
        if (cueWords.has(words[i])) { blocked = true; i++; continue; }
        const hit = (index.get(words[i]) || []).find(({ tokens }) => tokens.every((word, j) => words[i + j] === word));
        if (hit && !blocked) matches.push(prepareOnly ? prepareCommand(hit.phrase) : hit.phrase);
        i += hit ? hit.tokens.length : 1;
      }
      return matches;
    };
  }
  // Remember a cue even if a subsequent partial hypothesis drops it.
  function createRecognitionGate(parse) {
    let cueSeen = false;
    return {
      read(text, finalized) {
        if (hasPreparationCue(text)) cueSeen = true;
        if (!cueSeen) return parse(text);
        if (!finalized) return [];
        return parse(text).filter(command => decodeVoiceCommand(command).prepareOnly);
      },
      reset() { cueSeen = false; },
    };
  }
  const api = { PREPARE_PREFIXES, createPhraseParser, decodeVoiceCommand, recognitionGrammar, createRecognitionGate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(globalThis);
