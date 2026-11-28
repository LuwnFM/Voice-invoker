// ESLint flat config. Correctness rules are errors; unused declarations are
// warnings until the historical UI/native bridge is cleaned up.
const globalsOf=names=>Object.fromEntries(names.split(/\s+/).filter(Boolean).map(n=>[n,'readonly']));
const node=globalsOf('require module exports __dirname __filename process Buffer console global globalThis setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate fetch URL URLSearchParams AbortSignal Response TextDecoder TextEncoder SharedArrayBuffer Atomics Uint8Array Int32Array');
const browser=globalsOf('window document navigator location performance console setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame fetch URL URLSearchParams AudioContext AudioWorkletNode AudioWorkletProcessor registerProcessor EventSource Event Option Vosk createPhraseParser createRecognitionGate recognitionGrammar globalThis');
module.exports=[
 {ignores:['node_modules/**','build-output/**','model/**','.quality-tools/**']},
 {files:['**/*.js'],languageOptions:{ecmaVersion:'latest',sourceType:'commonjs',globals:node},rules:{
 'no-undef':'error','no-unreachable':'error','no-dupe-keys':'error','no-dupe-args':'error','no-duplicate-case':'error','no-constant-binary-expression':'error','no-self-assign':'error','no-unsafe-finally':'error','no-func-assign':'error','no-obj-calls':'error','no-sparse-arrays':'error','no-unexpected-multiline':'error','no-useless-catch':'error','no-unused-vars':['warn',{args:'none',caughtErrors:'none',varsIgnorePattern:'^_'}]
 }},
 {files:['voice-capture.js','.quality-html/*.js'],languageOptions:{sourceType:'script',globals:{...node,...browser}}},
];
