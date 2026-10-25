// Parse only explicit two-operand arithmetic; never evaluate code or expressions.
const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];
const NUMBER = '(?:\\d{1,12}(?:\\.\\d{1,8})?|' + WORDS.join('|') + ')';
const CALCULATOR = /\b(?:calculator|calcualtor|caluclator|calulator|calc)\b/i;
const value = (word) => (/^\d/.test(word) ? word : String(WORDS.indexOf(word.toLowerCase())));
const filler =
  /\b(?:calculator|calcualtor|caluclator|calulator|calc|open|run|launch|start|use|please|can|could|would|will|you|and|then|in|using|with|the|my|for|me|now|la|pannu|pannunga)\b/gi;

export function calculatorTask(message) {
  const text = String(message || '').trim();
  if (/^(?:how|what|why|explain|describe|tell me|is|are|should|can i)\b/i.test(text)) return null;
  const named = CALCULATOR.test(text);
  if (!named && !/^(?:add|calculate|multiply|divide|subtract)\b/i.test(text)) return null;
  const patterns = [
    [
      new RegExp(
        `\\b(?:add|calculate|sum)\\s+(${NUMBER})\\s+(?:(?:and|plus|to)\\s+)?(${NUMBER})(?![\\d.])`,
        'i',
      ),
      '+',
    ],
    [new RegExp(`\\bsubtract\\s+(${NUMBER})\\s+(?:minus)\\s+(${NUMBER})(?![\\d.])`, 'i'), '-'],
    [
      new RegExp(
        `\\bmultiply\\s+(${NUMBER})\\s+(?:(?:by|and|times)\\s+)?(${NUMBER})(?![\\d.])`,
        'i',
      ),
      '*',
    ],
    [new RegExp(`\\bdivide\\s+(${NUMBER})\\s+by\\s+(${NUMBER})(?![\\d.])`, 'i'), '/'],
    [
      new RegExp(`(?<![\\d.(+\\-*/×÷])(${NUMBER})\\s*([+\\-*/×÷])\\s*(${NUMBER})(?![\\d.)])`, 'i'),
      null,
    ],
  ];
  for (const [pattern, operator] of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const rest = (text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length))
      .replace(filler, '')
      .replace(/\b(?:add|calculate)\b/gi, '')
      .trim();
    if (/[^\s,.!?]/.test(rest)) continue;
    const expression = operator
      ? value(match[1]) + operator + value(match[2])
      : value(match[1]) + match[2].replace('×', '*').replace('÷', '/') + value(match[3]);
    return {
      requiresTools: true,
      requiresUI: true,
      call: {
        tool: 'uiAutomation',
        action: 'calculate',
        params: { expression, ...(!named ? { requireActive: true } : {}) },
      },
    };
  }
  // More complex calculator goals use observed UI and the bounded desktop loop.
  return named && /\d/.test(text)
    ? {
        requiresTools: true,
        requiresUI: true,
        genericDesktop: { query: 'Calculator', goal: text, task: text },
      }
    : null;
}
