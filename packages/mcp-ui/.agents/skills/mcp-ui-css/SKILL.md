---
name: mcp-ui-css
description: |
  Guide for authoring CSS in packages/mcp-ui (the MCP Apps views): native stylesheets organized in cascade layers, specificity capped with :where(), colours from Studio's semantic tokens (bridged from the host's MCP Apps style variables), and fonts and radii from the host's variables. Use when adding or editing any .css file, className, data-slot, data-state or data-tone in packages/mcp-ui, or when adding a view.
---

# MCP UI CSS

Reference implementation: `packages/mcp-ui/src/shared/base.css` and the component files beside it (`badge.css`, `copy-field.css`, …).

Each view is a single-file HTML document that a host (Claude, ChatGPT, an IDE) renders in an iframe inside its own UI. Two consequences shape every rule here:

- **The host owns the look.** It sends a theme, fonts and a set of standard style variables. A view that ignores them looks foreign inside the host. Supabase's own design values are only a fallback for hosts that send nothing. Colours reach components as Studio's semantic tokens, so the components can move into Studio unchanged (see Host theming).
- **Views multiply.** Views share the same rules, so a selector that wins by weight or by source order today breaks someone else's view later. Layers and `:where()` keep every rule trivially overridable.

We stay close to the platform: plain CSS, native nesting, custom properties, `@layer`, `:where()`, logical properties. No Tailwind, no CSS-in-JS, no preprocessors, no utility-class styling.

## Three primary patterns

### 1. Every rule lives in a layer

```css
@layer base, native, components, view, utilities;
```

The statement lives only in `src/shared/base.css`, which holds `base`, `native` and `utilities`. Every view's `main.tsx` imports `base.css` as its first import, so the order is fixed before any other layered rule loads. Other CSS files do not repeat the statement.

Each shared component keeps its `components` rules in `src/shared/<component>.css`, named after its class (`badge.css` for `.badge`), and the TSX file that renders it imports that CSS (`import './badge.css';`). A view only ships the CSS of the components it imports, so a view that never imports `CopyField` never carries `.copy-field`'s rules. A file has at most one block per layer, and a class is styled in only one file: the order of `components` rules across files follows import order and can differ between views. Where several TSX files render the same markup, each imports the CSS. Button variants (`data-size`, `.primary`) have no component of their own: they live in `button.css`, imported by each TSX file that renders a variant.

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
    color: var(--sb-color-muted-foreground);

    &:where([data-tone="danger"]) {
      color: var(--sb-color-destructive);
    }
  }

  :where(.copy-field) {
    display: flex;
    flex-direction: column;
    gap: var(--sb-space-1);

    :where([data-slot="control"] [data-slot="value"]) {
      flex: 1;
      min-inline-size: 0;
    }
  }
}
```

**A variant restates every state of a property it changes.** `button:where(.primary)` sets `background`, so it needs its own hover and its own `&:where(:disabled)`. Otherwise its background, sitting in a later layer, overrides the native button's disabled background.

### 3. A view's own styles are one nested block under its wrapper

Each view component renders a wrapper element with a class ending in `-view`. Most views need no CSS of their own. When one does, create `src/views/<view>/view.css`, import it in that view's `main.tsx` after `base.css`, and give it exactly this shape:

```css
@layer view {
  .create-project-view {
    :where([data-slot="header"]) {
      align-items: center;
    }
  }
}
```

If a second view needs the same piece, move it to a component: a `src/shared/<component>.css` in `components`, imported by the component's TSX.

### The `utilities` layer is for rules that must always win

`utilities` sits above `view` so that nothing a component or a view declares can undo it. It holds one class today, `.sr-only`: content hidden visually but read by screen readers has to stay hidden whatever else styles that element.

It is not a place for layout or colour helpers (`.row`, `.stack`, `.text-muted`); those belong in a component rule. Add a class here only when all of these hold: it does one thing, it is correct on any element, and a component or view overriding it would be a bug. Expect this layer to stay nearly empty.

## Host theming

The SDK's `useHostStyles` writes the host's style variables as inline styles on `<html>`, sets `data-theme` and an inline `color-scheme`, and injects the host's font faces. Inline styles beat any stylesheet declaration in any layer.

Colours go through one more step, because these components will move into Studio and because hosts disagree about what each MCP Apps colour variable means (Claude's `--color-border-primary` is a strong 40% line, Codex's is a control outline; Claude's `--color-background-primary` is its raised white surface, Codex's is the app surface). Components use **Studio's semantic tokens**, and a **host bridge** at the top of `base` maps the host's variables onto them. The table and the reasons for each choice are in the bridge's comment in `base.css`.

1. **Colours: Studio's semantic tokens only.** `--sb-color-foreground`, `--sb-color-muted-foreground`, `--sb-color-tertiary-foreground`, `--sb-color-background`, `--sb-color-foreground-contrast`, `--sb-color-card`, `--sb-color-muted`, `--sb-color-border`, `--sb-color-input`, `--sb-color-ring`, `--sb-color-primary`, `--sb-color-warning`, `--sb-color-destructive` and the status borders `--sb-color-border-primary-bright`, `--sb-color-border-warning` and `--sb-color-border-destructive`: Studio's core names (in `packages/ui/build/css/source/semantic.css` in the supabase monorepo) behind the `--sb-color-` prefix. Never the legacy names in `compat.css` (`--background-surface-*`, `--foreground-light`, `--border-muted`, `--brand-*`), and never a host `--color-*` variable outside the bridge: `pnpm lint:css` fails on that, and on any `--sb-color-*` declared outside `base.css`.
2. **The bridge is the only place a host colour is read.** Each `--sb-color-*` token is `var(<host variable>, <fallback>)` on `:where(:root)` in `base`. To use a new Studio token, add it to the bridge with the host variable that means the same thing in every host (check what Claude and Codex send, not just the name), or derive it there.
3. **Fallback values come from the Supabase design system** (`packages/ui/build/css` in the supabase monorepo). They apply only where the host sends nothing.
4. **Derive as Studio derives.** Status tints and borders are the status colour at 10% and 30% (`color-mix(in oklab, var(--sb-color-warning) 10%, transparent)`), not the host's status borders. Disabled controls fade with `opacity`, as Studio's do.
5. **Everything else that isn't a colour uses the host's variables directly:** `--font-sans`, `--font-mono`, `--font-weight-*`, `--font-text-{xs,sm,md,lg}-{size,line-height}`, `--border-radius-*`, `--border-width-regular`. Their fallbacks live once in `base`: never write `var(--x, fallback)` elsewhere, except a read of another component's `--sb-component-<component>-*` property (see Local tokens). A literal colour or font size in `native`, `components` or `view` is a bug. The full list of host names is the `McpUiStyleVariableKey` type in `node_modules/@modelcontextprotocol/ext-apps/dist/src/spec.types.d.ts`.
6. **Dark mode is `light-dark()` in `base` and nothing else.** The root declares `color-scheme: light dark`; the host's theme overrides it inline; `light-dark()` follows. Never select on `[data-theme]` or `prefers-color-scheme` to change a colour.
7. **Keep the body background transparent.** The host's surface shows through.
8. **Fonts are the host's or the system's.** Do not load font files; the views ship as one small HTML file with no network access.

### Local tokens

Where the host standard has no variable, use a local token prefixed `--sb-`. The prefix keeps local names from colliding with host names added later, so never name a local token `--color-*`, `--font-*`, `--border-*` or `--shadow-*`. Studio's semantic colour tokens (`--sb-color-border`, `--sb-color-card`, …) are not local tokens: they keep Studio's names behind the `--sb-color-` prefix, which only `base.css` may declare, so components can move there by dropping the prefix.

- `--sb-space-1` to `--sb-space-4` (4px, 8px, 12px, 16px): the host standard has no spacing scale. Use these for gaps and padding; a one-off size may stay literal.
- `--sb-inset-top`, `-right`, `-bottom`, `-left`: the host's safe-area insets, set from JS in `src/shared/use-host-styles.ts`.

- `--sb-component-<component>-*`: a custom property that belongs to one component, named after the component's CSS file, which is also the class it owns (`--sb-component-project-card-radius` in `project-card.css`; a view's `view.css` uses `--sb-view-<view>-*`). Declare it on the component's rule, in any layer; it needs no fallback in `base`. A file may declare only its own namespace. `--sb-component-` and `--sb-view-` are reserved: `base.css` declares none, and a name under them that matches no file is an error, so a global token can never be mistaken for a component's. The linter resolves a name to the longest matching file name, so `project` and `project-card` can coexist. A file reads its own namespace with no fallback, and the property must be declared in that same file.
- Reading another component's namespace needs a fallback: `var(--sb-component-project-card-radius, var(--border-radius-lg))`. `connection-details.css` aligns with the card it sits in this way. A view can ship `connection-details.css` without `project-card.css`, and without the fallback the read would be invalid there. This is the one place outside `base` where a `var()` fallback is allowed, and there it is required. Write the fallback with the global tokens the owner declares its property with, so the component looks right on its own, or a zero where the property is a padding that margins cancel. The linter also fails if the property is not declared in the other component's file, which catches typos and stale names.

Add a local token when a value is reused or carries meaning. Do not add one for a single use.

## Markup

- **One component class per element.** No class stacks (`card card-body stack`) and no styling by utility classes. The only class that may be added alongside a component class is one from the `utilities` layer.
- **A class names a component; `data-slot` names a part.** A component stands alone and can be placed anywhere (`.badge`, `.icon`); it gets a class, its own top-level rule in `components`, and its own React component. A part only exists inside one component (the title row or the note of `.project-card`); it gets `data-slot`, never a class, and is styled nested in its component: `:where(.project-card) { :where([data-slot="note"]) { … } }`. A part can still carry state: `<div data-slot="note" data-tone="danger">`.
- **Every `data-slot` rule is nested inside its component's rule.** A bare `:where([data-slot="…"])` at the top of a layer is global: it matches that slot name in every component. If something is styled the same wherever it appears, it is a component and needs a class.
- **Qualify a part by its parent part when the parent gives it its meaning.** A part with a generic name (`name`, `retry`, `note-text`) or one that is a piece of a group (one `detail` of the `details`) is selected through the part it belongs to, inside one `:where()`: `:where([data-slot="title-row"] [data-slot="name"])`. The selector then says what the part is for, and it reads like the markup. Go up one level only, not the full path, so restructuring the markup above that parent doesn't break the rule. Parts that name a section of the component on their own (`header`, `details`, `note`) and parts used in several places (`skeleton`) stay unqualified. `:where()` keeps the added level at zero specificity.
- **Never nest one component's rule inside another's.** If a component needs to look different in one place, that is a `view` override or a variant attribute on the component.
- **State and tone use attributes**, not modifier classes: `data-state="failed"`, `data-tone="success" | "warning" | "danger"`, or the ARIA attribute where one exists (`aria-busy`, `aria-current`). Tone names are `success`, `warning` and `danger`; the CSS maps them to `--sb-color-primary`, `--sb-color-warning` and `--sb-color-destructive`.
- **Target the part, not the tag.** Avoid descendant selectors on bare tags (`svg`, `p`, `span`) inside a component; they style content added later by accident.
- **No inline `style` props**, except custom properties set from JS for values CSS cannot know.
- Class names are kebab-case; view wrappers end in `-view`.

## Secondary patterns

- **Logical properties**: `padding-block`, `margin-inline`, `min-inline-size`, `border-block-end`.
- **Layout**: flex or grid with `gap`; avoid sibling margins.
- **Sizing**: `base` sets `box-sizing: border-box` on every element, so a `block-size` or `inline-size` includes padding and border. Do not restate it per component.
- **Controls**: `font: inherit` on buttons; hover is always `:hover:not(:disabled)`.
- **Focus**: one global `:where(:focus-visible)` outline in `base`, coloured by `--sb-color-ring`. Do not remove or restyle it per component.
- **Motion**: nest `@media (prefers-reduced-motion: reduce)` inside the rule it modifies. Declare `@keyframes` in `base`: animation names are global to the document whichever layer declares them (the layer only decides which wins when two share a name), so they belong with the other document-wide definitions.
- **Width**: views are narrow and the host sets the width. Do not add width media queries; let content wrap.

## Build gotchas

- Vite minifies CSS with lightningcss, which by default rewrites `light-dark()` into a `prefers-color-scheme` polyfill. That polyfill ignores the host's theme, so a dark host on a light OS would get light colours. `vite.config.ts` excludes that transform (`Features.LightDark`). Do not remove the exclusion.
- The dev server does not minify. Anything about theming must also be checked against the built output: open the mock host with `?source=dist` after a build.
- The build flattens native nesting. Specificity is unchanged as long as every nested selector is inside `:where()`.

## Checklist

1. Pick the layer by scope: token, root or reset → `base`; bare element → `native` (both in `base.css`); shared class → `components`, in `src/shared/<component>.css` imported by the component; one view → `view` in that view's `view.css`; must win everywhere → `utilities` (rare).
2. Add the rule to the file's existing layer block. Check its specificity against the layer's cap and wrap the rest in `:where()`.
3. Use Studio's semantic tokens for colour (add any new one to the host bridge in `base.css`), host variables for type, radius and border width, and `--sb-*` for spacing.
4. One component class per element; parts as `data-slot`; state as `data-state`, `data-tone` or ARIA. No `!important`, ids, utility-class styling or inline styles.
5. From `packages/mcp-ui`: `pnpm lint:css`, then `pnpm build`. From the repo root: `pnpm format`.
6. In the mock host (`pnpm dev`), check light and dark, with and without host style variables, and once with `?source=dist`.
