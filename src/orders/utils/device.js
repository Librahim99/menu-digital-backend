// Nombre legible del dispositivo a partir del User-Agent ("Android · Chrome").
// Solo para mostrar en el panel qué equipos tiene vinculados cada operador;
// no identifica a nadie.

const OS = [
  [/iPad/i, "iPad"],
  [/iPhone|iPod/i, "iPhone"],
  [/Android/i, "Android"],
  [/Windows/i, "Windows"],
  [/Mac OS X|Macintosh/i, "Mac"],
  [/CrOS/i, "Chromebook"],
  [/Linux/i, "Linux"],
];

// El orden importa: Edge y Samsung también dicen "Chrome"; Chrome dice "Safari".
const BROWSERS = [
  [/EdgA?\//i, "Edge"],
  [/SamsungBrowser/i, "Samsung Internet"],
  [/OPR\/|Opera/i, "Opera"],
  [/Firefox|FxiOS/i, "Firefox"],
  [/Chrome|CriOS/i, "Chrome"],
  [/Safari/i, "Safari"],
];

const match = (list, ua) => list.find(([re]) => re.test(ua))?.[1] ?? null;

const deviceLabelOf = (userAgent) => {
  if (typeof userAgent !== "string" || !userAgent) return null;
  const parts = [match(OS, userAgent), match(BROWSERS, userAgent)].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
};

module.exports = { deviceLabelOf };
