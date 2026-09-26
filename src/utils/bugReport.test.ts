import { describe, it, expect } from 'vitest';
import { buildDetails, describeUserAgent, githubIssueUrl, ISSUE_URL_MAX, type LastSearch, type ReportEnvironment } from './bugReport';
import type { SearchContext } from '../types/search';

const desktop: ReportEnvironment = { version: '0.8.1', target: 'desktop', mode: 'offline', corpusVersion: '4.3.0', platform: 'Windows 11 (10.0.26200)' };
const web: ReportEnvironment = { version: '0.8.1', target: 'web', platform: describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36') };

const proximity: SearchContext = {
  type: 'proximity',
  proximityQuery: {
    terms: [{ query: 'الله', mode: 'surface' }, { query: 'قال', mode: 'surface' }],
    distances: [15],
    ordered: true,
    pageTerms: [{ query: 'النبي', mode: 'surface' }],
  },
};
const lemmaPhrase: SearchContext = {
  type: 'combined',
  combinedQuery: { andInputs: [{ id: 1, query: 'قال رسول', mode: 'lemma', cliticToggle: false }], orInputs: [] },
};

describe('the details block', () => {
  it('renders a proximity search with its page term, on the desktop with the OS', () => {
    expect(buildDetails(desktop, { context: proximity, selectedTexts: 0 })).toBe(
      'Kashshaf 0.8.1 desktop · offline · corpus 4.3.0 · Windows 11 (10.0.26200)\nLast search: proximity, الله ~15 قال, ordered, page term النبي'
    );
  });

  it('renders a lemma phrase with the selected texts, on the web with the browser and its version', () => {
    expect(buildDetails(web, { context: lemmaPhrase, selectedTexts: 3 })).toBe(
      'Kashshaf 0.8.1 web · Chrome 141 · macOS 10.15\nLast search: lemma phrase, قال رسول, 3 texts selected'
    );
  });

  it('says when no search has run, and when no corpus is installed', () => {
    expect(buildDetails({ ...desktop, mode: 'online', corpusVersion: null }, { context: null, selectedTexts: 0 })).toBe(
      'Kashshaf 0.8.1 desktop · online · corpus not installed · Windows 11 (10.0.26200)\nLast search: none yet'
    );
  });

  it('is the one block both routes carry', () => {
    const last: LastSearch = { context: proximity, selectedTexts: 2 };
    const details = buildDetails(desktop, last);
    const { url, truncated } = githubIssueUrl(details);
    expect(truncated).toBe(false);
    const body = decodeURIComponent(new URL(url).searchParams.get('body') ?? '');
    expect(body.startsWith(details)).toBe(true);
    expect(body).toContain('What happened');
    expect(url.startsWith('https://github.com/ammusto/kashshaf/issues/new?')).toBe(true);
  });

  it('truncates a long name query so the encoded URL stays under the limit, and says so', () => {
    const patterns = Array.from({ length: 40 }, (_, i) => Array.from({ length: 8 }, (_, j) => `اب* منصور معمر بن احمد بن زياد الاصبهاني ${i}${j}`));
    const name: SearchContext = { type: 'name', namePatterns: patterns, displayPatterns: patterns };
    const details = buildDetails(desktop, { context: name, selectedTexts: 0 });
    expect(encodeURIComponent(details).length).toBeGreaterThan(ISSUE_URL_MAX);
    const { url, truncated } = githubIssueUrl(details);
    expect(truncated).toBe(true);
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    expect(decodeURIComponent(new URL(url).searchParams.get('body') ?? '')).toContain('details truncated');
  });
});

describe('the user agent', () => {
  it('names the browsers people use, with the version, and the OS', () => {
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0')).toBe('Edge 141 · Windows 10/11');
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe('Firefox 132 · Linux');
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1')).toBe('Safari 18.1 · iOS 18.1');
  });

  it('falls back to the raw string for an agent it does not know', () => {
    const odd = 'SomeBot/2.0 (+https://example.org)';
    expect(describeUserAgent(odd)).toBe(odd);
  });
});
