#!/usr/bin/env node
/**
 * Normalises the shadcn primitives in src/components/ui after `shadcn add`.
 *
 * Two things the CLI gets wrong for this project:
 *
 * 1. It writes `import { cn } from "cn"` instead of resolving the `utils`
 *    alias from components.json.
 * 2. It uses physical direction utilities (`ml-`, `pl-`, `left-`, `text-left`,
 *    `border-l`, `rounded-l-*`). The concept's rule is logical properties only,
 *    so the same components work in RTL (fa, ar) without a second stylesheet.
 *
 * Run it after adding or overwriting any component:
 *   pnpm run normalize:ui
 *
 * It is idempotent, and it prints every file it changed.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UI_DIR = new URL('../src/components/ui/', import.meta.url).pathname;

/** `left-[50%]` + `-translate-x-1/2` is direction-neutral centring: leave it. */
const CENTERING_PLACEHOLDERS = [
  ['left-[50%]', '\u0000CENTER_LEFT_PCT\u0000'],
  ['left-1/2', '\u0000CENTER_LEFT_HALF\u0000'],
  ['top-[50%]', '\u0000CENTER_TOP_PCT\u0000'],
];

/**
 * `(?<![\w-])` keeps us off the tail of a compound class: `slide-in-from-right-2`
 * and `data-[side=left]` must not be rewritten — those are animation and Radix
 * side names, not layout.
 */
const REWRITES = [
  [/(?<![\w-])text-left\b/g, 'text-start'],
  [/(?<![\w-])text-right\b/g, 'text-end'],
  [/(?<![\w-])ml-/g, 'ms-'],
  [/(?<![\w-])mr-/g, 'me-'],
  [/(?<![\w-])-ml-/g, '-ms-'],
  [/(?<![\w-])-mr-/g, '-me-'],
  [/(?<![\w-])pl-/g, 'ps-'],
  [/(?<![\w-])pr-/g, 'pe-'],
  [/(?<![\w-])left-/g, 'start-'],
  [/(?<![\w-])right-/g, 'end-'],
  [/(?<![\w-])border-l(?=[-\s"'\\])/g, 'border-s'],
  [/(?<![\w-])border-r(?=[-\s"'\\])/g, 'border-e'],
  [/(?<![\w-])rounded-tl-/g, 'rounded-ss-'],
  [/(?<![\w-])rounded-tr-/g, 'rounded-se-'],
  [/(?<![\w-])rounded-bl-/g, 'rounded-es-'],
  [/(?<![\w-])rounded-br-/g, 'rounded-ee-'],
  [/(?<![\w-])rounded-l-/g, 'rounded-s-'],
  [/(?<![\w-])rounded-r-/g, 'rounded-e-'],
];

/**
 * Control heights the CLI hard-codes. Every control in this app derives its height
 * from `--control-h`, so the density setting resizes all of them at once and two
 * controls side by side in a form row line up exactly. A literal `h-9` opts out of
 * both, which is a bug the operator sees as a crooked row.
 */
const CONTROL_HEIGHTS = [
  ['"h-9 min-w-0 has-[>textarea]:h-auto"', '"h-(--control-h) min-w-0 has-[>textarea]:h-auto"'],
  ['"h-9 min-w-9 px-2"', '"h-(--control-h) min-w-(--control-h) px-2"'],
  [
    '"h-8 min-w-8 px-1.5"',
    '"h-[calc(var(--control-h)-0.375rem)] min-w-[calc(var(--control-h)-0.375rem)] px-1.5"',
  ],
];

function normalizeControlHeights(source) {
  let out = source;
  for (const [literal, replacement] of CONTROL_HEIGHTS) out = out.replaceAll(literal, replacement);
  return out;
}

/** Icons whose meaning is "forward"/"back": they mirror in RTL. */
const FLIP_ICONS = ['ChevronRightIcon', 'ChevronRight', 'ChevronLeftIcon', 'ChevronLeft'];

function normalizeImports(source) {
  return source.replaceAll('from "cn"', `from "@/lib/utils"`);
}

function normalizeDirection(source) {
  let out = source;
  for (const [literal, token] of CENTERING_PLACEHOLDERS) out = out.replaceAll(literal, token);
  for (const [pattern, replacement] of REWRITES) out = out.replace(pattern, replacement);
  for (const [literal, token] of CENTERING_PLACEHOLDERS) out = out.replaceAll(token, literal);
  return out;
}

function addIconFlip(source) {
  let out = source;
  for (const icon of FLIP_ICONS) {
    // `<ChevronRightIcon className="ms-auto" />` -> adds the flip-rtl utility once.
    out = out.replace(new RegExp(`<${icon}(\\s+)className="(?!.*flip-rtl)`, 'g'), `<${icon}$1className="flip-rtl `);
    // `<ChevronRightIcon />` with no className at all.
    out = out.replace(new RegExp(`<${icon}\\s*/>`, 'g'), `<${icon} className="flip-rtl" />`);
  }
  return out;
}

let changed = 0;
for (const name of readdirSync(UI_DIR)) {
  if (!name.endsWith('.tsx')) continue;
  const path = join(UI_DIR, name);
  const before = readFileSync(path, 'utf8');
  const imported = normalizeImports(before);
  const directional = normalizeDirection(imported);
  const sized = normalizeControlHeights(directional);
  const after = addIconFlip(sized);
  if (after !== before) {
    writeFileSync(path, after);
    changed += 1;
    console.log(`normalized ${name}`);
  }
}
console.log(changed === 0 ? 'nothing to normalize' : `${changed} file(s) normalized`);
