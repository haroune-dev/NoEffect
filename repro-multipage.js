"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cdpAnalyzer_1 = require("./src/services/cdpAnalyzer");
const companionSettings_1 = require("./src/services/companionSettings");
const multiPassCache_1 = require("./src/cache/multiPassCache");
const lifecycleManager_1 = require("./src/browser/lifecycleManager");
const FIXTURE = '/home/haroune-dev/Desktop/NoEffect/src/test/test-multipage';
async function main() {
    companionSettings_1.companionSettings.workspaceFolderProvider = () => FIXTURE;
    multiPassCache_1.multiPassCache.reset();
    const analyzer = new cdpAnalyzer_1.CdpAnalyzer();
    console.log('═══ STEP 1: analyzeCssFile(styles.css) — cold ═══');
    let issues = await analyzer.analyzeCssFile(FIXTURE + '/styles.css', Date.now());
    console.log('issues:', issues.map((i) => `${i.selectorText} ${i.propertyName} (${i.reasonCode})`));
    console.log('═══ STEP 2: analyzeCssFile(styles.css) — warm rerun ═══');
    issues = await analyzer.analyzeCssFile(FIXTURE + '/styles.css', Date.now());
    console.log('issues:', issues.map((i) => `${i.selectorText} ${i.propertyName} (${i.reasonCode})`));
    console.log('═══ STEP 3: analyzeHtmlFile(index.html) ═══');
    issues = await analyzer.analyzeHtmlFile(FIXTURE + '/index.html', Date.now());
    console.log('issues:', issues.map((i) => `${i.selectorText} ${i.propertyName} (${i.reasonCode})`));
    console.log('═══ STEP 4: analyzeHtmlFile(about.html) ═══');
    issues = await analyzer.analyzeHtmlFile(FIXTURE + '/about.html', Date.now());
    console.log('issues:', issues.map((i) => `${i.selectorText} ${i.propertyName} (${i.reasonCode})`));
    await lifecycleManager_1.defaultLifecycle.dispose();
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=repro-multipage.js.map