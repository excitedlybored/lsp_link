export const CRAWL_PROFILES = ['core', 'exhaustive'] as const;
export type CrawlProfile = (typeof CRAWL_PROFILES)[number];
