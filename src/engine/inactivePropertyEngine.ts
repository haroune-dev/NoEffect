import { CdpSourceRange } from '../models';
import { LayoutContext } from './layoutContext';

/**
 * A single CSS declaration matched to a DOM node, as collected from CDP.
 *
 * This is a pure browser fact: it carries no inactive/active reasoning.
 * The inactive decision is made separately by an InactivePropertyEngine.
 */
export interface MatchedCssDeclaration {
  /** CDP DOM node the declaration was matched against */
  nodeId: number;

  /** CDP stylesheet identifier of the authored rule (may be absent) */
  styleSheetId?: string;

  /** Selector text of the matched rule (e.g. ".non-flex" or ".a::before") */
  selectorText: string;

  /**
   * True when the declaration was reported from the node's INLINE
   * `style="..."` attribute (the CDP `inlineStyle` section), which has no
   * selector and no owning stylesheet. The analyzer routes such
   * declarations through the embedded-CSS mapping path; everything else
   * maps against stylesheet rules.
   */
  isInlineStyle?: boolean;

  /**
   * Identity of the OWNING declaration block: the matched rule or the
   * inline `style=""` attribute the declaration was reported from.
   * Duplicate detection runs within one block — two equal properties in
   * DIFFERENT rules are a cascade question, not a block duplicate.
   */
  blockId?: string;

  /**
   * True when this declaration loses the cascade for its property on the
   * inspected node — either an earlier duplicate INSIDE its own
   * declaration block, or a cross-rule loss to a declaration in another
   * block that beats it (higher specificity / later source order /
   * `!important` / inline style). The engine answers such declarations
   * with a fixed override verdict, never with a context rule.
   */
  isOverridden?: boolean;

  /**
   * True when `isOverridden` came from a CROSS-RULE cascade loss (the
   * winner lives in a different declaration block). The engine picks the
   * cross-rule reason code and names the winning selector from
   * `overriddenBy` for these; same-block duplicates keep the classic
   * later-declaration code.
   */
  isCrossRuleOverride?: boolean;

  /**
   * True when the authored declaration carries `!important` (CDP reports
   * it per property as `important: true`). A cross-rule cascade pass
   * needs it: an important rule declaration beats every normal author
   * declaration, including the inline `style=""` attribute.
   */
  important?: boolean;

  /**
   * The cascade-winning declaration of the same property inside this
   * declaration block — the object that beats this one when
   * `isOverridden` is true. Lives in the same batch array (set by
   * `markOverriddenDeclarations`); consumers map it to a local source
   * position to point the user at the overriding declaration.
   */
  overriddenBy?: MatchedCssDeclaration;

  /**
   * Pseudo-element the declaration targets, as reported by CDP's
   * `pseudoElements` section (e.g. 'before', 'after', 'first-letter').
   * `undefined` means the declaration applies to the element itself.
   */
  pseudoElement?: string;

  /** Property name exactly as reported by CDP (e.g. "justify-content") */
  propertyName: string;

  /** Property value exactly as reported by CDP (e.g. "center") */
  propertyValue: string;

  /** Source range of the declaration inside its stylesheet, if known */
  propertyRange?: CdpSourceRange;

  /** Source range of the enclosing rule style block, if known */
  ruleRange?: CdpSourceRange;

  /** CDP rule origin: "user-agent" | "user" | "author" | "injected" | "regular" */
  origin?: string;
}

/**
 * Everything the inactive-property engine needs to decide whether a
 * declaration has no effect: the declaration itself plus the real
 * computed styles of the node, as reported by Chromium.
 *
 * `layout` (PR6 Phase 1) is the node's LayoutContext — built ONCE per node
 * and shared by every rule. When present, rules MUST read layout
 * information through it instead of the raw style map. It is optional so
 * existing direct-construction call sites keep working unchanged.
 */
export interface PropertyInspectionContext {
  declaration: MatchedCssDeclaration;
  computedStyles: ReadonlyMap<string, string>;
  layout?: LayoutContext;
}

/**
 * The result of an inactive-property inspection. `undefined` means the
 * property is active (or outside the engine's rule set).
 */
export interface InactivePropertyResult {
  inactive: true;
  propertyName: string;

  /** Stable machine-readable reason code (see ReasonCode in src/inactive/reasonCode.ts) */
  reasonCode: string;

  /** Concise human-readable reason text */
  reasonText: string;
}

/**
 * A dedicated engine that decides, from real browser context, whether a
 * matched CSS declaration has no actual effect.
 */
export interface InactivePropertyEngine {
  inspect(context: PropertyInspectionContext): InactivePropertyResult | undefined;
}
