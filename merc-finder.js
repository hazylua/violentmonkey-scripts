// ==UserScript==
// @name         PoE Trade Mercenary Skill Scanner
// @namespace    poe-trade-skill-scanner
// @version      1.0.0
// @description  Scan PoE trade result rows for configured skills and support gems.
// @match        https://www.pathofexile.com/trade/*
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const STORAGE_KEY = 'poeTradeMercScannerConfigV1';
    const STYLE_ID = 'poe-merc-scanner-style';
    const UI_ID = 'poe-merc-scanner-ui';

    // Used only if there is no saved configuration yet.
    const DEFAULT_CONFIG = [
        // Example:
        // {
        //     skill: 'Ice Shot',
        //     supports: [
        //         'Return',
        //         'Elemental Damage with Attacks',
        //         'Pierce',
        //         'Chain'
        //     ]
        // }
    ];

    let targets = loadConfig();

    let scanning = false;
    let scanToken = 0;

    let results = [];
    let resultKeys = new Set();

    let audioCtx = null;


    // ============================================================
    // CONFIG
    // ============================================================

    function loadConfig() {
        try {
            const value = JSON.parse(
                localStorage.getItem(STORAGE_KEY)
            );

            return Array.isArray(value)
                ? value
                : DEFAULT_CONFIG.slice();

        } catch {
            return DEFAULT_CONFIG.slice();
        }
    }

    function saveConfig() {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(targets)
        );
    }


    // ============================================================
    // HELPERS
    // ============================================================

    function norm(value) {
        return String(value ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function getRows() {
        return [
            ...document.querySelectorAll('.resultset > .row')
        ];
    }

    function getRowId(row) {
        return row?.dataset?.id || null;
    }


    // ============================================================
    // PARSE A TRADE ROW
    // ============================================================

    /*
        Given:

        <div class="item-mod item-mod--mercenary">

            <div>
                <img ...>
                <span>Ice Shot</span>
            </div>

            <div>
                <span>Return</span>
                (<span>Tier: 3</span>)
            </div>

            <div>
                <span>Pierce</span>
                (<span>Tier: 2</span>)
            </div>

        </div>

        This produces:

        {
            skill: "Ice Shot",
            supports: [
                "Return (Tier: 3)",
                "Pierce (Tier: 2)"
            ]
        }

        We subsequently normalize support names so that
        "Return" matches "Return (Tier: 3)".
    */

    function getSkillMods(row) {
        return [
            ...row.querySelectorAll('.item-mod--mercenary')
        ]
            .map(mod => {

                const blocks = [
                    ...mod.children
                ].filter(el => el.tagName === 'DIV');

                const skillBlock = blocks[0];

                const skill =
                    skillBlock
                        ?.querySelector('span')
                        ?.textContent
                        ?.trim() || '';

                /*
                    The first div is the skill.
                    Everything after that is a support.
                */
                const supports = blocks
                    .slice(1)
                    .map(el =>
                        el.textContent
                            .replace(/\s+/g, ' ')
                            .trim()
                    );

                return {
                    skill,
                    supports,
                    element: mod
                };
            })
            .filter(x => x.skill);
    }


    // ============================================================
    // MATCHING
    // ============================================================

    function cleanSupportName(value) {
        /*
            Converts:

                "Return (Tier: 3)"

            into:

                "return"

            Also handles things such as:

                "Elemental Damage with Attacks (Tier: 2)"
        */

        return norm(value)
            .replace(/\s*\(\s*tier:\s*\d+\s*\)\s*$/i, '')
            .trim();
    }

    function findMatch(row) {
        const mods = getSkillMods(row);

        for (const target of targets) {

            const wantedSkill = norm(target.skill);

            if (!wantedSkill)
                continue;

            const wantedSupports = (target.supports || [])
                .map(cleanSupportName)
                .filter(Boolean);

            for (const mod of mods) {

                // Skill must match exactly.
                if (norm(mod.skill) !== wantedSkill)
                    continue;

                const actualSupports = new Set(
                    mod.supports.map(cleanSupportName)
                );

                /*
                    Every configured support must exist
                    on this particular skill.
                */
                const missing = wantedSupports.filter(
                    support => !actualSupports.has(support)
                );

                if (missing.length === 0) {

                    return {
                        target,
                        skill: mod.skill,
                        supports: mod.supports
                            .map(cleanSupportName)
                    };
                }
            }
        }

        return null;
    }


    // ============================================================
    // RESULT INFORMATION
    // ============================================================

    function priceText(row) {
        return row
            .querySelector('.price')
            ?.innerText
            ?.replace(/\s+/g, ' ')
            .trim()
            || 'Price unavailable';
    }

    function sellerText(row) {
        return row
            .querySelector('.profile-link a')
            ?.textContent
            ?.trim()
            || 'Unknown seller';
    }


    // ============================================================
    // HIGHLIGHT / RESULTS
    // ============================================================

    function highlight(row) {
        row.classList.add('poe-merc-scan-hit');

        row.scrollIntoView({
            block: 'center',
            behavior: 'smooth'
        });
    }

    function addResult(row, match) {
        const id = getRowId(row);

        if (!id || resultKeys.has(id))
            return;

        resultKeys.add(id);

        results.push({
            id,

            skill: match.skill,

            supports: match.supports,

            target: match.target,

            price: priceText(row),

            seller: sellerText(row)
        });

        highlight(row);

        updateResultsButton();
    }

    function updateResultsButton() {
        const button = document.querySelector(
            '#poe-merc-results-button'
        );

        if (button) {
            button.textContent =
                `Results (${results.length})`;
        }
    }

    function rowStillExists(id) {
        return document.querySelector(
            `.resultset > .row[data-id="${CSS.escape(id)}"]`
        );
    }

    function scrollToResult(result) {

        const row = rowStillExists(result.id);

        if (!row) {
            alert(
                'That result is no longer present in the page DOM. ' +
                'Run the scan again if necessary.'
            );

            return;
        }

        highlight(row);

        closeModal('results');
    }


    // ============================================================
    // SCANNING
    // ============================================================

    function sleep(ms) {
        return new Promise(resolve =>
            setTimeout(resolve, ms)
        );
    }


    /*
        Wait for the trade site to load more results.

        We watch both:

            number of rows
            document height

        because either can change when more results are loaded.
    */
    async function waitForMoreRows(
        previousCount,
        previousHeight,
        token
    ) {

        const started = performance.now();

        const TIMEOUT = 8000;
        const POLL = 250;

        while (
            scanning &&
            token === scanToken &&
            performance.now() - started < TIMEOUT
        ) {

            await sleep(POLL);

            const count = getRows().length;

            const height =
                document.documentElement.scrollHeight;

            if (
                count > previousCount ||
                height > previousHeight + 50
            ) {
                return true;
            }
        }

        return false;
    }


    async function scan(token) {

        if (!targets.length) {

            alert(
                'No search targets configured. ' +
                'Open Config and add at least one skill.'
            );

            scanning = false;

            updateScanButton();

            return;
        }

        setStatus('Scanning…');

        let safety = 0;

        while (
            scanning &&
            token === scanToken &&
            safety++ < 100000
        ) {

            // ----------------------------------------------------
            // Process currently loaded rows
            // ----------------------------------------------------

            const rowsBefore = getRows();

            for (const row of rowsBefore) {

                if (
                    !scanning ||
                    token !== scanToken
                ) {
                    break;
                }

                if (
                    row.classList.contains(
                        'poe-merc-scan-processed'
                    )
                ) {
                    continue;
                }

                row.classList.add(
                    'poe-merc-scan-processed'
                );

                const match = findMatch(row);

                if (match) {
                    addResult(row, match);
                }
            }


            if (!scanning || token !== scanToken)
                break;


            // ----------------------------------------------------
            // Scroll to bottom
            // ----------------------------------------------------

            const beforeCount =
                getRows().length;

            const beforeHeight =
                document.documentElement.scrollHeight;

            const bottomY = Math.max(
                0,
                document.documentElement.scrollHeight -
                window.innerHeight
            );

            window.scrollTo({
                top: bottomY,
                behavior: 'smooth'
            });

            setStatus(
                `Scanning… ${results.length} ` +
                `match${results.length === 1 ? '' : 'es'}`
            );


            // Give the page time to reach the bottom.
            await sleep(700);


            // ----------------------------------------------------
            // Wait for lazy-loaded results
            // ----------------------------------------------------

            const loaded =
                await waitForMoreRows(
                    beforeCount,
                    beforeHeight,
                    token
                );


            if (
                !scanning ||
                token !== scanToken
            ) {
                break;
            }


            // ----------------------------------------------------
            // No more results?
            // ----------------------------------------------------

            if (!loaded) {

                const atBottom =
                    window.scrollY +
                    window.innerHeight >=
                    document.documentElement.scrollHeight - 8;

                if (atBottom) {
                    break;
                }
            }


            // ----------------------------------------------------
            // Process anything loaded while waiting
            // ----------------------------------------------------

            const nowRows = getRows();

            for (const row of nowRows) {

                if (
                    row.classList.contains(
                        'poe-merc-scan-processed'
                    )
                ) {
                    continue;
                }

                row.classList.add(
                    'poe-merc-scan-processed'
                );

                const match = findMatch(row);

                if (match) {
                    addResult(row, match);
                }
            }
        }


        if (token === scanToken) {
            finishScan();
        }
    }


    function startScan() {

        if (scanning) {
            stopScan();
            return;
        }


        // New scan = clear previous results.
        results = [];

        resultKeys = new Set();


        // Remove previous highlighting.
        document
            .querySelectorAll(
                '.poe-merc-scan-hit, ' +
                '.poe-merc-scan-processed'
            )
            .forEach(el => {

                el.classList.remove(
                    'poe-merc-scan-hit',
                    'poe-merc-scan-processed'
                );
            });


        scanning = true;

        scanToken++;

        updateScanButton();

        updateResultsButton();

        scan(scanToken);
    }


    function stopScan() {

        scanning = false;

        scanToken++;

        setStatus('Stopped.');

        updateScanButton();
    }


    function finishScan() {

        scanning = false;

        setStatus(
            `Finished — ${results.length} ` +
            `match${results.length === 1 ? '' : 'es'} found.`
        );

        updateScanButton();

        playFinishedJingle();
    }


    function setStatus(text) {

        const el = document.querySelector(
            '#poe-merc-scan-status'
        );

        if (el) {
            el.textContent = text;
        }
    }


    function updateScanButton() {

        const button = document.querySelector(
            '#poe-merc-scan-button'
        );

        if (!button)
            return;

        button.textContent =
            scanning
                ? 'Stop Scan'
                : 'Start Scan';

        button.classList.toggle(
            'running',
            scanning
        );
    }


    // ============================================================
    // FINISHED JINGLE
    // ============================================================

    function playFinishedJingle() {

        try {

            audioCtx ||= new (
                window.AudioContext ||
                window.webkitAudioContext
            )();

            const now =
                audioCtx.currentTime;

            const notes = [
                523.25,
                659.25,
                783.99,
                1046.5
            ];

            notes.forEach((frequency, i) => {

                const oscillator =
                    audioCtx.createOscillator();

                const gain =
                    audioCtx.createGain();

                oscillator.type = 'sine';

                oscillator.frequency.value =
                    frequency;

                const start =
                    now + i * 0.11;

                gain.gain.setValueAtTime(
                    0.0001,
                    start
                );

                gain.gain.exponentialRampToValueAtTime(
                    0.12,
                    start + 0.015
                );

                gain.gain.exponentialRampToValueAtTime(
                    0.0001,
                    start + 0.22
                );

                oscillator
                    .connect(gain)
                    .connect(audioCtx.destination);

                oscillator.start(start);

                oscillator.stop(start + 0.24);
            });

        } catch (e) {

            console.warn(
                '[PoE scanner] Could not play jingle:',
                e
            );
        }
    }


    // ============================================================
    // CSS
    // ============================================================

    function ensureStyle() {

        if (document.getElementById(STYLE_ID))
            return;

        const style =
            document.createElement('style');

        style.id = STYLE_ID;

        style.textContent = `

            #${UI_ID} {
                position: fixed;
                right: 18px;
                bottom: 18px;
                z-index: 2147483647;

                display: flex;
                flex-direction: column;
                gap: 6px;

                font-family: Arial, sans-serif;
            }


            #${UI_ID} button {
                border: 1px solid #777;

                background: #202020;
                color: #eee;

                padding: 8px 12px;

                border-radius: 4px;

                cursor: pointer;

                box-shadow:
                    0 2px 8px #0008;

                font-size: 13px;
            }


            #${UI_ID} button:hover {
                background: #333;
            }


            #poe-merc-modal button {
                border: 1px solid #777;

                background: #202020;
                color: #eee;

                padding: 8px 12px;

                border-radius: 4px;

                cursor: pointer;

                font-size: 13px;
            }


            #poe-merc-modal button:hover {
                background: #333;
            }


            #${UI_ID} button.running {
                background: #6b2525;
            }


            #poe-merc-scan-status {
                max-width: 260px;

                color: #ccc;

                font-size: 12px;

                text-align: right;

                text-shadow:
                    1px 1px 2px #000;
            }


            /*
                Highlight found listings.
            */

            .poe-merc-scan-hit {

                outline:
                    3px solid #f0c040 !important;

                outline-offset:
                    -3px !important;

                box-shadow:
                    0 0 18px #f0c04099 !important;
            }


            /*
                Modal
            */

            #poe-merc-modal-backdrop {

                position: fixed;

                inset: 0;

                z-index: 2147483646;

                background: #0009;

                display: flex;

                align-items: center;

                justify-content: center;

                font-family: Arial, sans-serif;
            }


            #poe-merc-modal {

                width:
                    min(760px, calc(100vw - 40px));

                max-height:
                    min(760px, calc(100vh - 40px));

                overflow: auto;

                background: #151515;

                color: #ddd;

                border:
                    1px solid #555;

                border-radius: 6px;

                box-shadow:
                    0 12px 40px #000;

                padding: 18px;
            }


            #poe-merc-modal h2 {

                margin:
                    0 0 14px;

                font-size: 18px;
            }


            #poe-merc-modal h3 {

                margin:
                    18px 0 8px;

                font-size: 14px;
            }


            /*
                Config target
            */

            .poe-merc-target {

                border:
                    1px solid #444;

                padding: 10px;

                margin-bottom: 8px;

                border-radius: 4px;

                background: #1d1d1d;
            }


            .poe-merc-target-title {

                font-weight: bold;

                color: #fff;
            }


            .poe-merc-target-supports {

                color: #aaa;

                margin-top: 4px;

                font-size: 12px;
            }


            /*
                Config form
            */

            .poe-merc-form {

                display: grid;

                grid-template-columns:
                    1fr 1fr auto;

                gap: 8px;
            }


            .poe-merc-form input {

                box-sizing: border-box;

                width: 100%;

                background: #0e0e0e;

                color: #eee;

                border:
                    1px solid #555;

                padding: 8px;

                border-radius: 3px;
            }


            .poe-merc-actions {

                display: flex;

                justify-content: flex-end;

                gap: 8px;

                margin-top: 14px;
            }


            /*
                Results
            */

            .poe-merc-result {

                border:
                    1px solid #444;

                padding: 10px;

                margin-bottom: 8px;

                border-radius: 4px;

                background: #1d1d1d;

                cursor: pointer;
            }


            .poe-merc-result:hover {
                background: #292929;
            }


            .poe-merc-result .skill {

                color: #f0d080;

                font-weight: bold;
            }


            .poe-merc-result .supports {

                color: #aaa;

                margin-top: 3px;
            }


            .poe-merc-result .meta {

                color: #888;

                font-size: 12px;

                margin-top: 6px;
            }


            .poe-merc-empty {

                color: #888;

                padding: 20px 0;

                text-align: center;
            }
        `;

        document.head.appendChild(style);
    }


    // ============================================================
    // UI
    // ============================================================

    function createUI() {

        if (document.getElementById(UI_ID))
            return;

        ensureStyle();

        const ui =
            document.createElement('div');

        ui.id = UI_ID;

        ui.innerHTML = `

            <div id="poe-merc-scan-status">
                Ready.
            </div>

            <button id="poe-merc-scan-button">
                Start Scan
            </button>

            <button id="poe-merc-config-button">
                Config
            </button>

            <button id="poe-merc-results-button">
                Results (0)
            </button>
        `;

        document.body.appendChild(ui);


        document
            .querySelector('#poe-merc-scan-button')
            .addEventListener(
                'click',
                startScan
            );


        document
            .querySelector('#poe-merc-config-button')
            .addEventListener(
                'click',
                openConfig
            );


        document
            .querySelector('#poe-merc-results-button')
            .addEventListener(
                'click',
                openResults
            );
    }


    // ============================================================
    // MODALS
    // ============================================================

    function closeModal(kind) {

        const modal =
            document.querySelector(
                `#poe-merc-modal-backdrop[data-kind="${kind}"]`
            );

        modal?.remove();
    }


    function createModal(kind, title) {

        document
            .querySelectorAll(
                '#poe-merc-modal-backdrop'
            )
            .forEach(el => el.remove());


        const backdrop =
            document.createElement('div');

        backdrop.id =
            'poe-merc-modal-backdrop';

        backdrop.dataset.kind =
            kind;

        backdrop.innerHTML = `

            <div id="poe-merc-modal">

                <h2>${title}</h2>

                <div id="poe-merc-modal-content">
                </div>

            </div>
        `;


        backdrop.addEventListener(
            'click',
            event => {

                if (
                    event.target === backdrop
                ) {
                    backdrop.remove();
                }
            }
        );


        document.body.appendChild(backdrop);


        return backdrop.querySelector(
            '#poe-merc-modal-content'
        );
    }


    // ============================================================
    // CONFIG MODAL
    // ============================================================

    function openConfig() {

        const content =
            createModal(
                'config',
                'Mercenary Skill Scanner — Config'
            );


        const list =
            document.createElement('div');

        list.innerHTML =
            '<h3>Search targets</h3>';


        function renderTargets() {

            list
                .querySelectorAll(
                    '.poe-merc-target'
                )
                .forEach(
                    el => el.remove()
                );


            if (!targets.length) {

                const empty =
                    document.createElement('div');

                empty.className =
                    'poe-merc-empty poe-merc-target';

                empty.textContent =
                    'No targets configured.';

                list.appendChild(empty);

                return;
            }


            targets.forEach(
                (target, index) => {

                    const item =
                        document.createElement('div');

                    item.className =
                        'poe-merc-target';


                    item.innerHTML = `

                        <div class="poe-merc-target-title">
                        </div>

                        <div class="poe-merc-target-supports">
                        </div>
                    `;


                    item
                        .querySelector(
                            '.poe-merc-target-title'
                        )
                        .textContent =
                        target.skill;


                    item
                        .querySelector(
                            '.poe-merc-target-supports'
                        )
                        .textContent =
                        target.supports?.length

                            ? `Requires: ${
                                target.supports.join(', ')
                            }`

                            : 'Requires no supports';


                    const remove =
                        document.createElement('button');

                    remove.textContent =
                        'Remove';

                    remove.style.marginTop =
                        '7px';


                    remove.addEventListener(
                        'click',
                        () => {

                            targets.splice(
                                index,
                                1
                            );

                            saveConfig();

                            renderTargets();
                        }
                    );


                    item.appendChild(remove);

                    list.appendChild(item);
                }
            );
        }


        content.appendChild(list);


        const help =
            document.createElement('p');

        help.style.color =
            '#999';

        help.style.fontSize =
            '12px';

        help.textContent =
            'Each target matches one mercenary skill. ' +
            'All configured supports must be present on that skill. ' +
            'Matching ignores capitalization, whitespace differences, ' +
            'and support tier numbers.';

        content.appendChild(help);


        const form =
            document.createElement('div');

        form.className =
            'poe-merc-form';


        form.innerHTML = `

            <input
                id="poe-merc-skill-input"
                placeholder="Skill, e.g. Ice Shot"
            >

            <input
                id="poe-merc-support-input"
                placeholder="Supports, comma separated"
            >

            <button id="poe-merc-add-target">
                Add
            </button>
        `;


        content.appendChild(form);


        form
            .querySelector(
                '#poe-merc-add-target'
            )
            .addEventListener(
                'click',
                () => {

                    const skill =
                        form
                            .querySelector(
                                '#poe-merc-skill-input'
                            )
                            .value
                            .trim();


                    const supports =
                        form
                            .querySelector(
                                '#poe-merc-support-input'
                            )
                            .value
                            .split(',')
                            .map(s => s.trim())
                            .filter(Boolean);


                    if (!skill)
                        return;


                    targets.push({
                        skill,
                        supports
                    });


                    saveConfig();


                    form
                        .querySelector(
                            '#poe-merc-skill-input'
                        )
                        .value = '';


                    form
                        .querySelector(
                            '#poe-merc-support-input'
                        )
                        .value = '';


                    renderTargets();
                }
            );


        const actions =
            document.createElement('div');

        actions.className =
            'poe-merc-actions';


        const close =
            document.createElement('button');

        close.textContent =
            'Close';


        close.addEventListener(
            'click',
            () => closeModal('config')
        );


        actions.appendChild(close);

        content.appendChild(actions);


        renderTargets();
    }


    // ============================================================
    // RESULTS MODAL
    // ============================================================

    function openResults() {

        const content =
            createModal(
                'results',
                `Scan Results (${results.length})`
            );


        if (!results.length) {

            const empty =
                document.createElement('div');

            empty.className =
                'poe-merc-empty';

            empty.textContent =
                'No matches yet.';

            content.appendChild(empty);

            return;
        }


        results.forEach(
            (result, index) => {

                const item =
                    document.createElement('div');

                item.className =
                    'poe-merc-result';


                const skill =
                    document.createElement('div');

                skill.className =
                    'skill';

                skill.textContent =
                    `${index + 1}. ${result.skill}`;


                const supports =
                    document.createElement('div');

                supports.className =
                    'supports';

                supports.textContent =
                    result.supports.length

                        ? result.supports.join(' • ')

                        : 'No supports';


                const meta =
                    document.createElement('div');

                meta.className =
                    'meta';

                meta.textContent =
                    `${result.price} — ${result.seller}`;


                item.append(
                    skill,
                    supports,
                    meta
                );


                item.addEventListener(
                    'click',
                    () => scrollToResult(result)
                );


                content.appendChild(item);
            }
        );


        const actions =
            document.createElement('div');

        actions.className =
            'poe-merc-actions';


        const close =
            document.createElement('button');

        close.textContent =
            'Close';


        close.addEventListener(
            'click',
            () => closeModal('results')
        );


        actions.appendChild(close);

        content.appendChild(actions);
    }


    // ============================================================
    // INITIALIZATION
    // ============================================================

    function init() {

        if (!document.body) {

            setTimeout(
                init,
                100
            );

            return;
        }

        createUI();
    }


    init();

})();
