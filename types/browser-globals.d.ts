// APIs provided at runtime by phrase-parser.js, vosk-browser and AudioWorklet.
declare const createPhraseParser: (grammar: string[]) => (text: string) => string[];
declare const recognitionGrammar: (grammar: string[]) => string[];
declare const createRecognitionGate: (parse:(text:string)=>string[]) => {read(text:string,finalized:boolean):string[];reset():void};
declare const Vosk: typeof import('vosk-browser');
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name:string, processor:typeof AudioWorkletProcessor):void;
