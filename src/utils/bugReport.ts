import type { SearchContext } from '../types/search';
import { describeProximityQuery } from './proximityQuery';

/**
 * The details block a bug report carries, built once for both routes (the
 * GitHub issue and the e-mail): what the app is, what it runs on, and the
 * last search executed, so a report can be reproduced.
 *
 *     Kashshaf 0.8.1 desktop · offline · corpus 4.3.0 · Windows 11
 *     Last search: proximity, الله ~15 قال, ordered, page term النبي
 *
 *     Kashshaf 0.8.1 web · Chrome 141 · macOS 15
 *     Last search: lemma phrase, قال رسول, 3 texts selected
 */

export const BUG_EMAIL = 'antonio@kashshaf.com';
export const BUG_SUBJECT = '[Bug] Kashshāf Issue';
export const REPO_URL = 'https://github.com/ammusto/kashshaf';
export const ISSUE_URL = `${REPO_URL}/issues/new`;
/** The GitHub URL stays under this once percent-encoded (Arabic is six bytes a letter encoded). */
export const ISSUE_URL_MAX = 6 * 1024;

export interface ReportEnvironment {
  version: string;
  target: 'desktop' | 'web';
  /** Desktop only: the web app is always online, so it says "web" and nothing more. */
  mode?: 'offline' | 'online';
  /** Desktop only; null when no corpus is installed. */
  corpusVersion?: string | null;
  /** Desktop: the OS and version from Tauri. Web: browser, version, OS from the user agent. */
  platform: string;
}

export interface LastSearch {
  context: SearchContext | null;
  selectedTexts: number;
}

/** The first line: app, target, mode, corpus, platform. */
export function describeEnvironment(env: ReportEnvironment): string {
  const parts = [`Kashshaf ${env.version} ${env.target}`];
  if (env.target === 'desktop') {
    if (env.mode) parts.push(env.mode);
    parts.push(env.corpusVersion ? `corpus ${env.corpusVersion}` : 'corpus not installed');
  }
  parts.push(env.platform);
  return parts.join(' · ');
}

const modeWord = (m: string) => m;

/** The search as a person would say it: kind, terms, options, filters. */
export function describeLastSearch(last: LastSearch): string {
  const ctx = last.context;
  if (!ctx) return 'none yet';
  const parts: string[] = [];
  switch (ctx.type) {
    case 'proximity': {
      if (!ctx.proximityQuery) return 'proximity';
      const q = ctx.proximityQuery;
      const pageTerms = q.pageTerms.length > 0 ? `, page term${q.pageTerms.length > 1 ? 's' : ''} ${q.pageTerms.map((t) => t.query).join(', ')}` : '';
      parts.push(`proximity, ${describeProximityQuery({ ...q, pageTerms: [] }).replace(' · ', ', ')}${pageTerms}`);
      break;
    }
    case 'combined': {
      const and = ctx.combinedQuery?.andInputs.filter((i) => i.query.trim()) ?? [];
      const or = ctx.combinedQuery?.orInputs.filter((i) => i.query.trim()) ?? [];
      if (and.length + or.length === 1) {
        const t = and[0] ?? or[0];
        const kind = t.query.trim().split(/\s+/).length > 1 ? 'phrase' : 'word';
        parts.push(`${modeWord(t.mode)} ${kind}, ${t.query.trim()}`);
      } else {
        const show = (xs: typeof and, sep: string) => xs.map((i) => `${i.query.trim()} (${i.mode})`).join(sep);
        const a = show(and, ' AND ');
        const o = show(or, ' OR ');
        parts.push(`boolean, ${a && o ? `(${a}) AND (${o})` : a || o}`);
      }
      break;
    }
    case 'name':
      parts.push(`name, ${(ctx.displayPatterns ?? ctx.namePatterns ?? []).map((f) => f.join(' | ')).join(' ; ')}`);
      break;
    case 'wildcard':
      parts.push(`wildcard, ${ctx.wildcardQuery ?? ''}`);
      break;
  }
  if (last.selectedTexts > 0) parts.push(`${last.selectedTexts} text${last.selectedTexts === 1 ? '' : 's'} selected`);
  return parts.join(', ');
}

/** The whole block, for the issue body, the e-mail and the Copy button alike. */
export function buildDetails(env: ReportEnvironment, last: LastSearch): string {
  return `${describeEnvironment(env)}\nLast search: ${describeLastSearch(last)}`;
}

/**
 * Browser, its version and the operating system from a user agent, simply:
 * the browsers people use, or the raw string when none of them matches
 * (better a raw string than "unknown"). Modern browsers freeze the macOS
 * version at 10.15 in the user agent; that is what gets reported.
 */
export function describeUserAgent(ua: string): string {
  const browser =
    /\bEdg\/(\d+)/.exec(ua)?.[1] !== undefined ? `Edge ${/\bEdg\/(\d+)/.exec(ua)![1]}`
    : /\bOPR\/(\d+)/.exec(ua) ? `Opera ${/\bOPR\/(\d+)/.exec(ua)![1]}`
    : /\bSamsungBrowser\/(\d+)/.exec(ua) ? `Samsung Internet ${/\bSamsungBrowser\/(\d+)/.exec(ua)![1]}`
    : /\bFirefox\/(\d+)/.exec(ua) ? `Firefox ${/\bFirefox\/(\d+)/.exec(ua)![1]}`
    : /\bChrome\/(\d+)/.exec(ua) ? `Chrome ${/\bChrome\/(\d+)/.exec(ua)![1]}`
    : /\bVersion\/(\d+(?:\.\d+)?).*\bSafari\//.exec(ua) ? `Safari ${/\bVersion\/(\d+(?:\.\d+)?)/.exec(ua)![1]}`
    : null;
  const os =
    /Windows NT 10\.0/.test(ua) ? 'Windows 10/11'
    : /Windows NT (\d+\.\d+)/.exec(ua) ? `Windows NT ${/Windows NT (\d+\.\d+)/.exec(ua)![1]}`
    : /iPhone OS (\d+)[_.](\d+)/.exec(ua) ? `iOS ${/iPhone OS (\d+)[_.](\d+)/.exec(ua)![1]}.${/iPhone OS (\d+)[_.](\d+)/.exec(ua)![2]}`
    : /iPad/.test(ua) ? 'iPadOS'
    : /Mac OS X (\d+)[_.](\d+)/.exec(ua) ? `macOS ${/Mac OS X (\d+)[_.](\d+)/.exec(ua)![1]}.${/Mac OS X (\d+)[_.](\d+)/.exec(ua)![2]}`
    : /Android (\d+(?:\.\d+)?)/.exec(ua) ? `Android ${/Android (\d+(?:\.\d+)?)/.exec(ua)![1]}`
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  if (!browser && !os) return ua;
  return [browser, os].filter(Boolean).join(' · ');
}

export interface IssueLink {
  url: string;
  /** The details were cut to keep the URL under `ISSUE_URL_MAX`. */
  truncated: boolean;
}

const ISSUE_TITLE = 'Bug: ';
const PROMPT = '\n\n**What happened**\n\n\n\n**What I expected**\n\n';

/** The GitHub new-issue URL with the title and body prefilled, kept under the size limit. */
export function githubIssueUrl(details: string): IssueLink {
  const make = (d: string, truncated: boolean) => {
    const body = `${d}${truncated ? '\n(details truncated)' : ''}${PROMPT}`;
    return `${ISSUE_URL}?title=${encodeURIComponent(ISSUE_TITLE)}&body=${encodeURIComponent(body)}`;
  };
  let url = make(details, false);
  if (url.length <= ISSUE_URL_MAX) return { url, truncated: false };
  // Cut the details by characters until the encoded URL fits.
  let keep = details.length;
  while (keep > 0) {
    keep = Math.floor(keep * 0.8);
    url = make(details.slice(0, keep), true);
    if (url.length <= ISSUE_URL_MAX) return { url, truncated: true };
  }
  return { url: make('', true), truncated: true };
}
