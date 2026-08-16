import { CdpSourceRange } from '../models';
import { MatchedCssDeclaration } from '../engine/inactivePropertyEngine';

/**
 * Convert a raw CDP `CSS.getMatchedStylesForNode` payload into a flat list
 * of matched declarations.
 *
 * PR Level 3: the payload's `pseudoElements` section is surfaced alongside
 * `matchedCSSRules` — a pseudo declaration (e.g. a `width` inside
 * `.a::before`) is reported by CDP under the pseudo-element, never as a
 * rule matching the element itself. Each such declaration is tagged with
 * its `pseudoElement` so the rule engine can dispatch it to the
 * pseudo-element rule that owns it.
 *
 * This module collects browser facts ONLY. It contains no inactive/active
 * reasoning — the decision is made by an InactivePropertyEngine elsewhere.
 */

/**
 * Validate and normalize a CDP SourceRange. Returns `undefined` when the
 * range is missing or malformed (negative or non-numeric offsets).
 */
function toRange(range: unknown): CdpSourceRange | undefined {
  if (!range || typeof range !== 'object') {
    return undefined;
  }

  const { startLine, startColumn, endLine, endColumn } = range as Record<string, unknown>;
  const values = [startLine, startColumn, endLine, endColumn];

  if (values.some((v) => typeof v !== 'number' || v < 0)) {
    return undefined;
  }

  return { startLine, startColumn, endLine, endColumn } as CdpSourceRange;
}

/** Normalized CDP pseudo-element type (e.g. 'before', 'first-letter'). */
function normalizePseudoType(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Extract the pseudo type and matches of one CDP pseudoElements entry. */
function toPseudoElement(
  pseudo: unknown
): { pseudoType: string; matches: Array<{ rule?: Record<string, any> }> } | null {
  if (!pseudo || typeof pseudo !== 'object') {
    return null;
  }
  const pseudoType = normalizePseudoType((pseudo as Record<string, unknown>).pseudoType);
  if (!pseudoType) {
    return null;
  }
  const matches = (pseudo as { matches?: Array<{ rule?: Record<string, any> }> }).matches ?? [];
  return { pseudoType, matches };
}

/**
 * Extract `MatchedCssDeclaration[]` from the `matchedCSSRules` AND
 * `pseudoElements` sections of a CDP matched-styles response. Declarations
 * that CDP reports with no name are skipped. Pseudo declarations carry
 * their `pseudoElement` tag; every declaration keeps the ORIGIN element's
 * nodeId (the pseudo belongs to that node).
 *
 * Embedded CSS: the payload's `inlineStyle` section (the element's own
 * `style="..."` attribute) is surfaced as declarations tagged
 * `isInlineStyle: true`. Inline declarations have no selector text — they
 * are matched to the attribute's source text by content (see
 * `matchInlineDeclaration`), never by selector.
 */
export function collectMatchedDeclarations(
  nodeId: number,
  matchedStyles: unknown
): MatchedCssDeclaration[] {
  const declarations: MatchedCssDeclaration[] = [];
  const payload = matchedStyles as {
    inlineStyle?: Record<string, any>;
    matchedCSSRules?: Array<{ rule?: Record<string, any> }>;
    pseudoElements?: Array<Record<string, any>>;
  } | null;

  // One blockId per declaration block in response order (the inline
  // attribute, then each matched rule incl. pseudo matches). Duplicate
  // detection is scoped to ONE block, so the blockId is a structural fact
  // the collector must attach.
  let ruleBlockCounter = 0;

  const pushRule = (
    ruleMatch: { rule?: Record<string, any> } | undefined,
    pseudoElement: string | undefined
  ) => {
    const rule = ruleMatch?.rule;
    const style = rule?.style;
    if (!style) {
      return;
    }

    const selectorText = rule.selectorList?.text ?? '';
    const styleSheetId = style.styleSheetId;
    const origin = rule.origin;
    const ruleRange = toRange(style.range);
    const blockId = `rule-${ruleBlockCounter++}`;

    for (const prop of style.cssProperties ?? []) {
      if (!prop || typeof prop.name !== 'string' || prop.name.length === 0) {
        continue;
      }

      declarations.push({
        nodeId,
        styleSheetId,
        selectorText,
        pseudoElement,
        blockId,
        propertyName: prop.name,
        propertyValue: prop.value ?? '',
        propertyRange: toRange(prop.range),
        ruleRange,
        origin,
        important: prop.important === true,
      });
    }
  };

  // The inline `style=""` attribute: no selector, no stylesheet — every
  // declaration belongs to the element itself (CDP repeats each property
  // once with a source range and once range-less; the normalizer merges
  // the duplicates, keeping the ranged representation).
  const inlineStyle = payload?.inlineStyle;
  if (inlineStyle) {
    for (const prop of inlineStyle.cssProperties ?? []) {
      if (!prop || typeof prop.name !== 'string' || prop.name.length === 0) {
        continue;
      }
      declarations.push({
        nodeId,
        styleSheetId: inlineStyle.styleSheetId,
        selectorText: '',
        isInlineStyle: true,
        blockId: 'inline',
        propertyName: prop.name,
        propertyValue: prop.value ?? '',
        propertyRange: toRange(prop.range),
        ruleRange: toRange(inlineStyle.range),
        origin: inlineStyle.origin ?? 'regular',
        important: prop.important === true,
      });
    }
  }

  for (const ruleMatch of payload?.matchedCSSRules ?? []) {
    pushRule(ruleMatch, undefined);
  }

  for (const pseudo of payload?.pseudoElements ?? []) {
    const parsed = toPseudoElement(pseudo);
    if (!parsed) {
      continue;
    }
    for (const ruleMatch of parsed.matches) {
      pushRule(ruleMatch, parsed.pseudoType);
    }
  }

  return declarations;
}

/**
 * Collect the cascade-winning AUTHORED `display` declaration of a node.
 *
 * Only explicit author/user declarations count: UA-origin rules (Chromium's
 * `div { display: block }`) are filtered out, so a plain `<div>` without an
 * authored `display` yields `undefined`. CDP lists the matching rules in
 * cascade order (least to most specific) with each rule's `cssProperties`
 * duplicated (declared + resolved copies), so the LAST `display`
 * declaration wins — exactly the cascade winner. An inline `style=""`
 * declaration is part of the authored cascade and beats every rule (the
 * inline `display` is read last).
 *
 * Returns a plain browser fact — whether the explicit display participates
 * in (or overrides) a layout context is decided by the rules (see
 * `hasPlaceSelfEffect`).
 */
export function collectDeclaredDisplay(matchedStyles: unknown): string | undefined {
  const payload = matchedStyles as {
    inlineStyle?: Record<string, any>;
    matchedCSSRules?: Array<{ rule?: Record<string, any> }>;
  } | null;

  let declared: string | undefined;
  for (const ruleMatch of payload?.matchedCSSRules ?? []) {
    const rule = ruleMatch?.rule;
    const origin = rule?.origin;
    if (origin === 'user-agent' || origin === 'injected' || origin === 'inspector') {
      continue;
    }
    const style = rule?.style;
    for (const prop of style?.cssProperties ?? []) {
      if (!prop || prop.name !== 'display') {
        continue;
      }
      declared = prop.value ?? '';
    }
  }

  // The inline attribute wins the cascade over every matched rule.
  const inlineStyle = payload?.inlineStyle;
  for (const prop of inlineStyle?.cssProperties ?? []) {
    if (!prop || prop.name !== 'display') {
      continue;
    }
    declared = prop.value ?? '';
  }
  return declared;
}

/**
 * Collect the cascade-winning DECLARED `content` value per generated
 * pseudo-element (::before / ::after) of a node.
 *
 * CDP lists the pseudo's matching rules in cascade order (least to most
 * specific), so the LAST `content` declaration is the one that wins. A
 * pseudo that has no `content` declaration at all is absent from the
 * returned map.
 *
 * Returns a plain browser fact — whether the pseudo actually generates a
 * box is decided by the rules (see `hasGeneratedContent`).
 */
export function collectPseudoContent(matchedStyles: unknown): ReadonlyMap<string, string> {
  const contentByPseudo = new Map<string, string>();
  const payload = matchedStyles as {
    pseudoElements?: Array<Record<string, any>>;
  } | null;

  for (const pseudo of payload?.pseudoElements ?? []) {
    const parsed = toPseudoElement(pseudo);
    if (!parsed) {
      continue;
    }
    for (const ruleMatch of parsed.matches) {
      const rule = ruleMatch?.rule;
      const style = rule?.style;
      for (const prop of style?.cssProperties ?? []) {
        if (!prop || prop.name !== 'content') {
          continue;
        }
        contentByPseudo.set(parsed.pseudoType, prop.value ?? '');
      }
    }
  }

  return contentByPseudo;
}

/**
 * Collect the pseudo-element TYPES present in a CDP matched-styles
 * response (e.g. `['first-letter', 'before']`), in response order.
 *
 * Returns a plain browser fact: the caller uses it to fetch the pseudo
 * boxes' COMPUTED styles (the browser is the only truthful source — it
 * ignores authored `display`/`position` on a `::first-letter` box), so no
 * authored declaration is interpreted here.
 */
export function collectPseudoTypes(matchedStyles: unknown): readonly string[] {
  const types: string[] = [];
  const payload = matchedStyles as {
    pseudoElements?: Array<Record<string, any>>;
  } | null;

  for (const pseudo of payload?.pseudoElements ?? []) {
    const parsed = toPseudoElement(pseudo);
    if (!parsed) {
      continue;
    }
    types.push(parsed.pseudoType);
  }

  return types;
}
