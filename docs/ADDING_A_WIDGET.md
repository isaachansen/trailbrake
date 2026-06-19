# Adding a widget

Widgets are sim-agnostic presentational components. Adding one is small and
touches no core/layout code (§10) — you write a component + a definition and
register it.

## 1. Write the component

Create `src/widgets/MyWidget.tsx`. It receives `BaseWidgetProps<C>`
(`src/widgets/contract.ts`): `theme`, your typed `config`, `caps` (what the sim
provides), and `size`.

- **Slow-path data** (session, standings, laps, deltas): read it with the
  `useSlow()` hook (`src/store/hooks.ts`). The component re-renders only when the
  slow sample changes.
- **Fast-path data** (~60 Hz: pedals/rpm/steering): do **not** use React state.
  Read `store.latestFast` / `store.history` directly inside a
  `requestAnimationFrame` loop (see `InputGraph.tsx`). Re-rendering React at
  60 Hz is the stutter we exist to avoid.
- Use `em`-based sizing so the per-widget `scale` works; the host sets
  `font-size`. Canvas widgets fill `size` and use `devicePixelRatio`.
- Keep it flat — no big blurs / large semi-transparent fills (§3.5).

## 2. Export a `WidgetDefinition`

In the same file:

```ts
export const myWidgetDef: WidgetDefinition<MyConfig> = {
  id: "my-widget",                 // stable; used in saved layouts
  name: "My Widget",
  defaultSize: { w: 280, h: 120 },
  minSize: { w: 160, h: 60 },
  defaultConfig: { /* ... */ },
  requiredPaths: ["slow"],         // "fast" | "slow"
  requiredCapabilities: ["deltas"],// hides the widget on sims lacking these
  configSchema: [                  // becomes the settings UI automatically
    { key: "rows", label: "Rows", type: "number", min: 1, max: 10, step: 1 },
    { key: "showFoo", label: "Foo", type: "boolean" },
    { key: "mode", label: "Mode", type: "enum",
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
  ],
  Component: MyWidget,
};
```

## 3. Register it

Add it to `DEFS` in `src/widgets/registry.ts`. That's it — the add-widget menu,
the schema-driven settings panel, capability-based hiding, and layout
persistence all pick it up automatically.

## Notes

- `requiredCapabilities` drives graceful hiding: if the active sim can't provide
  them, the widget is hidden in race mode and shows an "unavailable" note in edit
  mode. Also hide individual fields when a value is `null` (don't fake data).
- Test it instantly in a browser: `npm run dev`, press `e` for edit mode. The JS
  mock (`src/store/mockSource.ts`) feeds realistic data with no sim attached.
