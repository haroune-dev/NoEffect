"use strict";
// Copyright 2022 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMulticolContainer = exports.isGridLanesContainer = exports.isGridContainer = exports.isPossiblyReplacedElement = exports.isInlineElement = exports.isBlockContainer = exports.isFlexContainer = exports.buildPropertyValue = exports.buildPropertyName = exports.buildPropertyDefinitionText = void 0;
const lit_js_1 = require("../../ui/lit/lit.js");
const buildPropertyDefinitionText = (property, value) => {
    if (value === undefined) {
        return (0, exports.buildPropertyName)(property);
    }
    return (0, lit_js_1.html) `<code class="unbreakable-text"><span class="property">${property}</span>: ${value}</code>`;
};
exports.buildPropertyDefinitionText = buildPropertyDefinitionText;
const buildPropertyName = (property) => {
    return (0, lit_js_1.html) `<code class="unbreakable-text"><span class="property">${property}</span></code>`;
};
exports.buildPropertyName = buildPropertyName;
const buildPropertyValue = (property) => {
    return (0, lit_js_1.html) `<code class="unbreakable-text">${property}</code>`;
};
exports.buildPropertyValue = buildPropertyValue;
const isFlexContainer = (computedStyles) => {
    if (!computedStyles) {
        return false;
    }
    const display = computedStyles.get('display');
    return display === 'flex' || display === 'inline-flex';
};
exports.isFlexContainer = isFlexContainer;
const blockContainerDisplayValueSet = new Set([
    'block',
    'flow-root',
    'inline-block',
    'list-item',
    'table-caption',
    'table-cell',
]);
const isBlockContainer = (computedStyles) => {
    if (!computedStyles) {
        return false;
    }
    const displayValue = computedStyles.get('display');
    if (!displayValue) {
        return false;
    }
    const split = displayValue.split(' ');
    if (split.length > 3) {
        return false;
    }
    // The order of keywords is canonicalized to "outside? inside? list-item?"
    // If the number of keywords is 3, it must be 'inline flow-root list-item'.
    if (split.length === 3) {
        return split[2] === 'list-item';
    }
    if (split.length === 2) {
        return split[1] === 'list-item' && split[0] !== 'inline';
    }
    return blockContainerDisplayValueSet.has(split[0]);
};
exports.isBlockContainer = isBlockContainer;
const isInlineElement = (computedStyles) => {
    if (!computedStyles) {
        return false;
    }
    return computedStyles.get('display') === 'inline';
};
exports.isInlineElement = isInlineElement;
// See https://html.spec.whatwg.org/multipage/rendering.html#replaced-elements
const possiblyReplacedElements = new Set([
    'audio',
    'canvas',
    'embed',
    'iframe',
    'img',
    'input',
    'object',
    'video',
]);
const isPossiblyReplacedElement = (nodeName) => {
    if (!nodeName) {
        return false;
    }
    return possiblyReplacedElements.has(nodeName);
};
exports.isPossiblyReplacedElement = isPossiblyReplacedElement;
const isGridContainer = (computedStyles) => {
    if (!computedStyles) {
        return false;
    }
    const display = computedStyles.get('display');
    return display === 'grid' || display === 'inline-grid';
};
exports.isGridContainer = isGridContainer;
const isGridLanesContainer = (computedStyles) => {
    if (!computedStyles) {
        return false;
    }
    const display = computedStyles.get('display');
    return display === 'grid-lanes' || display === 'inline-grid-lanes';
};
exports.isGridLanesContainer = isGridLanesContainer;
const isMulticolContainer = (computedStyles) => {
    if (!computedStyles) {
        return false;
    }
    const columnWidth = computedStyles.get('column-width');
    const columnCount = computedStyles.get('column-count');
    return columnWidth !== 'auto' || columnCount !== 'auto';
};
exports.isMulticolContainer = isMulticolContainer;
//# sourceMappingURL=CSSRuleValidatorHelper.js.map