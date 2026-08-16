/**
 * PR6 Phase 2 — shared rule building blocks.
 *
 * The two dominant rule shapes in the engine are:
 *
 *   - container-required rules: the element itself must establish a
 *     formatting context (`justify-content` on a non-flex/grid element);
 *   - item-required rules: the element must be an item of a container
 *     (`grid-column` on an element whose parent is not a grid container).
 *
 * Both shapes are created through the builders below so every rule
 * follows the same conservative contract:
 *
 *   - missing/empty `display` (container rules) → no decision;
 *   - unknown parent (`parentDisplay` normalized to 'none') → no decision,
 *     because the builder reports 'none' both for a genuinely parent-less
 *     element and for a failed parent lookup;
 *   - the active predicate is the ONLY per-rule difference, so a rule can
 *     never drift from the shared contract.
 *
 * PR6 Phase 3 added the box-suppressed and position-offset builders, plus
 * small shared predicates. Within every rule, conditions are ordered
 * most-specific-first, which is how conflicts are resolved: a
 * `display: contents` element (no box at all) beats absolutely-positioned
 * beats flex/grid item beats plain block — the FIRST matching condition
 * wins and produces the single result for the declaration.
 */
import { MatchedCssDeclaration } from '../../engine/inactivePropertyEngine';
import { LayoutContext, NO_PARENT_DISPLAY } from '../../engine/layoutContext';
import { InactiveResult, InactiveRule } from '../inactiveRule';
import { ReasonCode, REASON_CODES } from '../reasonCode';

/** Build a single inactive result — every rule emits exactly one. */
export function inactiveResult(
  propertyName: string,
  reasonCode: ReasonCode,
  reasonText: string
): InactiveResult {
  return { inactive: true, propertyName, reasonCode, reasonText };
}

/** Whether the element is taken out of flow by absolute/fixed positioning. */
export function isAbsoluteOrFixed(layout: LayoutContext): boolean {
  return layout.position === 'absolute' || layout.position === 'fixed';
}

/**
 * Whether the element is out of flow (`position: absolute | fixed`) as
 * exposed by the prebuilt LayoutContext. Out-of-flow boxes stop being
 * flex/grid items, so item-dependent properties lose their effect.
 */
export function isOutOfFlow(layout: LayoutContext): boolean {
  return layout.isOutOfFlow;
}

/** Whether the element generates no box at all (`display: contents`). */
export function isBoxSuppressed(layout: LayoutContext): boolean {
  return layout.display === 'contents';
}

/** Standard reason text for the box-suppressed condition. */
export function boxSuppressedReasonText(propertyName: string): string {
  return `${propertyName} has no effect because this element generates no box (display: contents).`;
}

/** Active predicate: is the element a flex container (`flex`/`inline-flex`)? */
export function isFlexContainer(layout: LayoutContext): boolean {
  return layout.isFlexContainer;
}

/** Active predicate: is the element a grid container (`grid`/`inline-grid`)? */
export function isGridContainer(layout: LayoutContext): boolean {
  return layout.isGridContainer;
}

/** Active predicate: does the element establish flex OR grid formatting? */
export function isFlexOrGridContainer(layout: LayoutContext): boolean {
  return layout.isFlexContainer || layout.isGridContainer;
}

/** Active predicate: is the element a flex item (parent is a flex container)? */
export function isFlexItem(layout: LayoutContext): boolean {
  return layout.isFlexItem;
}

/** Active predicate: is the element a grid item (parent is a grid container)? */
export function isGridItem(layout: LayoutContext): boolean {
  return layout.isGridItem;
}

/** Active predicate: is the element a flex OR grid item? */
export function isFlexOrGridItem(layout: LayoutContext): boolean {
  return layout.isFlexItem || layout.isGridItem;
}

/**
 * PR7 — predicates ported from Chromium's `CSSRuleValidatorHelper.ts`.
 * All of them reason over already-normalized LayoutContext fields, so the
 * multi-keyword display logic below operates on canonical values exactly
 * like the reference does.
 */

/**
 * Whether the element establishes a grid-lanes formatting context
 * (experimental Chromium display values, checked by the reference).
 */
export function isGridLanesContainer(layout: LayoutContext): boolean {
  return layout.display === 'grid-lanes' || layout.display === 'inline-grid-lanes';
}

/** Whether the parent establishes a grid-lanes formatting context. */
export function isGridLanesItem(layout: LayoutContext): boolean {
  return layout.parentDisplay === 'grid-lanes' || layout.parentDisplay === 'inline-grid-lanes';
}

/** Active predicate: grid OR grid-lanes container (reference GridContainerValidator). */
export function isGridOrGridLanesContainer(layout: LayoutContext): boolean {
  return isGridContainer(layout) || isGridLanesContainer(layout);
}

/** Active predicate: grid OR grid-lanes item (reference GridItemValidator). */
export function isGridOrGridLanesItem(layout: LayoutContext): boolean {
  return isGridItem(layout) || isGridLanesItem(layout);
}

/** Active predicate: flex, grid OR grid-lanes container. */
export function isFlexOrGridOrGridLanesContainer(layout: LayoutContext): boolean {
  return isFlexContainer(layout) || isGridContainer(layout) || isGridLanesContainer(layout);
}

/** Active predicate: flex, grid OR grid-lanes item. */
export function isFlexOrGridOrGridLanesItem(layout: LayoutContext): boolean {
  return isFlexItem(layout) || isGridItem(layout) || isGridLanesItem(layout);
}

/** Whether the element is a plain inline box (display: inline). */
export function isInlineElement(layout: LayoutContext): boolean {
  return layout.display === 'inline';
}

/**
 * Advanced-context — whether the element is provably a NON-REPLACED inline
 * box (`display: inline`, not a replaced element such as `<img>`). The
 * browser box model ignores vertical margins and geometric transforms on
 * such boxes.
 *
 *   - `true`  → provably inline non-replaced;
 *   - `false` → provably NOT inline non-replaced (other display, or a
 *     replaced element);
 *   - `undefined` → cannot tell (unknown node name) — conservative.
 */
export function isInlineNonReplacedElement(layout: LayoutContext): boolean | undefined {
  if (layout.display !== 'inline') {
    return false;
  }
  if (!layout.nodeName) {
    return undefined;
  }
  return !isPossiblyReplacedElement(layout.nodeName);
}

/**
 * Advanced-context — `white-space` values that provably allow wrapping.
 * `text-overflow: ellipsis` needs a non-wrapping line (`white-space:
 * nowrap`), so these values defeat it. `nowrap` and `pre` (which suppresses
 * wrapping) are excluded.
 */
const WRAPPING_WHITE_SPACE_VALUES: ReadonlySet<string> = new Set([
  'normal',
  'pre-wrap',
  'break-spaces',
  'pre-line',
]);

/** `text-wrap-mode` values that provably allow wrapping (CSS Text 4). */
const WRAPPING_TEXT_WRAP_MODES: ReadonlySet<string> = new Set(['wrap']);

/**
 * Whether the element's computed `white-space` provably allows wrapping.
 *
 * Chromium's computed-style map reports the CSS Text 4 longhands
 * (`white-space-collapse` + `text-wrap-mode`) instead of the `white-space`
 * shorthand, so both sources are consulted: the shorthand when present,
 * otherwise the `text-wrap-mode` longhand. Missing values are never
 * "provably wrapping" (conservative).
 */
export function isProvablyWrappingWhiteSpace(layout: LayoutContext): boolean {
  const whiteSpace = layout.getComputedStyle('white-space');
  if (whiteSpace !== undefined) {
    return WRAPPING_WHITE_SPACE_VALUES.has(whiteSpace.trim().toLowerCase());
  }
  const textWrapMode = layout.getComputedStyle('text-wrap-mode');
  if (textWrapMode !== undefined) {
    return WRAPPING_TEXT_WRAP_MODES.has(textWrapMode.trim().toLowerCase());
  }
  return false;
}

/**
 * Advanced-context — whether the element's effective overflow is provably
 * `visible` on the inline axis (the one `text-overflow` needs to clip).
 * The computed `overflow` shorthand reports both axes; a multi-value
 * shorthand (e.g. `hidden visible`) is not "visible", so the `overflow-x`
 * longhand is consulted for the horizontal clip.
 */
export function isProvablyVisibleOverflow(layout: LayoutContext): boolean {
  const overflow = layout.getComputedStyle('overflow');
  if (overflow !== undefined && overflow.trim().toLowerCase() === 'visible') {
    return true;
  }
  const overflowX = layout.getComputedStyle('overflow-x');
  if (overflowX !== undefined && overflowX.trim().toLowerCase() === 'visible') {
    return true;
  }
  return false;
}

/**
 * Advanced-context — `place-self` decomposition.
 *
 * `place-self` is the shorthand for `align-self` + `justify-self`:
 *   - `align-self` applies to flex AND grid items;
 *   - `justify-self` applies to grid items.
 * The compound therefore has an effect whenever the element is a flex or
 * grid item (the permissive union of both longhands), and is inactive on
 * any other box. `undefined` means the parent is unknown (no decision —
 * conservative).
 *
 * Context hardening — Block Alignment override: an item whose `display`
 * is EXPLICITLY overridden to a plain block-level display (author
 * declaration `display: block`, `.bad` case) is taken out of the Box
 * Alignment placement context even though it remains a flex/grid item.
 * Implicit block (no authored `display` — the `.good` case) keeps the
 * placement context. The authored declaration is `layout.declaredDisplay`;
 * UA rules never count.
 *
 * Context hardening (Level 5) — the override is checked BEFORE the
 * parent-unknown guard: `display: block` + `place-self` has no effect no
 * matter how much of the parent context is known, because the authored
 * display removes the box from the placement context. The parent-unknown
 * guard applies only when NO explicit display override exists.
 */
export function hasPlaceSelfEffect(layout: LayoutContext): boolean | undefined {
  const declaredDisplay = layout.declaredDisplay?.trim().toLowerCase();
  if (declaredDisplay && PLAIN_BLOCK_ITEM_DISPLAYS.has(declaredDisplay)) {
    return false;
  }
  if (!layout.parentDisplay || layout.parentDisplay === NO_PARENT_DISPLAY) {
    return undefined;
  }
  const alignSelfApplies = layout.isFlexItem || layout.isGridItem;
  const justifySelfApplies = layout.isGridItem;
  if (!alignSelfApplies && !justifySelfApplies) {
    return false;
  }
  return true;
}

/**
 * Explicit `display` values that turn a flex/grid item into a plain block
 * box and remove it from the Box Alignment placement context (see
 * `hasPlaceSelfEffect`). Only an AUTHORED declaration triggers the
 * override — the computed value alone is never consulted.
 */
const PLAIN_BLOCK_ITEM_DISPLAYS: ReadonlySet<string> = new Set([
  'block',
  'flow-root',
  'list-item',
]);

/**
 * Final-PR7 — every display value that produces a table box (the element
 * participates in table layout). `border-spacing`, `empty-cells` and
 * `caption-side` only apply to these.
 */
const TABLE_DISPLAYS: ReadonlySet<string> = new Set([
  'table',
  'inline-table',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-row',
  'table-column-group',
  'table-column',
  'table-cell',
  'table-caption',
]);

/** Whether the element produces a table box. */
export function isTableElement(layout: LayoutContext): boolean {
  return TABLE_DISPLAYS.has(layout.display);
}

/**
 * Final-PR7 — whether the element is a list item (display: list-item,
 * canonical single keyword — or the multi-keyword "... list-item" form).
 * The `list-style-*` properties only apply to list items.
 */
export function isListItem(layout: LayoutContext): boolean {
  return layout.display === 'list-item' || layout.display.endsWith(' list-item');
}

/**
 * Whether the element is a multicol container: computed `column-width` OR
 * `column-count` is not 'auto'. Missing styles mean "not provably multicol"
 * (conservative deviation from the reference, which always receives the
 * full computed-style map from CDP).
 */
export function isMulticolContainer(layout: LayoutContext): boolean {
  const columnWidth = layout.getComputedStyle('column-width');
  const columnCount = layout.getComputedStyle('column-count');
  return (
    (columnWidth !== undefined && columnWidth !== 'auto') ||
    (columnCount !== undefined && columnCount !== 'auto')
  );
}

/** Flex, grid, grid-lanes OR multicol container (reference MulticolFlexGridValidator). */
export function isFlexOrGridOrMulticolContainer(layout: LayoutContext): boolean {
  return isFlexOrGridOrGridLanesContainer(layout) || isMulticolContainer(layout);
}

/**
 * Elements Chromium treats as (possibly) replaced — width/height apply to
 * them even when inline. See
 * https://html.spec.whatwg.org/multipage/rendering.html#replaced-elements.
 * `nodeName` is expected already normalized (lowercase); the predicate is
 * still case-safe for direct callers.
 */
const POSSIBLY_REPLACED_ELEMENTS: ReadonlySet<string> = new Set([
  'audio',
  'canvas',
  'embed',
  'iframe',
  'img',
  'input',
  'object',
  'video',
]);

export function isPossiblyReplacedElement(nodeName: string | undefined): boolean {
  if (!nodeName) {
    return false;
  }
  return POSSIBLY_REPLACED_ELEMENTS.has(nodeName.trim().toLowerCase());
}

/**
 * Build a container-required rule. `description` completes the reason
 * text ("...because this element is not ${description}."), e.g.
 * "a flex or grid container".
 */
export function createContainerRequirementRule(
  propertyName: string,
  reasonCode: ReasonCode,
  description: string,
  isContainer: (layout: LayoutContext) => boolean
): InactiveRule {
  const reasonText = `${propertyName} has no effect because this element is not ${description}.`;
  return {
    propertyName,
    inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration): InactiveResult | undefined {
      // Missing display data must never produce a false positive.
      if (!layout.display) {
        return undefined;
      }
      if (isContainer(layout)) {
        return undefined;
      }
      return { inactive: true, propertyName, reasonCode, reasonText };
    },
  };
}

/**
 * Build an item-required rule. `isItem` decides which formatting context
 * the parent must establish, and `description` completes the reason text
 * (e.g. "a grid item").
 */
export function createItemRequirementRule(
  propertyName: string,
  reasonCode: ReasonCode,
  description: string,
  isItem: (layout: LayoutContext) => boolean
): InactiveRule {
  const reasonText = `${propertyName} has no effect because this element is not ${description}.`;
  return {
    propertyName,
    inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration): InactiveResult | undefined {
      // 'none' means the parent is unknown (no parent or failed lookup) —
      // flagging an item property then would be a false positive.
      if (!layout.parentDisplay || layout.parentDisplay === NO_PARENT_DISPLAY) {
        return undefined;
      }
      if (isItem(layout)) {
        return undefined;
      }
      return { inactive: true, propertyName, reasonCode, reasonText };
    },
  };
}

/**
 * PR6 Phase 3 — build a position-offset rule (`top`/`right`/`bottom`/
 * `left`/`inset`): inactive only when the element is provably in static
 * flow with no formatting context that would honor offsets.
 *
 * Flex and grid items honor offsets even with `position: static`, so the
 * item flags are always consulted before flagging.
 */
export function createPositionOffsetRule(propertyName: string): InactiveRule {
  const positionedReasonText =
    `${propertyName} has no effect because this element is not positioned (position: static).`;
  return {
    propertyName,
    inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration): InactiveResult | undefined {
      if (!layout.display) {
        return undefined;
      }
      // No box at all — the most specific condition wins.
      if (isBoxSuppressed(layout)) {
        return inactiveResult(
          propertyName,
          REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX,
          boxSuppressedReasonText(propertyName)
        );
      }
      if (!layout.position) {
        return undefined;
      }
      if (layout.position !== 'static') {
        return undefined;
      }
      if (layout.isFlexItem || layout.isGridItem) {
        return undefined;
      }
      return inactiveResult(
        propertyName,
        REASON_CODES.REQUIRES_POSITIONED_ELEMENT,
        positionedReasonText
      );
    },
  };
}

/**
 * Advanced-context — build an item-required rule that is ALSO aware of
 * out-of-flow positioning.
 *
 * An absolutely/fixed positioned box is NEVER a flex/grid item — whether
 * its parent is a flex/grid container (it is removed from the formatting
 * context) or not (it was never an item) — so its item-dependent
 * properties (flex, flex-basis, grid-column, align-self, …) have NO
 * effect. The most specific condition wins:
 *
 *   1. out-of-flow → inactive with the out-of-flow reason code, no matter
 *      how much of the parent context is known;
 *   2. in-flow item → active;
 *   3. everything else → inactive with the plain item-required reason code.
 *
 * Context hardening: the out-of-flow fact alone is SUFFICIENT to flag —
 * the parent-unknown ('none') guard applies only to in-flow elements,
 * where an unknown parent could be a flex/grid container. Flagging an
 * out-of-flow box never risks a false positive (no abspos box can be an
 * item), so the wrapper-page flow correctly dims `flex-basis` on a
 * standalone `position: absolute` rule.
 *
 * The remaining guards are identical to {@link createItemRequirementRule}:
 * a missing display yields no decision.
 */
export function createOutOfFlowAwareItemRule(
  propertyName: string,
  reasonCode: ReasonCode,
  description: string,
  isItem: (layout: LayoutContext) => boolean
): InactiveRule {
  const notItemReasonText = `${propertyName} has no effect because this element is not ${description}.`;
  const outOfFlowReasonText =
    `${propertyName} has no effect because this element is out of flow ` +
    `(position: absolute or fixed).`;
  return {
    propertyName,
    inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration): InactiveResult | undefined {
      if (!layout.display) {
        return undefined;
      }
      // Out-of-flow boxes are never items — this holds regardless of the
      // parent, so the out-of-flow condition is checked BEFORE the
      // parent-unknown guard (which is only meaningful for in-flow boxes).
      if (layout.isOutOfFlow) {
        return inactiveResult(
          propertyName,
          REASON_CODES.NOT_APPLICABLE_TO_ABSOLUTELY_POSITIONED_BOX,
          outOfFlowReasonText
        );
      }
      if (!layout.parentDisplay || layout.parentDisplay === NO_PARENT_DISPLAY) {
        return undefined;
      }
      if (isItem(layout)) {
        return undefined;
      }
      return inactiveResult(propertyName, reasonCode, notItemReasonText);
    },
  };
}

/**
 * PR6 Phase 3 — build a "box-suppressed" rule for properties whose ONLY
 * provable inactivity condition is `display: contents` (no box at all).
 * Everything else is too ambiguous to judge safely and stays active.
 */
export function createBoxSuppressedRule(propertyName: string): InactiveRule {
  return {
    propertyName,
    inspect(layout: LayoutContext, _declaration: MatchedCssDeclaration): InactiveResult | undefined {
      if (!layout.display) {
        return undefined;
      }
      if (!isBoxSuppressed(layout)) {
        return undefined;
      }
      return inactiveResult(
        propertyName,
        REASON_CODES.NOT_APPLICABLE_WITHOUT_BOX,
        boxSuppressedReasonText(propertyName)
      );
    },
  };
}

/**
 * PR Level 3 — pseudo-element building blocks.
 *
 * The pseudo rules are grounded in empirical Chromium probes (see the
 * Level 3 report): CDP surfaces pseudo declarations through the origin
 * element's `pseudoElements` section, and the ::first-letter box honors
 * exactly the property set encoded below.
 */

/**
 * Pseudo-element types whose box is generated from the `content` property.
 * A ::before/::after with `content: none`/`normal` (or no `content` at
 * all) generates no box — everything else declared on it is inactive.
 * `::first-letter` is NOT content-generated (it always styles the letter),
 * so the content guard never applies to it.
 */
export const GENERATED_CONTENT_PSEUDOS: ReadonlySet<string> = new Set(['before', 'after']);

/** Whether a pseudo type generates its box from the `content` property. */
export function isGeneratedContentPseudo(pseudoType: string): boolean {
  return GENERATED_CONTENT_PSEUDOS.has(pseudoType.trim().toLowerCase());
}

/** Declared `content` values that provably suppress a generated pseudo box. */
const NON_GENERATING_CONTENT_VALUES: ReadonlySet<string> = new Set(['none', 'normal']);

/**
 * Whether a generated pseudo-element of the node provably creates a box:
 * its cascade-winning declared `content` is present and is neither `none`
 * nor `normal`.
 *
 *   - `true`  → the pseudo generates (its properties are active);
 *   - `false` → the pseudo provably generates no box;
 *   - `undefined` → the pseudo facts were not collected — no decision.
 *
 * Only generated-content pseudos (::before/::after) are ever considered.
 */
export function hasGeneratedContent(
  layout: LayoutContext,
  pseudoType: string
): boolean | undefined {
  if (!isGeneratedContentPseudo(pseudoType)) {
    return false;
  }

  // Chromium's computed pseudo style is the source of truth when it was
  // collected.  A declaration such as `content: var(--value)` can compute to
  // `none`, so declaration text alone cannot prove that a generated box
  // exists.
  const computedContent = layout.pseudoBoxFacts?.get(pseudoType)?.computedContent;
  if (computedContent !== undefined) {
    const normalized = computedContent.trim().toLowerCase();
    return normalized.length > 0 && !NON_GENERATING_CONTENT_VALUES.has(normalized);
  }

  const pseudoContent = layout.pseudoContent;
  if (pseudoContent === undefined) {
    return undefined;
  }
  const content = pseudoContent.get(pseudoType);
  if (content === undefined || content.length === 0) {
    return false;
  }
  return !NON_GENERATING_CONTENT_VALUES.has(content.trim().toLowerCase());
}

/**
 * Properties the Chromium ::first-letter box actually honors. Empirically
 * verified with computed-style probes against a real Chromium build: each
 * property below changes the first-letter's computed value (and has a
 * visual effect per CSS Pseudo-Elements 4), while every OTHER property is
 * ignored — its declaration computes identically to an unstyled control
 * first-letter.
 *
 * Notable deviations from the spec's "applies to" list, per the probes:
 * `clear` and the `text-emphasis-*` family are IGNORED by Chromium and are
 * intentionally absent here. `visibility`, `transform-origin` and
 * `text-justify` are recorded by Chromium although absent from the spec
 * list — they are kept so they are never flagged as unsupported.
 */
const FIRST_LETTER_SUPPORTED_PROPERTIES: ReadonlySet<string> = new Set([
  // Color / opacity.
  'color',
  'opacity',
  // Font family (all font properties).
  'font',
  'font-family',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-variant-caps',
  'font-variant-east-asian',
  'font-variant-ligatures',
  'font-variant-numeric',
  'font-variant-position',
  'font-weight',
  'font-feature-settings',
  'font-kerning',
  'font-optical-sizing',
  'font-palette',
  'font-synthesis',
  'font-variation-settings',
  // Text layout.
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'text-shadow',
  'float',
  'vertical-align',
  'initial-letter',
  // Background family (all background properties).
  'background',
  'background-color',
  'background-image',
  'background-position',
  'background-position-x',
  'background-position-y',
  'background-size',
  'background-repeat',
  'background-repeat-x',
  'background-repeat-y',
  'background-attachment',
  'background-origin',
  'background-clip',
  'background-blend-mode',
  // Text-decoration family.
  'text-decoration',
  'text-decoration-line',
  'text-decoration-color',
  'text-decoration-style',
  'text-decoration-thickness',
  'text-underline-offset',
  'text-underline-position',
  // Box model.
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-width',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-style',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'box-shadow',
  'border-image',
  'border-image-source',
  'border-image-slice',
  'border-image-width',
  'border-image-outset',
  'border-image-repeat',
  // Recorded by Chromium though absent from the spec list — kept active to
  // avoid false positives.
  'visibility',
  'transform-origin',
  'text-justify',
]);

/**
 * Whether a property is supported on the ::first-letter box. Custom
 * properties (`--*`) apply everywhere and are always supported; any other
 * property outside {@link FIRST_LETTER_SUPPORTED_PROPERTIES} is ignored by
 * Chromium on the first letter and should be flagged as inactive.
 */
export function supportsFirstLetterProperty(propertyName: string): boolean {
  const name = propertyName.trim().toLowerCase();
  if (!name) {
    return false;
  }
  if (name.startsWith('--')) {
    return true;
  }
  return FIRST_LETTER_SUPPORTED_PROPERTIES.has(name);
}
