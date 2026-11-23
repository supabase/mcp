/**
 * Checks every `src/**\/*.css` against the rules in
 * `.agents/skills/mcp-ui-css/SKILL.md`: each file holds only the layers its
 * kind may (`base.css`, a shared component's file, a view's `view.css`), a
 * component class is styled in one file, the layer order statement lives in
 * `base.css` (which every view imports first), rules live in layers declared
 * in a fixed order, specificity stays under each layer's cap, no `!important`
 * or ids, and `var()` fallbacks only in `base`. Component custom properties
 * are namespaced: a component file declares `--sb-component-<component>-*` (a
 * view's `view.css`, `--sb-view-<view>-*`) and nothing else, and reads its
 * own namespace with no fallback. `--sb-component-` and `--sb-view-` are
 * reserved for those files; `base.css` never declares them. A file that reads
 * another component's namespace must give a fallback, so it still works where
 * that component's file is not shipped; the property must exist in the other
 * file. Colours are Studio's semantic tokens under the `--sb-color-` prefix,
 * which only `base.css` may declare (the opposite of the reserved prefixes
 * above). Host colour variables (`--color-*`) are read only by the host
 * bridge in `base`, and only inside the value of a `--sb-color-*` declaration
 * there (each read carries its fallback inline); everything else reads the
 * `--sb-color-*` tokens. Every host colour the bridge reads, and every
 * non-`--sb-` property `base.css` declares (the host variables' fallbacks),
 * must be a name the MCP Apps spec defines (`McpUiStyleVariableKey` in
 * ext-apps' schema), so a typo can't leave the host's value unused. Run with
 * `pnpm lint:css`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'lightningcss';

/**
 * The host's MCP Apps colour variables, read only by the bridge in `base`,
 * inside the value of a `--sb-color-*` declaration.
 */
const HOST_COLOR_PREFIX = '--color-';

/** The style variables a host may send, from the MCP Apps spec. */
const HOST_VARIABLES = new Set(
  createRequire(import.meta.url)(
    '@modelcontextprotocol/ext-apps/schema.json'
  ).$defs.McpUiStyleVariableKey.anyOf.map((key) => key.const)
);

/** Studio's colour tokens: only `base.css` may declare these. */
const SB_COLOR_PREFIX = '--sb-color-';

const LAYERS = ['base', 'native', 'components', 'view', 'utilities'];

/** Max specificity [ids, classes, elements] of a top-level selector. */
const CAPS = {
  base: [0, 0, 0],
  native: [0, 0, 1],
  components: [0, 0, 1],
  view: [0, 1, 0],
  utilities: [0, 0, 0],
};

// Not `.pathname`: that stays percent-encoded and is `/C:/…` on Windows.
const root = fileURLToPath(new URL('..', import.meta.url));
const files = readdirSync(join(root, 'src'), {
  recursive: true,
  withFileTypes: true,
})
  .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
  .map((entry) => join(entry.parentPath, entry.name));

const errors = [];

/** Path of a file relative to the package, with forward slashes. */
const nameOf = (file) => relative(root, file).split('\\').join('/');

/** Reserved: only a component's or a view's own file may declare these. */
const RESERVED = ['--sb-component-', '--sb-view-'];
const isReserved = (prop) => RESERVED.some((prefix) => prop.startsWith(prefix));

/**
 * Namespace of each component or view file: `--sb-component-<component>-` for
 * `src/shared/<component>.css`, `--sb-view-<view>-` for
 * `src/views/<view>/view.css`.
 */
const namespaces = [];
for (const file of files) {
  const name = nameOf(file);
  const component = name.match(/^src\/shared\/([^/]+)\.css$/)?.[1];
  const view = name.match(/^src\/views\/([^/]+)\/view\.css$/)?.[1];
  if (component && name !== 'src/shared/base.css') {
    namespaces.push({ file: name, prefix: `--sb-component-${component}-` });
  } else if (view) {
    namespaces.push({ file: name, prefix: `--sb-view-${view}-` });
  }
}

/** The namespace a property belongs to: the longest matching prefix. */
function ownerOf(prop) {
  let best = null;
  for (const ns of namespaces) {
    if (
      prop.startsWith(ns.prefix) &&
      (!best || ns.prefix.length > best.prefix.length)
    ) {
      best = ns;
    }
  }
  return best;
}

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

/** Layers each kind of file may contain. */
const BASE_FILE = 'src/shared/base.css';
function allowedLayers(name) {
  if (name === BASE_FILE) return ['base', 'native', 'utilities'];
  if (/^src\/shared\/[^/]+\.css$/.test(name)) return ['components'];
  if (/^src\/views\/[^/]+\/view\.css$/.test(name)) return ['view'];
  return null;
}

/** Style rules in a rule, through at-rules such as `@media`. */
function* styleRules(rule) {
  if (rule.type === 'style') yield rule;
  else for (const child of rule.value?.rules ?? []) yield* styleRules(child);
}

/** Style rules in a rule at any depth, including those nested in style rules. */
function* allStyleRules(rule) {
  if (rule.type === 'style') yield rule;
  for (const child of rule.value?.rules ?? []) yield* allStyleRules(child);
}

/** Class names in a selector, at any depth. */
function* classes(selector) {
  for (const part of selector) {
    if (part.type === 'class') yield part.name;
    for (const inner of part.selectors ?? []) yield* classes(inner);
  }
}

// Pass 1: parse every file and collect what rules in other files may rely on.
const parsed = [];
const declaredInBase = new Set();
/** File -> every custom property it declares, in any layer. */
const declaredByFile = new Map();
/**
 * Class -> file that styles it in `components`, at any depth
 */
const classOwner = new Map();

for (const file of files) {
  const name = nameOf(file);
  const at = (loc) => `${name}:${loc.line + 1}`;
  const declared = new Set();
  declaredByFile.set(name, declared);
  let stylesheet;
  transform({
    filename: name,
    code: readFileSync(file),
    visitor: { StyleSheet: (sheet) => void (stylesheet = sheet) },
  });

  const rules = stylesheet.rules;
  const allowed = allowedLayers(name);
  if (!allowed) {
    errors.push(
      `${name}: unexpected CSS file; use src/shared/base.css, src/shared/<component>.css or src/views/<view>/view.css`
    );
  }

  // The statement fixes the layer order for every view, so it lives once, in
  // base.css, which each view's main.tsx imports first (checked below).
  const order = rules.find((rule) => rule.type === 'layer-statement');
  if (name === BASE_FILE) {
    if (!order) {
      errors.push(`${name}: missing \`@layer ${LAYERS.join(', ')};\``);
    } else if (order.value.names.join(', ') !== LAYERS.join(', ')) {
      errors.push(
        `${at(order.value.loc)}: layer order must be \`${LAYERS.join(', ')}\``
      );
    } else if (rules.indexOf(order) !== 0) {
      errors.push(
        `${at(order.value.loc)}: the layer order statement must come before any rule`
      );
    }
  } else if (order) {
    errors.push(
      `${at(order.value.loc)}: layer order statement belongs in ${BASE_FILE} only`
    );
  }

  const checks = [];
  const seenLayers = new Map();

  for (const rule of rules) {
    if (rule.type === 'layer-block') {
      const layer = rule.value.name?.join('.');
      if (!LAYERS.includes(layer)) {
        errors.push(`${at(rule.value.loc)}: unknown layer \`${layer}\``);
        continue;
      }
      if (seenLayers.has(layer)) {
        errors.push(
          `${at(rule.value.loc)}: second \`@layer ${layer}\` block in this file (first at line ${seenLayers.get(layer)}); add to the existing block`
        );
      } else {
        seenLayers.set(layer, rule.value.loc.line + 1);
      }
      if (allowed && !allowed.includes(layer)) {
        errors.push(
          `${at(rule.value.loc)}: \`${layer}\` rules are not allowed in this file (allowed: ${allowed.map((l) => `\`${l}\``).join(', ')})`
        );
      }
      for (const child of rule.value.rules) {
        for (const prop of customProps(child)) {
          declared.add(prop);
          if (layer === 'base') declaredInBase.add(prop);
        }
        if (layer === 'components') {
          for (const style of allStyleRules(child)) {
            for (const selector of style.value.selectors ?? []) {
              for (const cls of classes(selector)) {
                const owner = classOwner.get(cls);
                if (owner && owner !== name) {
                  errors.push(
                    `${at(style.value.loc)}: class \`.${cls}\` is already styled in components by ${owner}; a component class may be styled in only one file`
                  );
                } else {
                  classOwner.set(cls, name);
                }
              }
            }
          }
        }
        checks.push({ rule: child, layer });
      }
    } else if (rule.type !== 'layer-statement') {
      for (const style of styleRules(rule)) {
        errors.push(`${at(style.value.loc)}: style rule outside any @layer`);
      }
    }
  }
  parsed.push({ name, at, checks });
}

// Pass 2: check every rule, with the custom properties of all files known.
for (const { name, at, checks } of parsed) {
  for (const { rule, layer } of checks) {
    const ownProps = new Set(customProps(rule));
    for (const style of styleRules(rule)) {
      checkStyle(style, { layer, top: true, ownProps, at, name });
    }
  }
}

/**
 * Where a file may declare a `--sb-*` property, and that base's other
 * properties are host variables.
 */
function checkDeclared(prop, { name, at, loc }) {
  if (!prop.startsWith('--sb-')) {
    // In base, anything else is a host variable's fallback.
    if (
      name === BASE_FILE &&
      prop.startsWith('--') &&
      !HOST_VARIABLES.has(prop)
    ) {
      errors.push(
        `${at(loc)}: \`${prop}\` is not an MCP Apps style variable (McpUiStyleVariableKey); base declares host variables' fallbacks and \`--sb-*\` tokens only`
      );
    }
    return;
  }
  if (prop.startsWith(SB_COLOR_PREFIX)) {
    if (name !== BASE_FILE) {
      errors.push(
        `${at(loc)}: \`${prop}\` is in the \`${SB_COLOR_PREFIX}*\` namespace, which only ${BASE_FILE} may declare`
      );
    }
    return;
  }
  const owner = ownerOf(prop);
  if (name === BASE_FILE) {
    if (isReserved(prop)) {
      errors.push(
        `${at(loc)}: \`${prop}\` is in a reserved namespace (${RESERVED.join(', ')}); base declares global tokens only`
      );
    }
    return;
  }
  if (isReserved(prop) && !owner) {
    errors.push(
      `${at(loc)}: \`${prop}\` matches no component or view file; the name after the reserved prefix must be a file's basename`
    );
    return;
  }
  const own = namespaces.find((ns) => ns.file === name);
  if (own && owner?.file !== name) {
    errors.push(
      `${at(loc)}: \`${prop}\` is outside this file's namespace; declare only \`${own.prefix}*\` here (global tokens go in base)`
    );
  }
}

function checkStyle(style, { layer, top, ownProps, at, name }) {
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
    const declared = decl.property === 'custom' ? decl.value.name : null;
    if (declared) checkDeclared(declared, { name, at, loc });
    for (const ref of vars(decl.value)) {
      checkRead(ref, { layer, ownProps, at, name, loc, declared });
    }
  }
  for (const child of rules) checkNested(child, { layer, ownProps, at, name });
}

/** One `var()` read: where its property is declared, whether it may fall back. */
function checkRead(ref, { layer, ownProps, at, name, loc, declared }) {
  const prop = ref.name.ident;
  const fallback = Boolean(ref.fallback);
  if (isReserved(prop) && !ownerOf(prop)) {
    errors.push(
      `${at(loc)}: var(${prop}) matches no component or view file; the name after the reserved prefix must be a file's basename`
    );
    return;
  }
  // Host colours: read only by the bridge in base (inside a `--sb-color-*`
  // declaration), with the fallback inline.
  if (prop.startsWith(HOST_COLOR_PREFIX)) {
    if (!HOST_VARIABLES.has(prop)) {
      errors.push(
        `${at(loc)}: var(${prop}) is not an MCP Apps style variable (McpUiStyleVariableKey), so no host sends it`
      );
    } else if (layer !== 'base' || !declared?.startsWith(SB_COLOR_PREFIX)) {
      errors.push(
        `${at(loc)}: var(${prop}) is a host colour; use the \`${SB_COLOR_PREFIX}*\` token the bridge in base maps it to (host colours are read only inside a \`${SB_COLOR_PREFIX}*\` declaration in base)`
      );
    } else if (!fallback) {
      errors.push(
        `${at(loc)}: var(${prop}) in the bridge needs an inline fallback for hosts that do not send it`
      );
    }
    return;
  }
  // Global tokens (anything `base` declares): fallbacks only in base.
  if (declaredInBase.has(prop)) {
    if (fallback && layer !== 'base') {
      errors.push(`${at(loc)}: var(${prop}, …) fallback outside base`);
    }
    return;
  }
  if (!prop.startsWith('--sb-')) {
    if (fallback && layer !== 'base') {
      errors.push(`${at(loc)}: var(${prop}, …) fallback outside base`);
    }
    if (!ownProps.has(prop)) {
      errors.push(`${at(loc)}: var(${prop}) has no fallback declared in base`);
    }
    return;
  }
  const owner = ownerOf(prop);
  if (!owner) {
    errors.push(
      `${at(loc)}: var(${prop}) is neither a global token declared in base nor in any component's namespace`
    );
  } else if (owner.file === name) {
    if (fallback) {
      errors.push(
        `${at(loc)}: var(${prop}, …) has a fallback; a component reads its own namespace without one`
      );
    }
    if (!declaredByFile.get(name).has(prop)) {
      errors.push(`${at(loc)}: var(${prop}) is not declared in this file`);
    }
  } else {
    if (!fallback) {
      errors.push(
        `${at(loc)}: var(${prop}) reads the namespace of ${owner.file}; it needs a fallback, \`var(${prop}, …)\`, for views that do not ship that file`
      );
    }
    if (!declaredByFile.get(owner.file).has(prop)) {
      errors.push(`${at(loc)}: var(${prop}) is not declared in ${owner.file}`);
    }
  }
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

// Every view must load base.css first, so the layer order statement is the
// first CSS in its bundle.
const viewsDir = join(root, 'src/views');
for (const entry of readdirSync(viewsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const main = join(viewsDir, entry.name, 'main.tsx');
  const name = relative(root, main);
  let code;
  try {
    code = readFileSync(main, 'utf8');
  } catch {
    continue;
  }
  const first = code.match(/^import\b[^;]*;/m)?.[0];
  if (!first?.includes('shared/base.css')) {
    errors.push(
      `${name}: the first import must be \`import '../../shared/base.css';\``
    );
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
