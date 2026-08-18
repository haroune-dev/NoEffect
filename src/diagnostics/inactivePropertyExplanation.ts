/**
 * Context collected while producing an inactive-property diagnostic.
 *
 * The browser analyser can supply a richer explanation directly. This
 * context is used by the Phase 1 mock analyser and as a sensible fallback
 * when a diagnostic does not include one.
 */
export interface InactivePropertyContext {
  display?: string;
  position?: string;
}

/**
 * Create the two-part explanation used by Chromium DevTools: a short cause
 * followed by an actionable suggestion. The returned value is Markdown for a
 * VS Code hover message.
 */
export function createInactivePropertyExplanation(
  propertyName: string,
  context: InactivePropertyContext = {}
): string {
  const property = formatCssProperty(propertyName);

  switch (propertyName) {
    case 'justify-content':
    case 'align-items': {
      const display = normaliseValue(context.display);

      if (!display || !isFlexOrGridDisplay(display)) {
        const blockingDisplay = display || 'block';
        return [
          `The ${formatCssDeclaration('display', blockingDisplay)} property prevents ${property} from having an effect.`,
          `Try adding ${formatCssDeclaration('display', 'grid')} or ${formatCssDeclaration('display', 'flex')} to make this element into a container.`,
        ].join('\n\n');
      }

      return [
        `The ${property} property has no effect in this element's current layout context.`,
        'Check whether the element has children that can be aligned by its flex or grid layout.',
      ].join('\n\n');
    }

    case 'top':
    case 'right':
    case 'bottom':
    case 'left': {
      const position = normaliseValue(context.position);

      if (!position || position === 'static') {
        return [
          `The ${formatCssDeclaration('position', position || 'static')} property prevents ${property} from having an effect.`,
          `Try adding ${formatCssDeclaration('position', 'relative')}, ${formatCssDeclaration('position', 'absolute')}, or ${formatCssDeclaration('position', 'fixed')} to position this element.`,
        ].join('\n\n');
      }

      return [
        `The ${property} property has no effect in this element's current positioning context.`,
        'Check the element\'s positioning and containing block.',
      ].join('\n\n');
    }

    case 'z-index': {
      const position = normaliseValue(context.position);

      if (!position || position === 'static') {
        return [
          `The ${formatCssDeclaration('position', position || 'static')} property prevents ${property} from having an effect.`,
          `Try adding ${formatCssDeclaration('position', 'relative')} to make this element positioned.`,
        ].join('\n\n');
      }

      return [
        `The ${property} property has no effect in this element's current stacking context.`,
        'Check whether this element participates in a stacking context.',
      ].join('\n\n');
    }

    default:
      return [
        `The ${property} property has no effect in this element's current layout context.`,
        'Check the element\'s **display** and **position** properties to make this declaration applicable.',
      ].join('\n\n');
  }
}

function isFlexOrGridDisplay(display: string): boolean {
  return ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(display);
}

function normaliseValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.replace(/\s*!important\s*$/i, '').trim().toLowerCase() || undefined;
}

function formatCssProperty(propertyName: string): string {
  return `**${escapeMarkdown(propertyName)}**`;
}

function formatCssDeclaration(propertyName: string, propertyValue: string): string {
  return `**${escapeMarkdown(`${propertyName}: ${propertyValue}`)}**`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*{}[\]<>_])/g, '\\$1');
}
