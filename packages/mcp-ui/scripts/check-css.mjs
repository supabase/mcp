/**
 * Checks every `src/**\/*.css` against the rules in
 * `.agents/skills/mcp-ui-css/SKILL.md`: rules live in layers declared in a
 * fixed order, specificity stays under each layer's cap, no `!important` or
 * ids, and `var()` fallbacks only in `base`. Run with `pnpm lint:css`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { transform } from 'lightningcss';

const LAYERS = ['base', 'native', 'components', 'view', 'utilities'];

/** Max specificity [ids, classes, elements] of a top-level selector. */
const CAPS = {
  base: [0, 0, 0],
  native: [0, 0, 1],
  components: [0, 0, 1],
  view: [0, 1, 0],
  utilities: [0, 0, 0],
};

const root = new URL('..', import.meta.url).pathname;
const files = readdirSync(join(root, 'src'), {
  recursive: true,
  withFileTypes: true,
})
  .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
  .map((entry) => join(entry.parentPath, entry.name));

const errors = [];

/** Specificity of one selector; `&` and pseudo-elements count as zero. */
function specificity(selector) {
  const total = [0, 0, 0];
  for (const part of selector) {
    let add = [0, 0, 0];
    if (part.type === 'id') add = [1, 0, 0];
    else if (part.type === 'class' || part.type === 'attribute')
      add = [0, 1, 0];
    else if (part.type === 'type') add = [0, 0, 1];
    else if (part.type === 'pseudo-class') {
      if (part.kind === 'where') continue;
      // `:is()`, `:not()` and `:has()` take their heaviest argument.
      add = part.selectors
        ? part.selectors.map(specificity).reduce(max, [0, 0, 0])
        : [0, 1, 0];
    }
    for (let i = 0; i < 3; i++) total[i] += add[i];
  }
  return total;
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const max = (a, b) => (compare(a, b) >= 0 ? a : b);
const exceeds = (value, cap) => value.some((n, i) => n > cap[i]);

/** Whether a selector (at any depth) contains an id. */
const hasId = (selector) =>
  selector.some(
    (part) =>
      part.type === 'id' || part.selectors?.some((inner) => hasId(inner))
  );

/** Whether a selector targets a `data-slot` attribute with no class or element. */
function isSlotOnly(selector) {
  const flat = [];
  const walk = (sel) => {
    for (const part of sel) {
      if (part.selectors) part.selectors.forEach(walk);
      else flat.push(part);
    }
  };
  walk(selector);
  return (
    flat.some((p) => p.type === 'attribute' && p.name === 'data-slot') &&
    !flat.some((p) => p.type === 'class' || p.type === 'type')
  );
}

/** Every `var()` in a value, at any depth. */
function* vars(value) {
  if (Array.isArray(value)) for (const item of value) yield* vars(item);
  else if (value && typeof value === 'object') {
    if (value.type === 'var') yield value.value;
    for (const child of Object.values(value)) yield* vars(child);
  }
}

/** Custom properties declared in a rule and its nested rules. */
function* customProps(rule) {
  const { declarations, rules = [] } = rule.value;
  for (const decl of declarations?.declarations ?? []) {
    if (decl.property === 'custom') yield decl.value.name;
  }
  for (const child of rules) yield* customProps(child);
}

for (const file of files) {
  const name = relative(root, file);
  const at = (loc) => `${name}:${loc.line + 1}`;
  let stylesheet;
  transform({
    filename: name,
    code: readFileSync(file),
    visitor: { StyleSheet: (sheet) => void (stylesheet = sheet) },
  });

  const rules = stylesheet.rules;
  const order = rules.find((rule) => rule.type === 'layer-statement');
  if (!order) {
    errors.push(`${name}: missing \`@layer ${LAYERS.join(', ')};\``);
  } else if (order.value.names.join(', ') !== LAYERS.join(', ')) {
    errors.push(
      `${at(order.value.loc)}: layer order must be \`${LAYERS.join(', ')}\``
    );
  }

  // A pass to collect the custom properties `base` declares, then one to check.
  const checks = [];
  const declaredInBase = new Set();

  for (const rule of rules) {
    if (rule.type === 'layer-block') {
      const layer = rule.value.name?.join('.');
      if (!LAYERS.includes(layer)) {
        errors.push(`${at(rule.value.loc)}: unknown layer \`${layer}\``);
        continue;
      }
      for (const child of rule.value.rules) {
        if (layer === 'base') {
          for (const prop of customProps(child)) declaredInBase.add(prop);
        }
        checks.push({ rule: child, layer });
      }
    } else if (rule.type !== 'layer-statement') {
      for (const style of styleRules(rule)) {
        errors.push(`${at(style.value.loc)}: style rule outside any @layer`);
      }
    }
  }

  for (const { rule, layer } of checks) {
    const ownProps = new Set(customProps(rule));
    for (const style of styleRules(rule)) {
      checkStyle(style, { layer, top: true, ownProps });
    }
  }

  /** Style rules in a rule, through at-rules such as `@media`. */
  function* styleRules(rule) {
    if (rule.type === 'style') yield rule;
    else for (const child of rule.value?.rules ?? []) yield* styleRules(child);
  }

  function checkStyle(style, { layer, top, ownProps }) {
    const { selectors, declarations, rules = [], loc } = style.value;
    for (const selector of selectors ?? []) {
      if (top && layer === 'components' && isSlotOnly(selector)) {
        errors.push(
          `${at(loc)}: top-level \`data-slot\` rule; slots must be nested inside their component's rule`
        );
      }
      if (hasId(selector)) errors.push(`${at(loc)}: id selector`);
      const value = specificity(selector);
      if (top && exceeds(value, CAPS[layer])) {
        errors.push(
          `${at(loc)}: specificity (${value}) is over the \`${layer}\` cap (${CAPS[layer]})`
        );
      }
      if (!top && compare(value, [0, 0, 0]) > 0) {
        errors.push(
          `${at(loc)}: nested selector adds specificity; wrap it in :where()`
        );
      }
      // `:where(&:disabled)` drops the parent's own specificity too, so it
      // loses to the parent rule; `&:where(:disabled)` keeps it.
      if (
        selector.some(
          (part) =>
            part.kind === 'where' &&
            part.selectors.some((s) => s.some((p) => p.type === 'nesting'))
        )
      ) {
        errors.push(
          `${at(loc)}: \`:where(&…)\` loses to its parent rule; use \`&:where(…)\``
        );
      }
    }
    if (declarations?.importantDeclarations.length) {
      errors.push(`${at(loc)}: !important`);
    }
    for (const decl of declarations?.declarations ?? []) {
      for (const ref of vars(decl.value)) {
        const prop = ref.name.ident;
        if (ref.fallback && layer !== 'base') {
          errors.push(`${at(loc)}: var(${prop}, …) fallback outside base`);
        }
        if (!declaredInBase.has(prop) && !ownProps.has(prop)) {
          errors.push(
            `${at(loc)}: var(${prop}) has no fallback declared in base`
          );
        }
      }
    }
    for (const child of rules) checkNested(child, { layer, ownProps });
  }

  /** Nested rules, and declarations nested in at-rules such as `@media`. */
  function checkNested(rule, context) {
    if (rule.type === 'style') checkStyle(rule, { ...context, top: false });
    else if (rule.type === 'nested-declarations') {
      checkStyle({ value: rule.value }, { ...context, top: false });
    } else {
      for (const child of rule.value?.rules ?? []) checkNested(child, context);
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  console.error(
    `\n${errors.length} CSS problem(s). See .agents/skills/mcp-ui-css/SKILL.md.`
  );
  process.exit(1);
}
console.log(`CSS OK (${files.length} file(s))`);
