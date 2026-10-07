import type { ModuleKind } from '@multiverse/engine';

/** How many categorical hues the palette has (src/styles.css, --series-1 ... --series-8). */
export const SERIES_SLOTS = 8;

export const INK = 'var(--ink)';
/** Past the eighth module: never a generated hue, a neutral that the direct labels carry. */
export const OTHER = 'var(--series-other)';

/**
 * A fixed colour for each module, assigned in plan order and never by rank, so filtering or deviating does not repaint
 * anyone. The delivery module (kind PROJECT) is drawn in ink: it is the line everything else is measured against.
 */
export function moduleColors(modules: ReadonlyArray<{ id: string; kind: ModuleKind }>): Map<string, string> {
  const colors = new Map<string, string>();
  let slot = 0;
  for (const m of modules) {
    if (m.kind === 'PROJECT') {
      colors.set(m.id, INK);
      continue;
    }
    colors.set(m.id, slot < SERIES_SLOTS ? `var(--series-${slot + 1})` : OTHER);
    slot += 1;
  }
  return colors;
}
