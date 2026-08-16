"use strict";
// Copyright 2022 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.cssRuleValidatorsMap = exports.FontVariationSettingsValidator = exports.SizingValidator = exports.PositionAnchorValidator = exports.ZIndexValidator = exports.PositionValidator = exports.PaddingValidator = exports.MulticolFlexGridValidator = exports.FlexGridValidator = exports.FlexOrGridItemValidator = exports.GridItemValidator = exports.GridContainerValidator = exports.FlexContainerValidator = exports.FlexItemValidator = exports.AlignContentValidator = exports.CSSRuleValidator = exports.Hint = void 0;
const i18n = __importStar(require("../../core/i18n/i18n.js"));
const SDK = __importStar(require("../../core/sdk/sdk.js"));
const uiI18n = __importStar(require("../../ui/i18n/i18n.js"));
const lit_js_1 = require("../../ui/lit/lit.js");
const CSSRuleValidatorHelper_js_1 = require("./CSSRuleValidatorHelper.js");
const UIStrings = {
    /**
     * @description The message shown in the Style pane when the user hovers over a property that has no effect due to some other property.
     * @example {flex-wrap: nowrap} REASON_PROPERTY_DECLARATION_CODE
     * @example {align-content} AFFECTED_PROPERTY_DECLARATION_CODE
     */
    ruleViolatedBySameElementRuleReason: 'The {REASON_PROPERTY_DECLARATION_CODE} property prevents {AFFECTED_PROPERTY_DECLARATION_CODE} from having an effect.',
    /**
     * @description The message shown in the Style pane when the user hovers over a property declaration that has no effect due to some other property.
     * @example {flex-wrap} PROPERTY_NAME
     * @example {nowrap} PROPERTY_VALUE
     */
    ruleViolatedBySameElementRuleFix: 'Try setting {PROPERTY_NAME} to something other than {PROPERTY_VALUE}.',
    /**
     * @description The message shown in the Style pane when the user hovers over a property declaration that has no effect due to not being a flex or grid container.
     * @example {display: grid} DISPLAY_GRID_RULE
     * @example {display: flex} DISPLAY_FLEX_RULE
     */
    ruleViolatedBySameElementRuleChangeFlexOrGrid: 'Try adding {DISPLAY_GRID_RULE} or {DISPLAY_FLEX_RULE} to make this element into a container.',
    /**
     * @description The message shown in the Style pane when the user hovers over a property declaration that has no effect due to the current property value.
     * @example {display: block} EXISTING_PROPERTY_DECLARATION
     * @example {display: flex} TARGET_PROPERTY_DECLARATION
     */
    ruleViolatedBySameElementRuleChangeSuggestion: 'Try setting the {EXISTING_PROPERTY_DECLARATION} property to {TARGET_PROPERTY_DECLARATION}.',
    /**
     * @description The message shown in the Style pane when the user hovers over a property declaration that has no effect due to properties of the parent element.
     * @example {display: block} REASON_PROPERTY_DECLARATION_CODE
     * @example {flex} AFFECTED_PROPERTY_DECLARATION_CODE
     */
    ruleViolatedByParentElementRuleReason: 'The {REASON_PROPERTY_DECLARATION_CODE} property on the parent element prevents {AFFECTED_PROPERTY_DECLARATION_CODE} from having an effect.',
    /**
     * @description The message shown in the Style pane when the user hovers over a property declaration that has no effect due to the properties of the parent element.
     * @example {display: block} EXISTING_PARENT_ELEMENT_RULE
     * @example {display: flex} TARGET_PARENT_ELEMENT_RULE
     */
    ruleViolatedByParentElementRuleFix: 'Try setting the {EXISTING_PARENT_ELEMENT_RULE} property on the parent to {TARGET_PARENT_ELEMENT_RULE}.',
    /**
     * @description The warning text shown in Elements panel when font-variation-settings don't match allowed values
     * @example {wdth} PH1
     * @example {100} PH2
     * @example {10} PH3
     * @example {20} PH4
     * @example {Arial} PH5
     */
    fontVariationSettingsWarning: 'Value for setting "{PH1}" {PH2} is outside the supported range [{PH3}, {PH4}] for font-family "{PH5}".',
    /**
     * @description The message shown in the Style pane when the user hovers over a property declaration that has no effect on flex or grid child items.
     * @example {flex} CONTAINER_DISPLAY_NAME
     * @example {align-contents} PROPERTY_NAME
     */
    flexGridContainerPropertyRuleReason: 'This element is a {CONTAINER_DISPLAY_NAME} item, i.e. a child of a {CONTAINER_DISPLAY_NAME} container, but {PROPERTY_NAME} only applies to containers.',
    /**
     * @description The message shown in the Style pane when the user hovers over a property declaration that has no effect on flex or grid child items.
     * @example {align-contents} PROPERTY_NAME
     * @example {align-self} ALTERNATIVE_PROPERTY_NAME
     */
    flexGridContainerPropertyRuleFix: 'Try setting the {PROPERTY_NAME} on the container element or use {ALTERNATIVE_PROPERTY_NAME} instead.',
    /**
     * @description The messages shown in the Style pane when the user hovers over a position-anchor declaration that has no affect on a non-anchor-positioned element.
     * @example {relative} POSITION
     */
    invalidAnchorPositioning: 'An anchor was defined but the element was not anchor-positioned but positioned "{POSITION}".',
    /**
     * @description The messages shown in the Style pane when the user hovers over a position-anchor declaration that has no affect on a non-anchor-positioned element.
     */
    invalidAnchorPositioningFix: 'Set position to either "fixed" or "absolute".',
    /**
     * @description The messages shown in the Style pane when the user hovers over a position-anchor declaration that has no affect on hidden element.
     */
    unusedAnchorPositioning: 'An anchor was defined but the element is hidden.',
};
const str_ = i18n.i18n.registerUIStrings('panels/elements/CSSRuleValidator.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);
const i18nLazyStringTemplate = uiI18n.getFormatLocalizedStringTemplate.bind(undefined, str_);
class Hint {
    #hintMessage;
    #possibleFixMessage;
    #learnMoreLink;
    constructor(hintMessage, possibleFixMessage, learnMoreLink) {
        this.#hintMessage = hintMessage;
        this.#possibleFixMessage = possibleFixMessage;
        this.#learnMoreLink = learnMoreLink;
    }
    getMessage() {
        return this.#hintMessage;
    }
    getPossibleFixMessage() {
        return this.#possibleFixMessage;
    }
    getLearnMoreLink() {
        return this.#learnMoreLink;
    }
}
exports.Hint = Hint;
class CSSRuleValidator {
    #affectedProperties;
    constructor(affectedProperties) {
        this.#affectedProperties = affectedProperties;
    }
    getApplicableProperties() {
        return this.#affectedProperties;
    }
}
exports.CSSRuleValidator = CSSRuleValidator;
class AlignContentValidator extends CSSRuleValidator {
    constructor() {
        super(['align-content', 'place-content']);
    }
    getHint(_propertyName, computedStyles) {
        if (!computedStyles) {
            return;
        }
        const isFlex = (0, CSSRuleValidatorHelper_js_1.isFlexContainer)(computedStyles);
        if (!isFlex && !(0, CSSRuleValidatorHelper_js_1.isBlockContainer)(computedStyles) && !(0, CSSRuleValidatorHelper_js_1.isGridContainer)(computedStyles) &&
            !(0, CSSRuleValidatorHelper_js_1.isGridLanesContainer)(computedStyles)) {
            const reasonPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', computedStyles?.get('display'));
            const affectedPropertyDeclarationCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)('align-content');
            return new Hint(i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleReason, {
                REASON_PROPERTY_DECLARATION_CODE: reasonPropertyDeclaration,
                AFFECTED_PROPERTY_DECLARATION_CODE: affectedPropertyDeclarationCode,
            }), i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleFix, {
                PROPERTY_NAME: (0, CSSRuleValidatorHelper_js_1.buildPropertyName)('display'),
                PROPERTY_VALUE: (0, CSSRuleValidatorHelper_js_1.buildPropertyValue)(computedStyles?.get('display')),
            }));
        }
        if (!isFlex) {
            return;
        }
        if (computedStyles.get('flex-wrap') !== 'nowrap') {
            return;
        }
        const reasonPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('flex-wrap', 'nowrap');
        const affectedPropertyDeclarationCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)('align-content');
        return new Hint(i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleReason, {
            REASON_PROPERTY_DECLARATION_CODE: reasonPropertyDeclaration,
            AFFECTED_PROPERTY_DECLARATION_CODE: affectedPropertyDeclarationCode,
        }), i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleFix, {
            PROPERTY_NAME: (0, CSSRuleValidatorHelper_js_1.buildPropertyName)('flex-wrap'),
            PROPERTY_VALUE: (0, CSSRuleValidatorHelper_js_1.buildPropertyValue)('nowrap'),
        }));
    }
}
exports.AlignContentValidator = AlignContentValidator;
class FlexItemValidator extends CSSRuleValidator {
    constructor() {
        super(['flex', 'flex-basis', 'flex-grow', 'flex-shrink']);
    }
    getHint(propertyName, _computedStyles, parentComputedStyles) {
        if (!parentComputedStyles) {
            return;
        }
        if ((0, CSSRuleValidatorHelper_js_1.isFlexContainer)(parentComputedStyles)) {
            return;
        }
        const reasonPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', parentComputedStyles?.get('display'));
        const affectedPropertyDeclarationCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)(propertyName);
        const targetParentPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', 'flex');
        return new Hint(i18nLazyStringTemplate(UIStrings.ruleViolatedByParentElementRuleReason, {
            REASON_PROPERTY_DECLARATION_CODE: reasonPropertyDeclaration,
            AFFECTED_PROPERTY_DECLARATION_CODE: affectedPropertyDeclarationCode,
        }), i18nLazyStringTemplate(UIStrings.ruleViolatedByParentElementRuleFix, {
            EXISTING_PARENT_ELEMENT_RULE: reasonPropertyDeclaration,
            TARGET_PARENT_ELEMENT_RULE: targetParentPropertyDeclaration,
        }));
    }
}
exports.FlexItemValidator = FlexItemValidator;
class FlexContainerValidator extends CSSRuleValidator {
    constructor() {
        super(['flex-direction', 'flex-flow', 'flex-wrap']);
    }
    getHint(propertyName, computedStyles) {
        if (!computedStyles) {
            return;
        }
        if ((0, CSSRuleValidatorHelper_js_1.isFlexContainer)(computedStyles)) {
            return;
        }
        const reasonPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', computedStyles?.get('display'));
        const targetRuleCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', 'flex');
        const affectedPropertyDeclarationCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)(propertyName);
        return new Hint(i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleReason, {
            REASON_PROPERTY_DECLARATION_CODE: reasonPropertyDeclaration,
            AFFECTED_PROPERTY_DECLARATION_CODE: affectedPropertyDeclarationCode,
        }), i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleChangeSuggestion, {
            EXISTING_PROPERTY_DECLARATION: reasonPropertyDeclaration,
            TARGET_PROPERTY_DECLARATION: targetRuleCode,
        }));
    }
}
exports.FlexContainerValidator = FlexContainerValidator;
class GridContainerValidator extends CSSRuleValidator {
    constructor() {
        super([
            'grid',
            'grid-auto-columns',
            'grid-auto-flow',
            'grid-auto-rows',
            'grid-template',
            'grid-template-areas',
            'grid-template-columns',
            'grid-template-rows',
        ]);
    }
    getHint(propertyName, computedStyles) {
        if ((0, CSSRuleValidatorHelper_js_1.isGridContainer)(computedStyles) || (0, CSSRuleValidatorHelper_js_1.isGridLanesContainer)(computedStyles)) {
            return;
        }
        const reasonPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', computedStyles?.get('display'));
        const targetRuleCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', 'grid');
        const affectedPropertyDeclarationCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)(propertyName);
        return new Hint(i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleReason, {
            REASON_PROPERTY_DECLARATION_CODE: reasonPropertyDeclaration,
            AFFECTED_PROPERTY_DECLARATION_CODE: affectedPropertyDeclarationCode,
        }), i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleChangeSuggestion, {
            EXISTING_PROPERTY_DECLARATION: reasonPropertyDeclaration,
            TARGET_PROPERTY_DECLARATION: targetRuleCode,
        }));
    }
}
exports.GridContainerValidator = GridContainerValidator;
class GridItemValidator extends CSSRuleValidator {
    constructor() {
        super([
            'grid-area',
            'grid-column',
            'grid-row',
            'grid-row-end',
            'grid-row-start',
        ]);
    }
    getHint(propertyName, _computedStyles, parentComputedStyles) {
        if (!parentComputedStyles) {
            return;
        }
        if ((0, CSSRuleValidatorHelper_js_1.isGridContainer)(parentComputedStyles) || (0, CSSRuleValidatorHelper_js_1.isGridLanesContainer)(parentComputedStyles)) {
            return;
        }
        const reasonPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', parentComputedStyles?.get('display'));
        const targetParentPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', 'grid');
        const affectedPropertyDeclarationCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)(propertyName);
        return new Hint(i18nLazyStringTemplate(UIStrings.ruleViolatedByParentElementRuleReason, {
            REASON_PROPERTY_DECLARATION_CODE: reasonPropertyDeclaration,
            AFFECTED_PROPERTY_DECLARATION_CODE: affectedPropertyDeclarationCode,
        }), i18nLazyStringTemplate(UIStrings.ruleViolatedByParentElementRuleFix, {
            EXISTING_PARENT_ELEMENT_RULE: reasonPropertyDeclaration,
            TARGET_PARENT_ELEMENT_RULE: targetParentPropertyDeclaration,
        }));
    }
}
exports.GridItemValidator = GridItemValidator;
class FlexOrGridItemValidator extends CSSRuleValidator {
    constructor() {
        super([
            'order',
        ]);
    }
    getHint(propertyName, _computedStyles, parentComputedStyles) {
        if (!parentComputedStyles) {
            return;
        }
        if ((0, CSSRuleValidatorHelper_js_1.isFlexContainer)(parentComputedStyles) || (0, CSSRuleValidatorHelper_js_1.isGridContainer)(parentComputedStyles)) {
            return;
        }
        const reasonPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', parentComputedStyles?.get('display'));
        const targetParentPropertyDeclaration = (0, lit_js_1.html) `${(0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', 'flex')} or ${(0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', 'grid')}`;
        const affectedPropertyDeclarationCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)(propertyName);
        return new Hint(i18nLazyStringTemplate(UIStrings.ruleViolatedByParentElementRuleReason, {
            REASON_PROPERTY_DECLARATION_CODE: reasonPropertyDeclaration,
            AFFECTED_PROPERTY_DECLARATION_CODE: affectedPropertyDeclarationCode,
        }), i18nLazyStringTemplate(UIStrings.ruleViolatedByParentElementRuleFix, {
            EXISTING_PARENT_ELEMENT_RULE: reasonPropertyDeclaration,
            TARGET_PARENT_ELEMENT_RULE: targetParentPropertyDeclaration,
        }));
    }
}
exports.FlexOrGridItemValidator = FlexOrGridItemValidator;
class FlexGridValidator extends CSSRuleValidator {
    constructor() {
        // justify-content is specified to affect multicol, but we don't implement that yet.
        super(['justify-content']);
    }
    getHint(propertyName, computedStyles, parentComputedStyles) {
        if (!computedStyles) {
            return;
        }
        if ((0, CSSRuleValidatorHelper_js_1.isFlexContainer)(computedStyles) || (0, CSSRuleValidatorHelper_js_1.isGridContainer)(computedStyles) || (0, CSSRuleValidatorHelper_js_1.isGridLanesContainer)(computedStyles)) {
            return;
        }
        if (parentComputedStyles &&
            ((0, CSSRuleValidatorHelper_js_1.isFlexContainer)(parentComputedStyles) || (0, CSSRuleValidatorHelper_js_1.isGridContainer)(parentComputedStyles) ||
                (0, CSSRuleValidatorHelper_js_1.isGridLanesContainer)(parentComputedStyles))) {
            const reasonContainerDisplayName = (0, CSSRuleValidatorHelper_js_1.buildPropertyValue)(parentComputedStyles.get('display'));
            const reasonPropertyName = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)(propertyName);
            const reasonAlternativePropertyName = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)('justify-self');
            return new Hint(i18nLazyStringTemplate(UIStrings.flexGridContainerPropertyRuleReason, {
                CONTAINER_DISPLAY_NAME: reasonContainerDisplayName,
                PROPERTY_NAME: reasonPropertyName,
            }), i18nLazyStringTemplate(UIStrings.flexGridContainerPropertyRuleFix, {
                PROPERTY_NAME: reasonPropertyName,
                ALTERNATIVE_PROPERTY_NAME: reasonAlternativePropertyName,
            }));
        }
        const reasonPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', computedStyles.get('display'));
        const affectedPropertyDeclarationCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)(propertyName);
        return new Hint(i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleReason, {
            REASON_PROPERTY_DECLARATION_CODE: reasonPropertyDeclaration,
            AFFECTED_PROPERTY_DECLARATION_CODE: affectedPropertyDeclarationCode,
        }), i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleChangeFlexOrGrid, {
            DISPLAY_GRID_RULE: (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', 'grid'),
            DISPLAY_FLEX_RULE: (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', 'flex'),
        }));
    }
}
exports.FlexGridValidator = FlexGridValidator;
class MulticolFlexGridValidator extends CSSRuleValidator {
    constructor() {
        super([
            'gap',
            'column-gap',
            'row-gap',
            'grid-gap',
            'grid-column-gap',
            'grid-row-gap',
        ]);
    }
    getHint(propertyName, computedStyles) {
        if (!computedStyles) {
            return;
        }
        if ((0, CSSRuleValidatorHelper_js_1.isMulticolContainer)(computedStyles) || (0, CSSRuleValidatorHelper_js_1.isFlexContainer)(computedStyles) || (0, CSSRuleValidatorHelper_js_1.isGridContainer)(computedStyles) ||
            (0, CSSRuleValidatorHelper_js_1.isGridLanesContainer)(computedStyles)) {
            return;
        }
        const reasonPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', computedStyles?.get('display'));
        const affectedPropertyDeclarationCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)(propertyName);
        return new Hint(i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleReason, {
            REASON_PROPERTY_DECLARATION_CODE: reasonPropertyDeclaration,
            AFFECTED_PROPERTY_DECLARATION_CODE: affectedPropertyDeclarationCode,
        }), i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleFix, {
            PROPERTY_NAME: (0, CSSRuleValidatorHelper_js_1.buildPropertyName)('display'),
            PROPERTY_VALUE: (0, CSSRuleValidatorHelper_js_1.buildPropertyValue)(computedStyles?.get('display')),
        }));
    }
}
exports.MulticolFlexGridValidator = MulticolFlexGridValidator;
class PaddingValidator extends CSSRuleValidator {
    constructor() {
        super([
            'padding',
            'padding-top',
            'padding-right',
            'padding-bottom',
            'padding-left',
        ]);
    }
    getHint(propertyName, computedStyles) {
        const display = computedStyles?.get('display');
        if (!display) {
            return;
        }
        const tableAttributes = [
            'table-row-group',
            'table-header-group',
            'table-footer-group',
            'table-row',
            'table-column-group',
            'table-column',
        ];
        if (!tableAttributes.includes(display)) {
            return;
        }
        const reasonPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', computedStyles?.get('display'));
        const affectedPropertyDeclarationCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)(propertyName);
        return new Hint(i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleReason, {
            REASON_PROPERTY_DECLARATION_CODE: reasonPropertyDeclaration,
            AFFECTED_PROPERTY_DECLARATION_CODE: affectedPropertyDeclarationCode,
        }), i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleFix, {
            PROPERTY_NAME: (0, CSSRuleValidatorHelper_js_1.buildPropertyName)('display'),
            PROPERTY_VALUE: (0, CSSRuleValidatorHelper_js_1.buildPropertyValue)(computedStyles?.get('display')),
        }));
    }
}
exports.PaddingValidator = PaddingValidator;
class PositionValidator extends CSSRuleValidator {
    constructor() {
        super([
            'top',
            'right',
            'bottom',
            'left',
        ]);
    }
    getHint(propertyName, computedStyles) {
        const position = computedStyles?.get('position');
        if (!position) {
            return;
        }
        if (position !== 'static') {
            return;
        }
        const reasonPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('position', computedStyles?.get('position'));
        const affectedPropertyDeclarationCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)(propertyName);
        return new Hint(i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleReason, {
            REASON_PROPERTY_DECLARATION_CODE: reasonPropertyDeclaration,
            AFFECTED_PROPERTY_DECLARATION_CODE: affectedPropertyDeclarationCode,
        }), i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleFix, {
            PROPERTY_NAME: (0, CSSRuleValidatorHelper_js_1.buildPropertyName)('position'),
            PROPERTY_VALUE: (0, CSSRuleValidatorHelper_js_1.buildPropertyValue)(computedStyles?.get('position')),
        }));
    }
}
exports.PositionValidator = PositionValidator;
class ZIndexValidator extends CSSRuleValidator {
    constructor() {
        super([
            'z-index',
        ]);
    }
    getHint(propertyName, computedStyles, parentComputedStyles) {
        const position = computedStyles?.get('position');
        if (!position) {
            return;
        }
        if (['absolute', 'relative', 'fixed', 'sticky'].includes(position) || (0, CSSRuleValidatorHelper_js_1.isFlexContainer)(parentComputedStyles) ||
            (0, CSSRuleValidatorHelper_js_1.isGridContainer)(parentComputedStyles)) {
            return;
        }
        const reasonPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('position', computedStyles?.get('position'));
        const affectedPropertyDeclarationCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)(propertyName);
        return new Hint(i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleReason, {
            REASON_PROPERTY_DECLARATION_CODE: reasonPropertyDeclaration,
            AFFECTED_PROPERTY_DECLARATION_CODE: affectedPropertyDeclarationCode,
        }), i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleFix, {
            PROPERTY_NAME: (0, CSSRuleValidatorHelper_js_1.buildPropertyName)('position'),
            PROPERTY_VALUE: (0, CSSRuleValidatorHelper_js_1.buildPropertyValue)(computedStyles?.get('position')),
        }));
    }
}
exports.ZIndexValidator = ZIndexValidator;
class PositionAnchorValidator extends CSSRuleValidator {
    constructor() {
        super(['position-anchor']);
    }
    getHint(propertyName, computedStyles) {
        const position = computedStyles?.get('position') ?? 'static';
        const display = computedStyles?.get('display');
        if (position !== 'absolute' && position !== 'fixed') {
            return new Hint(i18nString(UIStrings.invalidAnchorPositioning, { POSITION: position }), i18nString(UIStrings.invalidAnchorPositioningFix));
        }
        if (display === 'none') {
            return new Hint(i18nString(UIStrings.unusedAnchorPositioning, { POSITION: position }), null);
        }
        return undefined;
    }
}
exports.PositionAnchorValidator = PositionAnchorValidator;
/**
 * Validates if CSS width/height are having an effect on an element.
 * See "Applies to" in https://www.w3.org/TR/css-sizing-3/#propdef-width.
 * See "Applies to" in https://www.w3.org/TR/css-sizing-3/#propdef-height.
 */
class SizingValidator extends CSSRuleValidator {
    constructor() {
        super([
            'width',
            'height',
        ]);
    }
    getHint(propertyName, computedStyles, _parentComputedStyles, nodeName) {
        if (!computedStyles || !nodeName) {
            return;
        }
        if (!(0, CSSRuleValidatorHelper_js_1.isInlineElement)(computedStyles)) {
            return;
        }
        // See https://html.spec.whatwg.org/multipage/rendering.html#replaced-elements.
        if ((0, CSSRuleValidatorHelper_js_1.isPossiblyReplacedElement)(nodeName)) {
            return;
        }
        const reasonPropertyDeclaration = (0, CSSRuleValidatorHelper_js_1.buildPropertyDefinitionText)('display', computedStyles?.get('display'));
        const affectedPropertyDeclarationCode = (0, CSSRuleValidatorHelper_js_1.buildPropertyName)(propertyName);
        return new Hint(i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleReason, {
            REASON_PROPERTY_DECLARATION_CODE: reasonPropertyDeclaration,
            AFFECTED_PROPERTY_DECLARATION_CODE: affectedPropertyDeclarationCode,
        }), i18nLazyStringTemplate(UIStrings.ruleViolatedBySameElementRuleFix, {
            PROPERTY_NAME: (0, CSSRuleValidatorHelper_js_1.buildPropertyName)('display'),
            PROPERTY_VALUE: (0, CSSRuleValidatorHelper_js_1.buildPropertyValue)(computedStyles?.get('display')),
        }));
    }
}
exports.SizingValidator = SizingValidator;
/**
 * Checks that font variation settings are applicable to the actual font.
 */
class FontVariationSettingsValidator extends CSSRuleValidator {
    constructor() {
        super([
            'font-variation-settings',
        ]);
    }
    getHint(_propertyName, computedStyles, _parentComputedStyles, _nodeName, fontFaces) {
        if (!computedStyles) {
            return;
        }
        const value = computedStyles.get('font-variation-settings');
        if (!value) {
            return;
        }
        const fontFamily = computedStyles.get('font-family');
        if (!fontFamily) {
            return;
        }
        const fontFamilies = new Set(SDK.CSSPropertyParser.parseFontFamily(fontFamily));
        const matchingFontFaces = (fontFaces || []).filter(f => fontFamilies.has(f.getFontFamily()));
        const variationSettings = SDK.CSSPropertyParser.parseFontVariationSettings(value);
        const warnings = [];
        for (const elementSetting of variationSettings) {
            for (const font of matchingFontFaces) {
                const fontSetting = font.getVariationAxisByTag(elementSetting.tag);
                if (!fontSetting) {
                    continue;
                }
                if (elementSetting.value < fontSetting.minValue || elementSetting.value > fontSetting.maxValue) {
                    warnings.push(i18nString(UIStrings.fontVariationSettingsWarning, {
                        PH1: elementSetting.tag,
                        PH2: elementSetting.value,
                        PH3: fontSetting.minValue,
                        PH4: fontSetting.maxValue,
                        PH5: font.getFontFamily(),
                    }));
                }
            }
        }
        if (!warnings.length) {
            return;
        }
        return new Hint(warnings.join(' '), '');
    }
}
exports.FontVariationSettingsValidator = FontVariationSettingsValidator;
const CSS_RULE_VALIDATORS = [
    AlignContentValidator,
    FlexContainerValidator,
    FlexGridValidator,
    FlexItemValidator,
    FlexOrGridItemValidator,
    FontVariationSettingsValidator,
    GridContainerValidator,
    GridItemValidator,
    MulticolFlexGridValidator,
    PaddingValidator,
    PositionValidator,
    PositionAnchorValidator,
    SizingValidator,
    ZIndexValidator,
];
const setupCSSRulesValidators = () => {
    const validatorsMap = new Map();
    for (const validatorClass of CSS_RULE_VALIDATORS) {
        const validator = new validatorClass();
        const affectedProperties = validator.getApplicableProperties();
        for (const affectedProperty of affectedProperties) {
            let propertyValidators = validatorsMap.get(affectedProperty);
            if (propertyValidators === undefined) {
                propertyValidators = [];
            }
            propertyValidators.push(validator);
            validatorsMap.set(affectedProperty, propertyValidators);
        }
    }
    return validatorsMap;
};
exports.cssRuleValidatorsMap = setupCSSRulesValidators();
//# sourceMappingURL=CSSRuleValidator.js.map