import { CssLocation } from './cssLocation';
import { CdpSourceRange } from './cdpSourceRange';

/**
 * Represents a single CSS property that has been identified as having no
 * actual effect on the rendered page.
 */
export interface CssIssue {
  /** Name of the CSS property (e.g. "justify-content", "z-index") */
  propertyName: string;

  /** Value of the CSS property (e.g. "center", "10") */
  propertyValue: string;

  /** The CSS selector of the rule this property belongs to */
  selector: string;

  /** Exact source location of this property in the CSS file */
  location: CssLocation;

  /**
   * Local source range of the whole authored declaration
   * (from the property name to the trailing `;` when present).
   * Mirrors `location` for the browser-driven analysis flow.
   */
  declarationRange?: CssLocation;

  /**
   * Local source range of just the property name text.
   */
  propertyNameRange?: CssLocation;

  /**
   * Local one-character source range at the end of the authored
   * declaration (normally the `;`) where the inline warning icon is
   * anchored. Guaranteed non-empty whenever the issue was mapped.
   */
  iconAnchorRange?: CssLocation;

  /**
   * Local source range of the winning declaration's PROPERTY NAME when
   * this issue is an `OVERRIDDEN_BY_LATER_DECLARATION` verdict: the
   * later declaration of the same property inside the same block that
   * beats this one. The hover tooltip uses it to jump the user to the
   * overriding declaration; absent when the winner could not be mapped
   * (the hover then shows no navigation link).
   */
  overrideTarget?: CssLocation;

  /**
   * Optional reason code explaining why the property is inactive.
   * Not used in Phase 1, reserved for future diagnostic messages.
   */
  reasonCode?: string;

  /**
   * Human-readable explanation of why the property has no effect.
   * Displayed as Markdown in the hover tooltip, matching Chromium DevTools
   * format (cause followed by a suggested fix).
   */
  reason?: string;

  /**
   * Selector text of the matched rule obtained through CDP.
   * Mirrors `selector` for the browser-driven analysis flow.
   */
  selectorText?: string;

  /**
   * CDP stylesheet identifier of the authored rule that produced
   * this declaration.
   */
  styleSheetId?: string;

  /**
   * CDP source range of the declaration within its stylesheet.
   * Used by PR4 to map the issue to a precise VS Code range.
   */
  cdpRange?: CdpSourceRange;

  /**
   * Concise, stable reason text produced by the inactive-property
   * engine. Mirrors `reason` for the browser-driven analysis flow.
   */
  reasonText?: string;

  /**
   * Multi-companion evidence metadata (Level 11): the number of companion
   * passes that actually evaluated this declaration (emitted `A` or `I`).
   * Absent for wrapper-flow issues.
   */
  evaluatedCount?: number;

  /**
   * Multi-companion evidence metadata (Level 11): the number of companion
   * passes that evaluated this declaration as inactive.
   */
  inactiveCount?: number;

  /**
   * Multi-companion evidence metadata (Level 11): the number of companion
   * documents successfully analyzed in this run. Bounded at the Top-K
   * evidence budget; never a universal claim about the project.
   */
  analyzedCompanions?: number;
}
