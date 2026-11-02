/**
 * ============================================================================
 * Instagram search model
 * ============================================================================
 * Thread search is identical in both viewers, so the rules live in
 * shared/search-index.js. This module keeps the imports that Instagram code
 * and tests already use pointing at that one implementation.
 * ============================================================================
 */

export { findMessageSearchResults, messageSearchFields, nextSearchIndex, searchableMessageText } from "../shared/search-index.js?v=1.8.28";
