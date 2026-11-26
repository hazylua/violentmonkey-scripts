// ==UserScript==
// @name         b4k Archive Full Thread
// @namespace    b4k-full-thread
// @version      1.0.0
// @description  Join the pages of large (truncated) threads on the b4k archive into one page, and make post links and quote previews work for them again.
// @match        https://arch.b4k.co/*
// @match        https://arch.b4k.dev/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

/*
 * Thread pages: when the archive shows a "thread truncated" notice or splits a
 * thread into pages, every page is fetched and the replies are put back into
 * one page, in order. "Quoted By" backlinks are rebuilt across pages, links to
 * posts in the thread scroll to them instead of reloading, and the post in the
 * URL hash (#12345) is scrolled to once everything is in.
 *
 * Post pages (/board/post/123/): if the archive answers with the truncation
 * notice, go to the thread with #123 so the thread page can find the post.
 *
 * Quote previews anywhere (search results included): when the quoted post is
 * not on the page and the archive's post API can't return it, the post is found
 * by searching the thread's pages, and the rest of that thread is then fetched
 * in the background so opening it is fast.
 *
 * Fetched pages are cached in IndexedDB for CACHE_TTL_MS.
 * Run `localStorage.b4kFullThreadDebug = '1'` in the console and reload to log
 * what the script detects.
 */

(() => {
    'use strict';

    // ============================================================
    // SETTINGS
    // ============================================================

    // Build the full thread as soon as a paginated thread is opened.
    // When false, a button in the corner starts it instead.
    const AUTO_BUILD = true;

    // After a quote preview had to search a large thread's pages, fetch the
    // rest of that thread in the background (one page at a time).
    const PREFETCH_THREAD_AFTER_PREVIEW = true;

    const FETCH_CONCURRENCY = 3;
    const FETCH_RETRIES = 3;
    const BACKGROUND_FETCH_GAP_MS = 500;
    const MAX_PAGES = 300;
    const CACHE_TTL_MS = 15 * 60 * 1000;
    const MEMORY_CACHE_ENTRIES = 40;
    const HOVER_DELAY_MS = 80;

    const ARCHIVE_HOSTS = ['arch.b4k.co', 'arch.b4k.dev'];

    // Text of the notice the archive shows on threads it won't render whole.
    const NOTICE_RE = /truncat|paginat|too (?:many|large|big|long)|split (?:in|into) (?:\w+ )?pages/i;

    // Elements whose text never holds that notice. Post bodies are the big one:
    // people do write "truncated" in posts.
    const NOTICE_SKIP = 'script, style, noscript, template, textarea, select, article.post, .text, #backlink, #b4kft-status, .b4kft-note';

    const PAGE_PARAMS = ['page', 'p', 'pg'];

    // Formats tried when matching how the site displays post times, so posts
    // imported from other pages can be shown the same way.
    const TIME_FORMATS = [
        'ddd dd mmm yyyy HH:MM:ss',
        'ddd mmm dd HH:MM:ss yyyy',
        'ddd, dd mmm yyyy HH:MM:ss',
        'mm/dd/yy(ddd)HH:MM:ss',
        'dd/mm/yy(ddd)HH:MM:ss',
        'yyyy-mm-dd HH:MM:ss',
    ];

    const STYLE_ID = 'b4kft-style';
    const STATUS_ID = 'b4kft-status';
    const NOTE_CLASS = 'b4kft-note';
    const IMPORTED_CLASS = 'b4kft-imported';
    const TARGET_CLASS = 'b4kft-target';
    const DB_NAME = 'b4k-full-thread';
    const DB_STORE = 'pages';

    const DEBUG = readDebugFlag();

    // FoolFuuka's own hover preview works for posts that are on the page.
    // When its globals are visible we leave those posts to it.
    const NATIVE_PREVIEW =
        typeof window.jQuery === 'function' &&
        typeof window.backend_vars === 'object' &&
        window.backend_vars !== null;

    // Set on thread pages that turned out to be paginated.
    let state = null;


    // ============================================================
    // LOGGING
    // ============================================================

    function readDebugFlag() {
        try {
            return localStorage.getItem('b4kFullThreadDebug') === '1';
        } catch {
            return false;
        }
    }

    function debug(...args) {
        if (DEBUG) console.debug('[b4k-full-thread]', ...args);
    }

    function warn(...args) {
        console.warn('[b4k-full-thread]', ...args);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }


    // ============================================================
    // POST KEYS
    // ============================================================

    // Keys match the archive's element ids: "123" for normal posts and
    // "123_4" for ghost posts. Links sometimes spell ghost posts "123,4".
    function normKey(value) {
        const m = String(value ?? '').trim().match(/^(\d+)(?:[_,](\d+))?$/);
        if (!m) return null;
        return m[2] && Number(m[2]) > 0 ? `${m[1]}_${m[2]}` : m[1];
    }

    function keyParts(key) {
        const [num, sub = '0'] = key.split('_');
        return [Number(num), Number(sub)];
    }

    function compareKeys(a, b) {
        const [an, as] = keyParts(a);
        const [bn, bs] = keyParts(b);
        return an - bn || as - bs;
    }

    function displayKey(key) {
        return key.replace('_', ',');
    }

    // "#123", "#p123" and "#q123" all point at post 123.
    function hashKey(hash) {
        const m = String(hash || '').match(/^#[pq]?(\d+(?:[_,]\d+)?)$/);
        return m ? normKey(m[1]) : null;
    }


    // ============================================================
    // URLS
    // ============================================================

    function isArchiveHost(hostname) {
        return hostname === location.hostname || ARCHIVE_HOSTS.includes(hostname);
    }

    function toUrl(href, base = location.href) {
        try {
            return new URL(href, base);
        } catch {
            return null;
        }
    }

    // Pages can link to the archive's other domain. Requests go to the domain
    // we're on so they stay same-origin (cookies, no CORS).
    function sameOriginUrl(u) {
        const out = new URL(u.href);
        if (ARCHIVE_HOSTS.includes(out.hostname) && out.host !== location.host) {
            out.protocol = location.protocol;
            out.host = location.host;
        }
        out.hash = '';
        return out;
    }

    // Comparable form of a URL: same-origin, no hash, no trailing slash.
    function urlKey(href) {
        const u = toUrl(href);
        if (!u) return '';
        const local = sameOriginUrl(u);
        return local.origin + local.pathname.replace(/\/+$/, '') + local.search;
    }

    function threadUrl(board, thread) {
        return `${location.origin}/${board}/thread/${thread}/`;
    }

    function parsePagePath(pathname) {
        let m = pathname.match(/^\/([^/_][^/]*)\/thread\/(\d+)(?:\/|$)/);
        if (m) return { kind: 'thread', board: m[1], thread: m[2] };

        m = pathname.match(/^\/([^/_][^/]*)\/post\/(\d+(?:[_,]\d+)?)\/?$/);
        if (m) return { kind: 'post', board: m[1], key: normKey(m[2]) };

        return { kind: 'other' };
    }

    // Which post a link points at: { board, thread (or null), key }, or null.
    function linkTarget(a) {
        const u = toUrl(a.getAttribute('href') || '');
        let board = a.dataset.board || null;
        let key = a.dataset.post ? normKey(a.dataset.post) : null;
        let thread = null;

        if (u && isArchiveHost(u.hostname)) {
            const p = parsePagePath(u.pathname);

            if (p.kind === 'thread') {
                board = board || p.board;
                thread = p.thread;
                key = key || hashKey(u.hash);
            } else if (p.kind === 'post') {
                board = board || p.board;
                key = key || p.key;
            }
        }

        if (!key) {
            const m = a.textContent.trim().match(/^>>(\d+(?:,\d+)?)$/);
            if (m) key = normKey(m[1]);
        }

        if (!board || !key) return null;
        return { board, thread, key };
    }

    function isQuoteLink(a) {
        if (a.dataset.backlink === 'true') return true;
        return !!a.closest('.text, .backlink_list') && a.textContent.trim().startsWith('>>');
    }


    // ============================================================
    // PAGE STRUCTURE
    // ============================================================

    function mainArea(doc) {
        return doc.querySelector('#main, [role="main"]') || doc.body;
    }

    // The opening post's <article>, which also holds the replies.
    function findThreadArticle(doc, thread) {
        const byId = doc.getElementById(String(thread));
        if (byId && byId.tagName === 'ARTICLE' && !byId.matches('article.post')) return byId;
        return doc.querySelector('article.thread');
    }

    function findReplies(root, thread) {
        return [...root.querySelectorAll('article.post')].filter(el =>
            normKey(el.id) &&
            normKey(el.id) !== String(thread) &&
            !el.matches('article.thread') &&
            !el.closest('#backlink')
        );
    }

    function collectPosts(doc, thread) {
        const op = findThreadArticle(doc, thread);
        const scope = op || mainArea(doc);
        return { op, replies: scope ? findReplies(scope, thread) : [] };
    }

    function findPostIn(doc, key, board) {
        const el = doc.getElementById(key);
        if (!el || el.tagName !== 'ARTICLE' || el.closest('#backlink')) return null;
        if (board && el.dataset.board && el.dataset.board !== board) return null;
        return el;
    }

    function replyRange(doc, thread) {
        const keys = collectPosts(doc, thread).replies.map(el => normKey(el.id));
        if (!keys.length) return null;
        keys.sort(compareKeys);
        return { min: keys[0], max: keys[keys.length - 1] };
    }

    // Elements matching `selector` that belong to `post` itself, not to replies
    // nested inside it (the opening post's <article> wraps all replies).
    function ownElements(post, selector) {
        return [...post.querySelectorAll(selector)].filter(el => el.closest('article') === post);
    }

    // The thread a post belongs to, read from its header links.
    function threadOfArticle(article) {
        if (!article) return null;
        if (article.dataset.threadNum) return article.dataset.threadNum;

        for (const a of article.querySelectorAll('a[href]')) {
            if (a.closest('article') !== article || a.closest('.text')) continue;
            const u = toUrl(a.getAttribute('href'));
            if (!u || !isArchiveHost(u.hostname)) continue;
            const p = parsePagePath(u.pathname);
            if (p.kind === 'thread') return p.thread;
        }

        if (article.matches('article.thread')) return normKey(article.id);
        return null;
    }

    function threadLinkIn(scope, board, baseUrl) {
        for (const a of scope.querySelectorAll('a[href]')) {
            const u = toUrl(a.getAttribute('href'), baseUrl);
            if (!u || !isArchiveHost(u.hostname)) continue;
            const p = parsePagePath(u.pathname);
            if (p.kind === 'thread' && p.board === board) return p.thread;
        }
        return null;
    }


    // ============================================================
    // TRUNCATION NOTICE
    // ============================================================

    const INLINE_TAGS = new Set([
        'A', 'ABBR', 'B', 'CODE', 'EM', 'FONT', 'I', 'LABEL', 'MARK', 'S', 'SMALL', 'SPAN', 'STRONG', 'U',
    ]);

    // The element holding the "thread is truncated" notice, or null.
    function findNotice(doc) {
        if (!doc.body) return null;

        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    return node.matches(NOTICE_SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
                }
                const text = node.nodeValue;
                return text.length < 600 && NOTICE_RE.test(text)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_SKIP;
            },
        });

        const hit = walker.nextNode();
        if (!hit) return null;

        let el = hit.parentElement;
        while (el.parentElement && INLINE_TAGS.has(el.tagName)) el = el.parentElement;

        const isPageLevel = node => node === doc.body || node.matches('#main, [role="main"]');
        if (isPageLevel(el) || el.querySelector('article')) return hit.parentElement;

        // Take the whole alert box when the text sits inside one, so its
        // heading goes with it.
        const box = el.closest('.alert, .notice, .warning, .message, [role="alert"]');
        if (box && !isPageLevel(box) && !box.querySelector('article')) return box;
        return el;
    }

    // The link in the notice that leads to the paginated thread.
    function pickNoticeLink(notice, docUrl, board, thread) {
        let anchors = [...notice.querySelectorAll('a[href]')];
        if (notice.matches('a[href]')) anchors.unshift(notice);

        const parent = notice.parentElement;
        if (!anchors.length && parent && !parent.querySelector('article') && parent.textContent.length < 1500) {
            anchors = [...parent.querySelectorAll('a[href]')];
        }

        const here = urlKey(docUrl);
        let best = null;

        for (const a of anchors) {
            const u = toUrl(a.getAttribute('href'), docUrl);
            if (!u || !isArchiveHost(u.hostname)) continue;

            const segs = u.pathname.split('/').filter(Boolean);
            if (segs[0] !== board || !segs.includes(String(thread))) continue;
            if (urlKey(u.href) === here) continue;

            const paged = !!pageInfo(u, board, thread);
            if (!best || (paged && !best.paged)) best = { url: sameOriginUrl(u).href, paged };
        }

        return best && best.url;
    }


    // ============================================================
    // PAGINATION
    // ============================================================

    // If `u` is one page of the thread, its page number and a URL template
    // with "{page}" where the number goes. Understands ?page=N / ?p=N and
    // path forms such as /board/thread/123/N/, /page/N/ and /pN/.
    function pageInfo(u, board, thread) {
        if (!isArchiveHost(u.hostname)) return null;

        const segs = u.pathname.split('/').filter(Boolean);
        const ti = segs.indexOf(String(thread));
        if (segs[0] !== board || ti < 1) return null;

        // "/board/last/50/123/" is the "last 50 posts" view, not a page.
        if (segs.slice(1, ti).some(s => s === 'last' || /^\d+$/.test(s))) return null;

        const base = sameOriginUrl(u);
        const valid = n => (n >= 1 && n <= 10000 ? n : null);

        for (const name of PAGE_PARAMS) {
            const value = base.searchParams.get(name);
            if (value === null || !/^\d+$/.test(value) || !valid(Number(value))) continue;

            const t = new URL(base.href);
            t.searchParams.set(name, 'PAGEPLACEHOLDER');
            return {
                n: Number(value),
                url: base.href,
                template: t.href.replace('PAGEPLACEHOLDER', '{page}'),
            };
        }

        for (let i = ti + 1; i < segs.length; i++) {
            const m = segs[i].match(/^((?:p|page|pg)[-_]?)?(\d+)$/i);
            if (!m || !valid(Number(m[2]))) continue;

            const tSegs = segs.slice();
            tSegs[i] = (m[1] || '') + 'PAGEPLACEHOLDER';
            const t = new URL(base.href);
            t.pathname = '/' + tSegs.join('/') + (base.pathname.endsWith('/') ? '/' : '');
            return {
                n: Number(m[2]),
                url: base.href,
                template: t.href.replace('PAGEPLACEHOLDER', '{page}'),
            };
        }

        return null;
    }

    function isBareThreadUrl(u, board, thread) {
        const segs = u.pathname.split('/').filter(Boolean);
        return segs.length === 3 && segs[0] === board && segs[1] === 'thread' &&
            segs[2] === String(thread) && !u.search;
    }

    // Links to other pages of the thread, outside of posts.
    function scanPageLinks(doc, docUrl, board, thread) {
        const links = [];

        for (const a of doc.querySelectorAll('a[href]')) {
            if (a.closest('article.post, .text, #backlink')) continue;

            const u = toUrl(a.getAttribute('href'), docUrl);
            if (!u || !isArchiveHost(u.hostname)) continue;

            const text = a.textContent.trim();
            const textNumber = /^\d+$/.test(text) ? Number(text) : null;
            const info = pageInfo(u, board, thread);

            if (info) {
                links.push({ ...info, textNumber, el: a });
            } else if (textNumber === 1 && isBareThreadUrl(u, board, thread)) {
                // Page 1 is often just the plain thread URL.
                links.push({ n: 1, url: sameOriginUrl(u).href, template: null, textNumber, el: a });
            }
        }

        return links;
    }

    function createPager(board, thread) {
        const pager = {
            template: null,
            urls: new Map(),
            // False when link numbers aren't page numbers (e.g. post offsets),
            // so missing numbers can't be filled in from the template.
            gapFill: true,

            // Learns page URLs from a page's links. Returns false when the
            // page has no links to other pages.
            absorb(doc, docUrl) {
                const links = scanPageLinks(doc, docUrl, board, thread);
                const templated = links.filter(l => l.template);
                if (!templated.length) return false;

                if (!pager.template) {
                    const counts = new Map();
                    for (const l of templated) counts.set(l.template, (counts.get(l.template) || 0) + 1);
                    pager.template = [...counts].sort((a, b) => b[1] - a[1])[0][0];
                }

                for (const l of links) {
                    if (l.template && l.template !== pager.template) continue;
                    if (l.template && l.textNumber !== null && l.textNumber !== l.n) pager.gapFill = false;
                    if (!pager.urls.has(l.n)) pager.urls.set(l.n, l.url);
                }

                const own = pager.ownPageNumber(docUrl);
                if (own !== null && !pager.urls.has(own)) {
                    pager.urls.set(own, sameOriginUrl(toUrl(docUrl)).href);
                }
                return true;
            },

            ownPageNumber(docUrl) {
                const u = toUrl(docUrl);
                const info = u && pageInfo(u, board, thread);
                return info && info.template === pager.template ? info.n : null;
            },

            numbers() {
                const known = [...pager.urls.keys()].filter(n => n <= MAX_PAGES).sort((a, b) => a - b);
                if (!pager.template || !pager.gapFill || !known.length) return known;
                return Array.from({ length: known[known.length - 1] }, (_, i) => i + 1);
            },

            urlFor(n) {
                if (pager.urls.has(n)) return pager.urls.get(n);
                if (pager.template && pager.gapFill) return pager.template.replace('{page}', String(n));
                return null;
            },
        };

        return pager;
    }

    // Finds the pager for a thread starting from `entry` ({ doc, url }), which
    // is either a page of the thread or the notice page that links to one.
    // Returns { pager, first } where `first` is the page the pager came from,
    // { pager: null, first } when the notice led to a single page, or null.
    async function discoverPager(board, thread, entry, { force = false } = {}) {
        const pager = createPager(board, thread);
        let first = entry;

        if (!pager.absorb(entry.doc, entry.url)) {
            const notice = findNotice(entry.doc);
            const link = notice && pickNoticeLink(notice, entry.url, board, thread);
            debug('no page links on', entry.url, '- notice:', notice, 'link:', link);
            if (!link) return null;

            first = await getPage(link, { force });
            if (!pager.absorb(first.doc, first.url)) return { pager: null, first };
        }

        // The page we found the links on is page 1 if nothing says otherwise:
        // pagination usually links every page except the current one.
        let firstNumber = pager.ownPageNumber(first.url);
        if (firstNumber === null) {
            if (!pager.urls.has(1)) pager.urls.set(1, sameOriginUrl(toUrl(first.url)).href);
            if (urlKey(pager.urls.get(1)) === urlKey(first.url)) firstNumber = 1;
        }
        first.n = firstNumber;

        debug('pager', { template: pager.template, gapFill: pager.gapFill, pages: pager.numbers(), first: firstNumber });
        return { pager, first };
    }

    // Loads every page of a thread. Returns null when the thread isn't
    // paginated, else { pages: [{ n, doc, url }], failed: [{ n, error }] }.
    // With keepDocs false, pages are only fetched (and cached), not returned.
    async function collectThreadPages(board, thread, entry, options = {}) {
        const {
            force = false,
            refreshLast = false,
            background = false,
            keepDocs = true,
            onProgress = () => {},
        } = options;

        const found = await discoverPager(board, thread, entry, { force });
        if (!found) return null;

        const { pager, first } = found;
        if (!pager) return { pages: [{ n: 1, ...first }], failed: [] };

        const done = new Map();
        const failed = new Map();
        const keep = page => (keepDocs ? page : { stale: page.stale });
        if (first.n !== null) done.set(first.n, keep(first));

        const schedule = background ? backgroundLimit : fetchLimit;
        let lastChecked = !refreshLast;

        for (let round = 0; round < 50; round++) {
            const numbers = pager.numbers();
            const todo = numbers.filter(n => !done.has(n) && !failed.has(n));

            if (!todo.length) {
                // The last page is the one that gains posts while a thread
                // is alive; don't trust a cached copy of it.
                if (lastChecked) break;
                lastChecked = true;

                const last = numbers[numbers.length - 1];
                if (!done.has(last) || !done.get(last).stale) break;
                try {
                    const page = await getPage(pager.urlFor(last), { force: true });
                    pager.absorb(page.doc, page.url);
                    done.set(last, keep(page));
                } catch (error) {
                    debug('could not refresh the last page', error);
                }
                continue;
            }

            onProgress(done.size, numbers.length);

            await Promise.all(todo.map(n => schedule(async () => {
                const url = pager.urlFor(n);
                if (!url) {
                    failed.set(n, new Error('no URL for page ' + n));
                    return;
                }
                try {
                    const page = await getPage(url, { force });
                    pager.absorb(page.doc, page.url);
                    done.set(n, keep(page));
                } catch (error) {
                    failed.set(n, error);
                }
                onProgress(done.size, pager.numbers().length);
            })));
        }

        return {
            pages: keepDocs
                ? [...done].sort((a, b) => a[0] - b[0]).map(([n, page]) => ({ ...page, n }))
                : [],
            pageCount: done.size,
            failed: [...failed].map(([n, error]) => ({ n, error })),
        };
    }


    // ============================================================
    // FETCHING AND CACHE
    // ============================================================

    function createLimiter(max, gapMs = 0) {
        let active = 0;
        const queue = [];

        const next = () => {
            if (active >= max || !queue.length) return;
            active++;
            const { fn, resolve, reject } = queue.shift();
            Promise.resolve()
                .then(fn)
                .then(resolve, reject)
                .then(() => (gapMs ? sleep(gapMs) : null))
                .then(() => {
                    active--;
                    next();
                });
        };

        return fn => new Promise((resolve, reject) => {
            queue.push({ fn, resolve, reject });
            next();
        });
    }

    const fetchLimit = createLimiter(FETCH_CONCURRENCY);
    const backgroundLimit = createLimiter(1, BACKGROUND_FETCH_GAP_MS);

    async function fetchWithRetry(url) {
        let lastError = null;

        for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
            if (attempt) await sleep(1000 * 2 ** (attempt - 1));

            let res;
            try {
                res = await fetch(url, { credentials: 'same-origin' });
            } catch (error) {
                lastError = error;
                continue;
            }

            if (res.ok) return res;

            if (res.headers.get('cf-mitigated') === 'challenge') {
                throw new Error('Cloudflare asked for a check; reload the page and try again');
            }
            if (res.status === 429 || res.status >= 500) {
                lastError = new Error(`HTTP ${res.status}`);
                continue;
            }
            throw new Error(`HTTP ${res.status}`);
        }

        throw lastError || new Error('request failed');
    }

    let dbPromise = null;

    function openDb() {
        if (!dbPromise) {
            dbPromise = new Promise(resolve => {
                try {
                    const req = indexedDB.open(DB_NAME, 1);
                    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => resolve(null);
                    req.onblocked = () => resolve(null);
                } catch {
                    resolve(null);
                }
            });
        }
        return dbPromise;
    }

    // Runs one object-store operation. Resolves undefined when IndexedDB is
    // unavailable (private windows, blocked storage): the cache is optional.
    async function withStore(mode, fn) {
        const db = await openDb();
        if (!db) return undefined;

        return new Promise(resolve => {
            try {
                const tx = db.transaction(DB_STORE, mode);
                const req = fn(tx.objectStore(DB_STORE));
                tx.oncomplete = () => resolve(req ? req.result : undefined);
                tx.onerror = () => resolve(undefined);
                tx.onabort = () => resolve(undefined);
            } catch {
                resolve(undefined);
            }
        });
    }

    async function cacheGet(key) {
        const rec = await withStore('readonly', store => store.get(key));
        if (!rec || Date.now() - rec.time > CACHE_TTL_MS) return null;
        return { html: rec.html, finalUrl: rec.finalUrl };
    }

    function cachePut(key, page) {
        withStore('readwrite', store => store.put({ ...page, time: Date.now() }, key));
    }

    function cachePrune() {
        withStore('readwrite', store => {
            const req = store.openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return;
                if (Date.now() - cursor.value.time > CACHE_TTL_MS) cursor.delete();
                cursor.continue();
            };
            return null;
        });
    }

    // url key -> Promise<{ html, finalUrl }>
    const memoryCache = new Map();

    function rememberPage(key, promise) {
        memoryCache.delete(key);
        memoryCache.set(key, promise);
        while (memoryCache.size > MEMORY_CACHE_ENTRIES) {
            memoryCache.delete(memoryCache.keys().next().value);
        }
    }

    async function loadHtml(url, key, force) {
        if (!force) {
            const hit = await cacheGet(key);
            if (hit) {
                debug('cache hit', url);
                return { ...hit, stale: true };
            }
        }

        debug('fetch', url);
        const res = await fetchWithRetry(url);
        const page = { html: await res.text(), finalUrl: res.url || url };
        cachePut(key, page);

        // Post URLs redirect to their thread; remember the thread page too.
        const finalKey = urlKey(page.finalUrl);
        if (finalKey && finalKey !== key) {
            rememberPage(finalKey, Promise.resolve(page));
            cachePut(finalKey, page);
        }
        return page;
    }

    // Returns { doc, url, stale } for an archive page, where stale means it
    // came from IndexedDB. The page we're on is returned as the live document
    // instead of being fetched again.
    async function getPage(href, { force = false } = {}) {
        const url = sameOriginUrl(toUrl(href)).href;
        const key = urlKey(url);

        if (key === urlKey(location.href)) return { doc: document, url: location.href };

        let pending = force ? null : memoryCache.get(key);
        if (!pending) {
            pending = loadHtml(url, key, force);
            rememberPage(key, pending);
            pending.catch(() => {
                if (memoryCache.get(key) === pending) memoryCache.delete(key);
            });
        }

        const { html, finalUrl, stale = false } = await pending;
        return { doc: new DOMParser().parseFromString(html, 'text/html'), url: finalUrl, stale };
    }


    // ============================================================
    // IMPORTING POSTS
    // ============================================================

    // Copies a post from a fetched page into this document, with its links
    // and images made absolute against the page it came from.
    function importPost(el, baseUrl) {
        const copy = document.importNode(el, true);

        for (const node of copy.querySelectorAll('[href], [src]')) {
            for (const attr of ['href', 'src']) {
                const value = node.getAttribute(attr);
                if (!value || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(value)) continue;
                const abs = toUrl(value, baseUrl);
                if (abs) node.setAttribute(attr, abs.href);
            }
        }

        // Thousands of thumbnails shouldn't all load at once.
        for (const img of copy.querySelectorAll('img')) {
            const lazySrc = img.getAttribute('data-src') || img.getAttribute('data-original');
            const src = img.getAttribute('src');
            if (lazySrc && (!src || src.startsWith('data:'))) {
                const abs = toUrl(lazySrc, baseUrl);
                img.setAttribute('src', abs ? abs.href : lazySrc);
            }
            if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
        }

        copy.classList.add(IMPORTED_CLASS);
        return copy;
    }

    // A detached copy of a post for hover previews. The opening post's
    // <article> holds every reply, which a preview must not show.
    function importForPreview(el, baseUrl) {
        const copy = importPost(el, baseUrl);
        if (copy.matches('article.thread')) {
            for (const node of copy.querySelectorAll('aside.posts, article.post, .thread_tools_bottom, .js_hook_realtimethread')) {
                node.remove();
            }
        }
        return copy;
    }

    function previewNode(el) {
        const copy = el.ownerDocument === document ? el.cloneNode(true) : document.importNode(el, true);

        // Duplicate ids would make the clone look like the post itself.
        copy.removeAttribute('id');
        for (const node of copy.querySelectorAll('[id]')) node.removeAttribute('id');

        if (copy.matches('article.thread')) {
            for (const node of copy.querySelectorAll('aside.posts, article.post, .thread_tools_bottom, .js_hook_realtimethread')) {
                node.remove();
            }
        }

        copy.classList.remove('highlight', TARGET_CLASS);
        copy.style.display = '';
        return copy;
    }

    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function formatTime(d, format) {
        const pad = n => String(n).padStart(2, '0');
        return format.replace(/ddd|dd|mmm|mm|yyyy|yy|HH|MM|ss/g, token => {
            switch (token) {
                case 'ddd': return DAY_NAMES[d.getDay()];
                case 'dd': return pad(d.getDate());
                case 'mmm': return MONTH_NAMES[d.getMonth()];
                case 'mm': return pad(d.getMonth() + 1);
                case 'yyyy': return String(d.getFullYear());
                case 'yy': return pad(d.getFullYear() % 100);
                case 'HH': return pad(d.getHours());
                case 'MM': return pad(d.getMinutes());
                case 'ss': return pad(d.getSeconds());
                default: return token;
            }
        });
    }

    // The site rewrites post times into local time once, on load. Imported
    // posts miss that, so find the format the page uses (if it rewrote them)
    // and apply it ourselves. When no format matches, times are left as the
    // server rendered them, which is what the page shows too.
    function fixImportedTimes(posts) {
        if (!posts.length) return;

        let format = null;
        const samples = [...document.querySelectorAll('article time[datetime]')]
            .filter(t => !t.closest('.' + IMPORTED_CLASS))
            .slice(0, 10);

        for (const t of samples) {
            const d = new Date(t.getAttribute('datetime'));
            if (Number.isNaN(d.getTime())) continue;
            const text = t.textContent.trim();
            format = TIME_FORMATS.find(f => formatTime(d, f) === text) || null;
            if (format) break;
        }

        debug('time format', format);
        if (!format) return;

        for (const post of posts) {
            for (const t of post.querySelectorAll('time[datetime]')) {
                if (t.children.length) continue;
                const d = new Date(t.getAttribute('datetime'));
                if (!Number.isNaN(d.getTime())) t.textContent = formatTime(d, format);
            }
        }
    }


    // ============================================================
    // BUILDING THE FULL THREAD
    // ============================================================

    function ensureRepliesContainer(op) {
        const existing = op.querySelector(':scope > aside.posts') || op.querySelector('aside.posts');
        if (existing) return existing;

        const aside = document.createElement('aside');
        aside.className = 'posts';
        op.appendChild(aside);
        return aside;
    }

    // Puts the replies from every page into the live thread, in order.
    // Posts already on the page are kept as they are and only moved.
    function mergePages(pages) {
        const { thread } = state;

        let op = findThreadArticle(document, thread);
        if (!op) {
            const page = pages.find(p => findThreadArticle(p.doc, thread));
            if (!page) throw new Error('could not find the opening post on any page');

            op = importPost(findThreadArticle(page.doc, thread), page.url);
            const notice = findNotice(document);
            if (notice && mainArea(document).contains(notice)) notice.after(op);
            else mainArea(document).prepend(op);
        }

        const container = ensureRepliesContainer(op);
        const posts = new Map();

        for (const el of findReplies(document.body, thread)) {
            const key = normKey(el.id);
            if (!posts.has(key)) posts.set(key, el);
        }

        const imported = [];
        for (const page of pages) {
            if (page.doc === document) continue;
            for (const el of collectPosts(page.doc, thread).replies) {
                const key = normKey(el.id);
                if (posts.has(key)) continue;
                const copy = importPost(el, page.url);
                posts.set(key, copy);
                imported.push(copy);
            }
        }

        const fragment = document.createDocumentFragment();
        for (const key of [...posts.keys()].sort(compareKeys)) fragment.appendChild(posts.get(key));
        container.appendChild(fragment);

        fixImportedTimes(imported);
        rebuildBacklinks(op);

        return { replies: posts.size, imported: imported.length };
    }

    function makeBacklink(from, template) {
        const { board, thread } = state;
        const a = template ? template.cloneNode(false) : document.createElement('a');
        if (!template) a.className = 'backlink';
        a.href = `${threadUrl(board, thread)}#${from}`;
        a.dataset.function = 'highlight';
        a.dataset.backlink = 'true';
        a.dataset.board = board;
        a.dataset.post = from;
        a.textContent = '>>' + displayKey(from);
        return a;
    }

    function createBacklinkList(post, key) {
        const wrapper = document.createElement('div');
        wrapper.className = 'backlink_list';
        const span = document.createElement('span');
        span.className = 'post_backlink';
        span.dataset.post = key;
        wrapper.append('Quoted By: ', span);

        const text = ownElements(post, '.text')[0];
        if (text) text.before(wrapper);
        else post.appendChild(wrapper);
        return span;
    }

    // Each page only knows the backlinks between its own posts. Rebuild the
    // "Quoted By" lists from the quotes in every post of the joined thread.
    function rebuildBacklinks(op) {
        const { board, thread } = state;
        const posts = [op, ...findReplies(op, thread)];
        const byKey = new Map(posts.map(el => [normKey(el.id), el]));
        const quotedBy = new Map();

        for (const el of posts) {
            const from = normKey(el.id);
            for (const a of ownElements(el, '.text a')) {
                const t = linkTarget(a);
                if (!t || t.board !== board || t.key === from || !byKey.has(t.key)) continue;
                if (t.thread && t.thread !== String(thread)) continue;
                if (!quotedBy.has(t.key)) quotedBy.set(t.key, new Set());
                quotedBy.get(t.key).add(from);
            }
        }

        const template = document.querySelector('.post_backlink a[data-post]:not([data-b4kft])');

        for (const [key, sources] of quotedBy) {
            const post = byKey.get(key);
            const list = ownElements(post, '.post_backlink')[0] || createBacklinkList(post, key);

            const existing = new Map();
            for (const a of list.querySelectorAll('a')) {
                const t = linkTarget(a);
                if (t) existing.set(t.key, a);
            }

            const keys = new Set([...existing.keys(), ...sources]);
            const links = [...keys].sort(compareKeys).map(from => {
                if (existing.has(from)) return existing.get(from);
                const a = makeBacklink(from, template);
                a.dataset.b4kft = '1';
                return a;
            });

            list.replaceChildren();
            links.forEach((a, i) => {
                if (i) list.append(' ');
                list.append(a);
            });

            const wrapper = list.closest('.backlink_list');
            if (wrapper) wrapper.style.display = 'block';
        }
    }

    function hide(el) {
        el.style.display = 'none';
        el.dataset.b4kftHidden = '1';
    }

    // The block of page links around `a`, or `a` itself.
    function paginationBlock(a) {
        const isPageLevel = el => el === document.body || el.matches('#main, [role="main"]');
        let block = a;

        const list = a.closest('.paginate, .pagination, .pager, .pages, nav, ul, ol');
        if (list && !isPageLevel(list) && !list.querySelector('article') && list.textContent.length < 800) {
            block = list;
        } else if (a.parentElement && !isPageLevel(a.parentElement) &&
            !a.parentElement.querySelector('article') && a.parentElement.textContent.length < 400) {
            block = a.parentElement;
        }

        // Take wrappers that hold nothing but the page links along with it.
        const text = block.textContent.trim();
        while (block.parentElement && !isPageLevel(block.parentElement) &&
            block.parentElement.textContent.trim() === text) {
            block = block.parentElement;
        }
        return block;
    }

    function hidePageChrome() {
        const notice = findNotice(document);
        if (notice && !notice.querySelector('article')) hide(notice);

        const op = findThreadArticle(document, state.thread);
        for (const link of scanPageLinks(document, location.href, state.board, state.thread)) {
            const block = paginationBlock(link.el);
            if (!op || !block.contains(op)) hide(block);
        }
    }

    function showNote(pageCount, replyCount) {
        let note = document.querySelector('.' + NOTE_CLASS);
        if (!note) {
            note = document.createElement('div');
            note.className = NOTE_CLASS;
            const op = findThreadArticle(document, state.thread);
            if (op) op.before(note);
            else mainArea(document).prepend(note);
        }

        const reload = document.createElement('button');
        reload.type = 'button';
        reload.textContent = 'Reload pages';
        reload.addEventListener('click', () => buildFullThread({ force: true }));

        note.replaceChildren(
            `The archive splits this thread into ${pageCount} pages; they are joined here (${replyCount} replies). `,
            reload
        );
    }

    async function buildFullThread({ force = false } = {}) {
        if (state.building) return;
        state.building = true;
        status.show('Large thread: looking for its pages…');

        try {
            const result = await collectThreadPages(
                state.board,
                state.thread,
                { doc: document, url: location.href },
                {
                    force,
                    refreshLast: true,
                    onProgress: (done, total) => status.show(`Large thread: loaded ${done} of ${total} pages…`),
                }
            );

            if (!result) {
                if (state.paged) {
                    status.show('Large thread: could not work out the URLs of its other pages.', { error: true });
                } else {
                    debug('notice found but no way to the other pages; leaving the page alone');
                    status.hide();
                }
                return;
            }

            const { replies } = mergePages(result.pages);
            state.built = true;
            hidePageChrome();
            showNote(result.pages.length, replies);

            const key = state.pendingJump || hashKey(location.hash);
            state.pendingJump = null;
            const jumped = key ? jumpToPost(key) : true;

            if (result.failed.length) {
                const total = result.pages.length + result.failed.length;
                status.show(
                    `Large thread: ${result.failed.length} of ${total} pages failed to load ` +
                    `(${result.failed[0].error.message}).` +
                    (jumped ? '' : ` >>${displayKey(key)} may be on one of them.`),
                    { error: true, actions: [{ label: 'Retry', run: () => buildFullThread() }] }
                );
            } else if (!jumped) {
                status.show(`Large thread: >>${displayKey(key)} is not in this thread.`, { error: true });
            } else {
                status.show(`Large thread: showing all ${replies} replies from ${result.pages.length} pages.`, { hideAfter: 5000 });
            }
        } catch (error) {
            warn(error);
            status.show(`Large thread: ${error.message}`, {
                error: true,
                actions: [{ label: 'Retry', run: () => buildFullThread() }],
            });
        } finally {
            state.building = false;
        }
    }


    // ============================================================
    // GOING TO POSTS
    // ============================================================

    // Height of a fixed header at the top of the window, so the post we
    // scroll to doesn't end up underneath it.
    function fixedHeaderOffset() {
        let offset = 0;

        for (const x of [innerWidth / 2, 20, innerWidth - 20]) {
            let node = document.elementFromPoint(x, 2);
            while (node && node !== document.body && node !== document.documentElement) {
                const position = getComputedStyle(node).position;
                if (position === 'fixed' || position === 'sticky') {
                    offset = Math.max(offset, node.getBoundingClientRect().bottom);
                    break;
                }
                node = node.parentElement;
            }
        }

        return offset < innerHeight / 3 ? offset : 0;
    }

    function jumpToPost(key, { push = false } = {}) {
        const el = findPostIn(document, key, state && state.board);
        if (!el) return false;

        for (const old of document.querySelectorAll(`article.highlight, article.${TARGET_CLASS}`)) {
            old.classList.remove('highlight', TARGET_CLASS);
        }
        el.classList.add('highlight', TARGET_CLASS);

        el.scrollIntoView({ block: 'start' });
        const offset = fixedHeaderOffset();
        if (offset) window.scrollBy(0, -offset - 4);

        const hash = '#' + key;
        if (location.hash !== hash) {
            history[push ? 'pushState' : 'replaceState'](history.state, '', hash);
        }
        return true;
    }

    // Links to posts of this thread scroll to them instead of loading the
    // thread URL again (which would bring back the truncated view).
    function onClick(event) {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

        const a = event.target.closest && event.target.closest('a[href]');
        if (!a || a.dataset.function === 'quote' || a.target === '_blank') return;
        if (a.closest('#' + STATUS_ID + ', .' + NOTE_CLASS)) return;

        const t = linkTarget(a);
        if (!t || t.board !== state.board) return;
        if (t.thread && t.thread !== state.thread) return;

        if (findPostIn(document, t.key, t.board)) {
            event.preventDefault();
            jumpToPost(t.key, { push: true });
            return;
        }

        if (state.building && t.thread === state.thread) {
            event.preventDefault();
            state.pendingJump = t.key;
            status.show(`Large thread: will go to >>${displayKey(t.key)} once all pages are in…`);
        }
    }

    function onHashChange() {
        const key = hashKey(location.hash);
        if (!key) return;
        if (!jumpToPost(key) && state.building) state.pendingJump = key;
    }


    // ============================================================
    // QUOTE PREVIEWS
    // ============================================================

    // "board:key" -> detached <article> in this document
    const postCache = new Map();
    // "board:key" -> Promise<Element|null>
    const postLookups = new Map();
    // Posts the archive's API couldn't return; don't ask again.
    const apiMisses = new Set();
    // Threads already fetched in the background.
    const warmedThreads = new Set();

    async function fetchPostApi({ board, key }) {
        const vars = window.backend_vars || {};
        const base = toUrl(vars.api_url || '/', location.href);
        const u = new URL('_/api/chan/post/', base.href.endsWith('/') ? base.href : base.href + '/');
        u.searchParams.set('board', board);
        u.searchParams.set('num', key);
        if (vars.selected_theme) u.searchParams.set('theme', vars.selected_theme);

        const res = await fetch(sameOriginUrl(u).href, { credentials: 'same-origin' });
        if (!res.ok) return null;

        const data = await res.json();
        if (!data || data.error) return null;

        const thread = data.thread_num ? String(data.thread_num) : null;
        if (typeof data.formatted === 'string' && data.formatted.trim()) {
            const doc = new DOMParser().parseFromString(data.formatted, 'text/html');
            const node = doc.querySelector('article') || doc.body.firstElementChild;
            if (node) return { node: importForPreview(node, location.href), thread };
        }
        return { node: null, thread };
    }

    // Works out a post's thread from /board/post/N/, which either redirects to
    // the thread or shows the truncation notice with a link to it.
    async function threadOfPost({ board, key }) {
        const page = await getPage(`${location.origin}/${board}/post/${key}/`);

        const finalUrl = toUrl(page.url);
        const p = finalUrl ? parsePagePath(finalUrl.pathname) : { kind: 'other' };
        if (p.kind === 'thread' && p.board === board) return p.thread;

        const notice = findNotice(page.doc);
        if (notice) return threadLinkIn(notice.parentElement || notice, board, page.url);

        const article = findPostIn(page.doc, key, board);
        return article ? threadOfArticle(article) : null;
    }

    // Finds one post in a thread by binary search over its pages, which are
    // in post order. Returns a detached preview copy, or null.
    async function findPostInThread(board, thread, key) {
        const entry = await getPage(threadUrl(board, thread));
        let el = findPostIn(entry.doc, key, board);
        if (el) return importForPreview(el, entry.url);

        const found = await discoverPager(board, thread, entry);
        if (!found) return null;

        const { pager, first } = found;
        if (pager) warmThread(board, thread, entry);

        el = findPostIn(first.doc, key, board);
        if (el) return importForPreview(el, first.url);
        if (!pager) return null;

        const seen = new Set([first.n]);

        if (!pager.gapFill) {
            // Link numbers aren't page numbers; walk the known pages in order.
            for (let i = 0; i < MAX_PAGES; i++) {
                const n = pager.numbers().find(x => !seen.has(x));
                if (n === undefined) return null;
                seen.add(n);
                const page = await getPage(pager.urlFor(n));
                pager.absorb(page.doc, page.url);
                el = findPostIn(page.doc, key, board);
                if (el) return importForPreview(el, page.url);
            }
            return null;
        }

        const numbers = pager.numbers();
        const bounds = { lo: 1, hi: numbers[numbers.length - 1] || 1, hiFixed: false };

        // Moves the search window past page n. False when the key falls
        // inside page n's range but isn't on it (deleted or never archived).
        const narrow = (n, doc) => {
            const range = replyRange(doc, thread);
            if (!range || compareKeys(key, range.min) < 0) {
                bounds.hi = n - 1;
                bounds.hiFixed = true;
            } else if (compareKeys(key, range.max) > 0) {
                bounds.lo = n + 1;
                // Windowed pagination may only now reveal later pages.
                if (!bounds.hiFixed) {
                    const all = pager.numbers();
                    bounds.hi = Math.max(bounds.hi, all[all.length - 1] || 0);
                }
            } else {
                return false;
            }
            return true;
        };

        if (first.n !== null && !narrow(first.n, first.doc)) return null;

        while (bounds.lo <= bounds.hi) {
            const n = Math.floor((bounds.lo + bounds.hi) / 2);
            if (seen.has(n)) break;
            seen.add(n);

            const url = pager.urlFor(n);
            if (!url) break;

            const page = await getPage(url);
            pager.absorb(page.doc, page.url);

            el = findPostIn(page.doc, key, board);
            if (el) return importForPreview(el, page.url);
            if (!narrow(n, page.doc)) return null;
        }
        return null;
    }

    function warmThread(board, thread, entry) {
        const id = `${board}:${thread}`;
        if (!PREFETCH_THREAD_AFTER_PREVIEW || warmedThreads.has(id)) return;
        if (state && state.board === board && state.thread === thread) return;
        warmedThreads.add(id);

        collectThreadPages(board, thread, entry, { background: true, keepDocs: false })
            .then(result => debug('fetched thread in the background', id, result && result.pageCount))
            .catch(error => debug('background fetch failed', id, error));
    }

    function resolvePost(target, link) {
        const id = `${target.board}:${target.key}`;
        if (postLookups.has(id)) return postLookups.get(id);

        const lookup = (async () => {
            let thread = target.thread;

            if (!apiMisses.has(id)) {
                const api = await fetchPostApi(target).catch(() => null);
                if (api && api.node) return api.node;
                apiMisses.add(id);
                thread = thread || (api && api.thread);
            }

            if (!thread) thread = await threadOfPost(target).catch(error => {
                debug('post page lookup failed', id, error);
                return null;
            });

            // Most quotes point into the thread of the post they're in.
            if (!thread) thread = threadOfArticle(link.closest('article'));
            if (!thread) return null;

            debug('searching thread', thread, 'for', id);
            return findPostInThread(target.board, thread, target.key);
        })();

        postLookups.set(id, lookup);
        lookup
            .then(node => {
                if (node) postCache.set(id, node);
            }, () => {})
            .finally(() => postLookups.delete(id));

        return lookup;
    }

    let themeColors = null;

    function getThemeColors() {
        if (themeColors) return themeColors;

        const solid = el => {
            if (!el) return null;
            const bg = getComputedStyle(el).backgroundColor;
            return bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg) ? bg : null;
        };

        const page = solid(document.body) || solid(document.documentElement) || '#fff';
        const post = solid(document.querySelector('article.post')) || page;
        themeColors = { page, post, text: getComputedStyle(document.body).color };
        return themeColors;
    }

    function getPopup() {
        let popup = document.getElementById('backlink');
        if (!popup) {
            popup = document.createElement('div');
            popup.id = 'backlink';
            document.body.appendChild(popup);
        }
        return popup;
    }

    function showPopup(node, anchor) {
        const popup = getPopup();
        const colors = getThemeColors();
        const viewWidth = document.documentElement.clientWidth;

        popup.classList.add('b4kft-popup');
        popup.replaceChildren(node);
        Object.assign(popup.style, {
            display: 'block',
            position: 'fixed',
            left: '0px',
            top: '0px',
            zIndex: '10000',
            maxWidth: Math.min(900, viewWidth - 20) + 'px',
            background: colors.page,
        });

        const r = anchor.getBoundingClientRect();
        const width = popup.offsetWidth;
        const height = popup.offsetHeight;

        let left = r.right + 10;
        if (left + width > viewWidth - 10) left = Math.max(10, r.left - width - 10);

        let top = r.top + r.height / 2 - height / 2;
        top = Math.min(Math.max(10, top), Math.max(10, innerHeight - height - 10));

        popup.style.left = left + 'px';
        popup.style.top = top + 'px';
    }

    function hidePopup() {
        const popup = document.getElementById('backlink');
        if (!popup) return;
        popup.style.display = 'none';
        popup.replaceChildren();
    }

    function popupMessage(text, isError = false) {
        const colors = getThemeColors();
        const div = document.createElement('div');
        div.className = 'b4kft-popup-msg' + (isError ? ' b4kft-error' : '');
        div.style.background = colors.post;
        div.style.color = colors.text;
        div.textContent = text;
        return div;
    }

    const hover = { link: null, token: 0, timer: 0 };

    function onMouseOver(event) {
        const a = event.target.closest && event.target.closest('a');
        if (!a || a === hover.link) return;
        if (!a.closest('article') || a.closest('#backlink') || !isQuoteLink(a)) return;

        const target = linkTarget(a);
        if (!target) return;

        const onPage = findPostIn(document, target.key, target.board);
        if (onPage && NATIVE_PREVIEW && onPage.matches('article.post')) return;

        // From here on the preview is ours; keep the site's handler, which
        // would ask the API and show an error, out of it.
        event.stopImmediatePropagation();
        startPreview(a, target, onPage);
    }

    function startPreview(a, target, onPage) {
        hover.link = a;
        const token = ++hover.token;
        clearTimeout(hover.timer);

        if (onPage) {
            showPopup(previewNode(onPage), a);
            return;
        }

        const id = `${target.board}:${target.key}`;
        if (postCache.has(id)) {
            showPopup(previewNode(postCache.get(id)), a);
            return;
        }

        const label = '>>' + displayKey(target.key);
        showPopup(popupMessage(`Loading ${label}…`), a);

        hover.timer = setTimeout(async () => {
            let node = null;
            let error = null;
            try {
                node = await resolvePost(target, a);
            } catch (e) {
                error = e;
                warn('preview failed', id, e);
            }

            if (token !== hover.token) return;

            if (node) showPopup(previewNode(node), a);
            else if (error) showPopup(popupMessage(`Could not load ${label}: ${error.message}`, true), a);
            else showPopup(popupMessage(`${label} was not found.`, true), a);
        }, HOVER_DELAY_MS);
    }

    function onMouseOut(event) {
        if (!hover.link) return;
        const a = event.target.closest && event.target.closest('a');
        if (a !== hover.link) return;
        if (event.relatedTarget && hover.link.contains(event.relatedTarget)) return;

        hover.link = null;
        hover.token++;
        clearTimeout(hover.timer);
        hidePopup();
    }


    // ============================================================
    // STATUS AND STYLES
    // ============================================================

    const status = {
        el: null,
        timer: 0,

        show(text, { error = false, actions = [], hideAfter = 0 } = {}) {
            if (!this.el) {
                this.el = document.createElement('div');
                this.el.id = STATUS_ID;
                document.body.appendChild(this.el);
            }
            clearTimeout(this.timer);

            const message = document.createElement('span');
            message.textContent = text;
            this.el.replaceChildren(message);

            for (const { label, run } of actions) {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = label;
                button.addEventListener('click', run);
                this.el.append(button);
            }

            const close = document.createElement('button');
            close.type = 'button';
            close.textContent = '×';
            close.title = 'Close';
            close.addEventListener('click', () => this.hide());
            this.el.append(close);

            this.el.classList.toggle('b4kft-error', error);
            this.el.hidden = false;
            if (hideAfter) this.timer = setTimeout(() => this.hide(), hideAfter);
        },

        hide() {
            if (this.el) this.el.hidden = true;
        },
    };

    function addStyle() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${STATUS_ID} {
                position: fixed;
                right: 12px;
                bottom: 12px;
                z-index: 100000;
                max-width: min(440px, calc(100vw - 24px));
                padding: 8px 10px 8px 12px;
                border-radius: 6px;
                background: rgba(24, 24, 28, 0.92);
                color: #f2f2f2;
                font: 13px/1.4 sans-serif;
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
            }

            #${STATUS_ID}[hidden] {
                display: none;
            }

            #${STATUS_ID}.b4kft-error {
                background: rgba(125, 24, 24, 0.95);
            }

            #${STATUS_ID} button {
                margin-left: 8px;
                padding: 1px 8px;
                border: 1px solid rgba(255, 255, 255, 0.4);
                border-radius: 4px;
                background: transparent;
                color: inherit;
                font: inherit;
                cursor: pointer;
            }

            .b4kft-popup {
                max-height: calc(100vh - 20px);
                overflow: hidden;
                border: 1px solid rgba(128, 128, 128, 0.6);
                box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
            }

            .b4kft-popup-msg {
                padding: 6px 10px;
            }

            .b4kft-popup-msg.b4kft-error {
                color: #c0392b !important;
            }

            article.${TARGET_CLASS} {
                outline: 2px solid rgba(255, 140, 0, 0.85);
                outline-offset: -2px;
            }

            .${NOTE_CLASS} {
                margin: 8px 0;
                padding: 6px 10px;
                border: 1px dashed rgba(128, 128, 128, 0.6);
                font-size: 90%;
            }

            .${NOTE_CLASS} button {
                margin-left: 6px;
                cursor: pointer;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }


    // ============================================================
    // INIT
    // ============================================================

    function initThreadPage(here) {
        const probe = createPager(here.board, here.thread);
        const paged = probe.absorb(document, location.href);
        const notice = findNotice(document);

        debug('thread page', here, { paged, notice });
        if (!paged && !notice) return;

        state = {
            board: here.board,
            thread: here.thread,
            paged,
            building: false,
            built: false,
            pendingJump: null,
        };

        document.addEventListener('click', onClick, true);
        window.addEventListener('hashchange', onHashChange);

        if (AUTO_BUILD) {
            buildFullThread();
        } else {
            status.show('This thread is split into pages.', {
                actions: [{ label: 'Load all pages', run: () => buildFullThread() }],
            });
        }
    }

    // /board/post/N/ answered with the truncation notice instead of
    // redirecting: go to the thread ourselves, keeping the post in the hash.
    function handlePostPage(here) {
        const notice = findNotice(document);
        if (!notice) return;

        const scope = notice.parentElement && !notice.parentElement.querySelector('article')
            ? notice.parentElement
            : notice;
        const thread = threadLinkIn(scope, here.board, location.href);
        debug('post page', here, { notice, thread });
        if (!thread) return;

        location.replace(`${threadUrl(here.board, thread)}#${here.key}`);
    }

    function init() {
        addStyle();

        const here = parsePagePath(location.pathname);
        if (here.kind === 'post') handlePostPage(here);
        if (here.kind === 'thread') initThreadPage(here);

        document.addEventListener('mouseover', onMouseOver, true);
        document.addEventListener('mouseout', onMouseOut, true);

        setTimeout(cachePrune, 5000);
    }

    init();
})();
