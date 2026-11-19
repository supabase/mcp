---
name: mcp-ui-css
description: |
  Guide for authoring CSS in packages/mcp-ui (the MCP Apps views): one native stylesheet organized in cascade layers, specificity capped with :where(), and colours, fonts and radii taken from the host's MCP Apps style variables. Use when adding or editing any .css file, className, data-slot, data-state or data-tone in packages/mcp-ui, or when adding a view.
---

# MCP UI CSS

Reference implementation: `packages/mcp-ui/src/shared/styles.css`.

Each view is a single-file HTML document that a host (Claude, ChatGPT, an IDE) renders in an iframe inside its own UI. Two consequences shape every rule here:

- **The host owns the look.** It sends a theme, fonts and a set of standard style variables. A view that ignores them looks foreign inside the host. Supabase's own design values are only a fallback for hosts that send nothing.
- **Views multiply.** Every view shares one stylesheet, so a selector that wins by weight or by source order today breaks someone else's view later. Layers and `:where()` keep every rule trivially overridable.

We stay close to the platform: plain CSS, native nesting, custom properties, `@layer`, `:where()`, logical properties. No Tailwind, no CSS-in-JS, no preprocessors, no utility-class styling.

## Three primary patterns

### 1. Every rule lives in a layer

```css
@layer base, native, components, view, utilities;
```

`src/shared/styles.css` starts with this statement and defines `base`, `native`, `components` and `utilities` in exactly one block each. Add rules to the existing block; never append a second block for the same layer.

Later layers win over earlier ones regardless of specificity, so never reach for `!important` or a heavier selector to override across layers.

| Layer        | Purpose                                                                              | Max specificity                              |
| ------------ | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| `base`       | Tokens on the root, root and body typography, safe-area padding, the focus ring, `@keyframes` | Zero: wrap everything in `:where()`          |
| `native`     | Bare HTML elements (`button`, `a`, `code`, `p`)                                       | A single element selector                    |
| `components` | Shared components and their parts; class variants of native elements                  | At most a single element; usually zero       |
| `view`       | Overrides for one view, under its wrapper class                                       | A single class selector (the view wrapper)   |
| `utilities`  | The few single-purpose classes that must win over everything, wherever they are used  | Zero: `:where(.class)`                       |

### 2. Cap specificity per layer; everything past the cap goes in `:where()`

- `base`: `:where(:root)`, `:where(body)`, `:where(:focus-visible)`.
- `native`: a bare element selector. States go inside `:where()` so the rule stays at one element: `&:where(:hover:not(:disabled))`, `&:where(:disabled)` (not `:where(&:disabled)`, which drops to zero specificity and loses to the bare element).
  - One exception: a link that looks like a button (`<a class="button">`) shares the native button rule through a selector list, `:is(button, a:where(.button))`. `:is()` takes its heaviest argument, so it stays at one element. Button variants use the same list (`:is(button, a:where(.button)):where(.primary)`), and the text-link rule excludes it (`a:where(:not(.button))`) so neither depends on source order. Plain CSS has no mixins; a selector list is how two selectors share one set of styles. Don't copy button declarations into a separate link rule.
- `components`: wrap the class in `:where()`: `:where(.badge)`. A variant of an element is element plus `:where(.class)`: `button:where(.primary)` (written `:is(button, a:where(.button)):where(.primary)` so button-styled links get it too). Parts and states nested inside also use `:where()`.
- `view`: one bare class (`.create-project-view`); everything nested uses `:where()`.
- `utilities`: `:where(.sr-only)`. It is the last layer, so it wins without any specificity.
- Never chain classes, never use ids, never nest without `:where()` (a nested `code` inside `.x` becomes `.x code` and raises specificity).

```css
@layer components {
  :where(.badge) {
    color: var(--color-text-secondary);

    &:where([data-tone="danger"]) {
      color: var(--color-text-danger);
    }
  }

  :where(.copy-field) {
    display: flex;
    flex-direction: column;
    gap: var(--sb-space-1);

    :where([data-slot="value"]) {
      flex: 1;
      min-inline-size: 0;
    }
  }
}
```

**A variant restates every state of a property it changes.** `button:where(.primary)` sets `background`, so it needs its own hover and its own `&:where(:disabled)`. Otherwise its background, sitting in a later layer, overrides the native button's disabled background.

### 3. A view's own styles are one nested block under its wrapper

Each view component renders a wrapper element with a class ending in `-view`. Most views need no CSS of their own. When one does, create `src/views/<view>/view.css`, import it in that view's `main.tsx` after the shared stylesheet, and give it exactly this shape:

```css
@layer base, native, components, view, utilities;

@layer view {
  .create-project-view {
    :where([data-slot="header"]) {
      align-items: center;
    }
  }
}
```

Repeat the order statement at the top of every `view.css`. Each view is built as a separate document, and the repeated statement is what keeps the layer order fixed whatever the import order.

If a second view needs the same piece, move it to `components` in the shared stylesheet.

### The `utilities` layer is for rules that must always win

`utilities` sits above `view` so that nothing a component or a view declares can undo it. It holds one class today, `.sr-only`: content hidden visually but read by screen readers has to stay hidden whatever else styles that element.

It is not a place for layout or colour helpers (`.row`, `.stack`, `.text-muted`); those belong in a component rule. Add a class here only when all of these hold: it does one thing, it is correct on any element, and a component or view overriding it would be a bug. Expect this layer to stay nearly empty.

## Host theming

The SDK's `useHostStyles` writes the host's style variables as inline styles on `<html>`, sets `data-theme` and an inline `color-scheme`, and injects the host's font faces. Inline styles beat any stylesheet declaration in any layer. That is the whole mechanism: we declare a fallback for a variable once, and the host's value replaces it whenever the host sends one.

1. **Use the host's variable names directly.** `color: var(--color-text-primary)`, not a local alias such as `--text`. The full list of names is the `McpUiStyleVariableKey` type in `node_modules/@modelcontextprotocol/ext-apps/dist/src/spec.types.d.ts`. It covers `--color-background-*`, `--color-text-*`, `--color-border-*`, `--color-ring-*`, `--font-sans`, `--font-mono`, `--font-weight-*`, `--font-text-{xs,sm,md,lg}-{size,line-height}`, `--font-heading-*`, `--border-radius-*`, `--border-width-regular` and `--shadow-*`.
2. **Reach for a host variable before any literal.** If the property is a colour, a font family, weight, size or line-height, a radius, a border width or a shadow, there is a host variable for it. A literal colour or font size in `native`, `components` or `view` is a bug.
3. **Fallbacks live once, in `base`, on `:where(:root)`.** Never write `var(--x, fallback)` anywhere else. Before first use of a host variable that has no fallback yet, add one to `base`.
4. **Fallback values come from the Supabase design system** (`apps/design-system` and `packages/ui/build/css` in the supabase monorepo), and only there. They exist for hosts that omit a variable. Never use a Supabase value where a host variable exists.
5. **Derive a fallback from another host variable when the design system does.** The border fallback is the primary text colour at low alpha, the badge fill is the status text colour at 10%. Written with `color-mix()` over the host variable, these stay coherent when a host sends only some variables.
6. **Dark mode is `light-dark()` in `base` and nothing else.** The root declares `color-scheme: light dark`; the host's theme overrides it inline; `light-dark()` follows. Never select on `[data-theme]` or `prefers-color-scheme` to change a colour.
7. **Keep the body background transparent.** The host's surface shows through.
8. **Fonts are the host's or the system's.** Do not load font files; the views ship as one small HTML file with no network access.

### Local tokens

Where the host standard has no variable, use a local token prefixed `--sb-`. The prefix keeps local names from colliding with host names added later, so never name a local token `--color-*`, `--font-*`, `--border-*` or `--shadow-*`.

- `--sb-space-1` to `--sb-space-4` (4px, 8px, 12px, 16px): the host standard has no spacing scale. Use these for gaps and padding; a one-off size may stay literal.
- `--sb-inset-top`, `-right`, `-bottom`, `-left`: the host's safe-area insets, set from JS in `src/shared/use-host-styles.ts`.

- `--sb-local-*`: a custom property scoped to one component, not a global token. Declare it on the owning component's rule (for example `--sb-local-card-padding-inline` on `.progress-card`), in any layer; it needs no fallback in `base`. Rules that style parts of that component from elsewhere, such as a part that only ever renders inside the card, may read it, because they are its descendants in the DOM. The linter does not require a base declaration for these, but does fail if a `--sb-local-*` variable is read and declared nowhere in the stylesheet, which catches typos. Use it to share a value between a component and its descendants' rules; use plain `--sb-*` for a token any rule may use.

Add a local token when a value is reused or carries meaning. Do not add one for a single use.

## Markup

- **One component class per element.** No class stacks (`card card-body stack`) and no styling by utility classes. The only class that may be added alongside a component class is one from the `utilities` layer.
- **A class names a component; `data-slot` names a part.** A component stands alone and can be placed anywhere (`.badge`, `.icon`); it gets a class, its own top-level rule in `components`, and its own React component. A part only exists inside one component (the header or the current step of `.progress-card`); it gets `data-slot`, never a class, and is styled nested in its component: `:where(.progress-card) { :where([data-slot="step"]) { … } }`. A part can still carry state: `<div data-slot="step" data-state="failed">`.
- **Every `data-slot` rule is nested inside its component's rule.** A bare `:where([data-slot="…"])` at the top of a layer is global: it matches that slot name in every component. If something is styled the same wherever it appears, it is a component and needs a class.
- **Never nest one component's rule inside another's.** If a component needs to look different in one place, that is a `view` override or a variant attribute on the component.
- **State and tone use attributes**, not modifier classes: `data-state="failed"`, `data-tone="success" | "warning" | "danger"`, or the ARIA attribute where one exists (`aria-busy`, `aria-current`). Tone names match the host variable names, so `danger`, not `destructive`.
- **Target the part, not the tag.** Avoid descendant selectors on bare tags (`svg`, `p`, `span`) inside a component; they style content added later by accident.
- **No inline `style` props**, except custom properties set from JS for values CSS cannot know.
- Class names are kebab-case; view wrappers end in `-view`.

## Secondary patterns

- **Logical properties**: `padding-block`, `margin-inline`, `min-inline-size`, `border-block-end`.
- **Layout**: flex or grid with `gap`; avoid sibling margins.
- **Controls**: `font: inherit` on buttons; hover is always `:hover:not(:disabled)`.
- **Focus**: one global `:where(:focus-visible)` outline in `base`, coloured by `--color-ring-primary`. Do not remove or restyle it per component.
- **Motion**: nest `@media (prefers-reduced-motion: reduce)` inside the rule it modifies. Declare `@keyframes` in `base`: animation names are global to the document whichever layer declares them (the layer only decides which wins when two share a name), so they belong with the other document-wide definitions.
- **Width**: views are narrow and the host sets the width. Do not add width media queries; let content wrap.

## Build gotchas

- Vite minifies CSS with lightningcss, which by default rewrites `light-dark()` into a `prefers-color-scheme` polyfill. That polyfill ignores the host's theme, so a dark host on a light OS would get light colours. `vite.config.ts` excludes that transform (`Features.LightDark`). Do not remove the exclusion.
- The dev server does not minify. Anything about theming must also be checked against the built output: open the mock host with `?source=dist` after a build.
- The build flattens native nesting. Specificity is unchanged as long as every nested selector is inside `:where()`.

## Checklist

1. Pick the layer by scope: token, root or reset → `base`; bare element → `native`; shared class → `components`; one view → `view` in that view's `view.css`; must win everywhere → `utilities` (rare).
2. Add the rule to the existing layer block. Check its specificity against the layer's cap and wrap the rest in `:where()`.
3. Use host variables for colour, type, radius, border width and shadow; `--sb-*` for spacing. Add any new fallback to `base`.
4. One component class per element; parts as `data-slot`; state as `data-state`, `data-tone` or ARIA. No `!important`, ids, utility-class styling or inline styles.
5. From `packages/mcp-ui`: `pnpm lint:css`, then `pnpm build`. From the repo root: `pnpm format`.
6. In the mock host (`pnpm dev`), check light and dark, with and without host style variables, and once with `?source=dist`.
