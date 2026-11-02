// Nomi glifo Adobe -> carattere Unicode (sottoinsieme latino sufficiente per /Differences)
const NAMES = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&",
  quotesingle: "'", parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-",
  period: ".", slash: "/", colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?",
  at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_",
  grave: "`", braceleft: "{", bar: "|", braceright: "}", asciitilde: "~", quoteleft: "‘",
  quoteright: "’", quotedblleft: "“", quotedblright: "”", quotesinglbase: "‚",
  quotedblbase: "„", endash: "–", emdash: "—", bullet: "•", ellipsis: "…",
  Euro: "€", germandbls: "ß", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", oslash: "ø", Oslash: "Ø",
  degree: "°", section: "§", paragraph: "¶", copyright: "©", registered: "®", trademark: "™",
  guillemotleft: "«", guillemotright: "»", guilsinglleft: "‹", guilsinglright: "›", sterling: "£",
  yen: "¥", cent: "¢", periodcentered: "·", ordfeminine: "ª", ordmasculine: "º", dagger: "†",
  daggerdbl: "‡", minus: "−", multiply: "×", divide: "÷", plusminus: "±", exclamdown: "¡",
  questiondown: "¿", nbspace: " ", dotlessi: "ı", eth: "ð", Eth: "Ð", thorn: "þ", Thorn: "Þ",
  mu: "µ", onehalf: "½", onequarter: "¼", threequarters: "¾", brokenbar: "¦", currency: "¤",
  logicalnot: "¬", macron: "¯", acute: "´", dieresis: "¨", cedilla: "¸", fraction: "⁄", perthousand: "‰",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};
const ACCENTS = { grave: "̀", acute: "́", circumflex: "̂", tilde: "̃", dieresis: "̈",
  ring: "̊", cedilla: "̧", caron: "̌", macron: "̄", breve: "̆", ogonek: "̨",
  dotaccent: "̇", hungarumlaut: "̋" };

export function glyphNameToUnicode(name) {
  name = name.replace(/\..*$/, "");
  if (NAMES[name]) return NAMES[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = name.match(/^uni([0-9A-Fa-f]{4})$/) || name.match(/^u([0-9A-Fa-f]{4,6})$/);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  m = name.match(/^([A-Za-z])(grave|acute|circumflex|tilde|dieresis|ring|cedilla|caron|macron|breve|ogonek|dotaccent|hungarumlaut)$/);
  if (m) return (m[1] + ACCENTS[m[2]]).normalize("NFC");
  return null;
}
