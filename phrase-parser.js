(function (root) {
  function createPhraseParser(grammar) {
    const index = new Map();
    for (const phrase of grammar) {
      const tokens = phrase.split(' ');
      if (!index.has(tokens[0])) index.set(tokens[0], []);
      index.get(tokens[0]).push({ phrase, tokens });
    }
    for (const entries of index.values()) entries.sort((a, b) => b.tokens.length - a.tokens.length);
    return (text) => {
      const words = text.split(/\s+/).filter((w) => w && w !== '[unk]');
      const matches = [];
      for (let i = 0; i < words.length;) {
        const hit = (index.get(words[i]) || []).find(({ tokens }) => tokens.every((word, j) => words[i + j] === word));
        if (hit) matches.push(hit.phrase);
        i += hit ? hit.tokens.length : 1;
      }
      return matches;
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createPhraseParser };
  else root.createPhraseParser = createPhraseParser;
})(globalThis);
