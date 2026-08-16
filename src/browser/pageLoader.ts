/**
 * Responsible for loading HTML pages inside the CDP-controlled browser.
 *
 * Stub for Phase 1 — will be implemented in Phase 3.
 */

import { logger } from '../utils/logger';

export class PageLoader {
  /**
   * Navigate the browser to the given URL and wait for the page to load.
   */
  async loadPage(_url: string): Promise<void> {
    // Phase 3: Implement Page.navigate + Page.loadEventFired
    logger.info('[PageLoader] loadPage() — not yet implemented (Phase 3)');
  }

  /**
   * Reload the current page.
   */
  async reload(): Promise<void> {
    logger.info('[PageLoader] reload() — not yet implemented (Phase 3)');
  }

  dispose(): void {
    // Nothing to clean up in Phase 1
  }
}
