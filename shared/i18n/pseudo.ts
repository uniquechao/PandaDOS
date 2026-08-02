import type { MessageCatalog } from './messages';

const accents: Readonly<Record<string, string>> = {
  a: 'à', b: 'ƀ', c: 'ç', d: 'ð', e: 'ë', f: 'ƒ', g: 'ğ', h: 'ħ', i: 'ï',
  j: 'ĵ', k: 'ķ', l: 'ľ', m: 'ɱ', n: 'ñ', o: 'ô', p: 'þ', q: 'ɋ', r: 'ř',
  s: 'š', t: 'ŧ', u: 'ü', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ÿ', z: 'ž',
};

function accentLiteral(value: string): string {
  return value.replace(/[A-Za-z]/g, (letter) => {
    const converted = accents[letter.toLowerCase()] ?? letter;
    return letter === letter.toUpperCase() ? converted.toUpperCase() : converted;
  });
}

/** Pseudo-localize visible text while keeping ICU arguments byte-for-byte intact. */
export function pseudoMessage(message: string): string {
  let output = '';
  let literal = '';
  let depth = 0;
  for (const char of message) {
    if (char === '{') {
      if (depth === 0) {
        output += accentLiteral(literal);
        literal = '';
      }
      depth += 1;
      output += char;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      output += char;
    } else if (depth > 0) {
      output += char;
    } else {
      literal += char;
    }
  }
  output += accentLiteral(literal);
  return `［!! ${output} ${'~'.repeat(Math.max(2, Math.ceil(message.length * 0.25)))} !!］`;
}

export function pseudoCatalog(catalog: MessageCatalog): MessageCatalog {
  return Object.fromEntries(Object.entries(catalog).map(([key, value]) => [key, pseudoMessage(value)])) as MessageCatalog;
}
