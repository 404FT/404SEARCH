// ==UserScript==
// @name         Shikimori Advanced Search (GraphQL)
// @version      1.3
// @description  Performs a simultaneous GraphQL search and prepends results to the search box.
// @match        https://shikimori.one/*
// @match        https://shiki.one/*
// @match        https://shikimori.io/*
// @author       404FT
// @updateURL    https://raw.githubusercontent.com/404FT/404SEARCH/refs/heads/main/404SEARCH.user.js
// @downloadURL  https://raw.githubusercontent.com/404FT/404SEARCH/refs/heads/main/404SEARCH.user.js
// @license      MIT
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
    'use strict';

    // --- CONFIGURATION ---
    const CONFIG = {
        DEBUG_MODE: true,
        GRAPHQL_URL: '/api/graphql',
        DEBOUNCE_MS: 300,
        MAX_RESULTS_PER_CATEGORY: 8,
        FINAL_LIMIT: 5
    };

    // --- STATE MANAGEMENT ---
    let cachedResultsHTML = '';
    let activeRequestController = null;

    // --- LOGGING ---
    const log = (...args) => console.log('[AdvSrch]', ...args);
    const debug = (...args) => CONFIG.DEBUG_MODE && console.log('[AdvSrch]', ...args);

    // --- DICTIONARIES (Localization) ---
    const KIND_MAP = {
        tv: "TV Сериал", movie: "Фильм", ova: "OVA", ona: "ONA",
        special: "Спецвыпуск", tv_special: "TV Спецвыпуск", music: "Клип",
        pv: "PV", cm: "CM", manga: "Манга", manhwa: "Манхва", manhua: "Маньхуа",
        novel: "Ранобэ", one_shot: "Ваншот", doujin: "Додзинси"
    };

    const STATUS_MAP = {
        released: "вышло",
        ongoing: "онгоинг",
        anons: "анонс",
        paused: "приостановлено",
        discontinued: "прекращено"
    };

    // --- GRAPHQL QUERIES ---
    const QUERIES = {
        anime: `query($search: String) {
            animes(search: $search, limit: ${CONFIG.MAX_RESULTS_PER_CATEGORY}, censored: false) {
                id name russian english synonyms url kind status
                airedOn { year }
                studios { name }
                genres { id name russian }
                poster { miniUrl mainUrl }
            }
        }`,
        manga: `query($search: String) {
            mangas(search: $search, limit: ${CONFIG.MAX_RESULTS_PER_CATEGORY}, censored: false) {
                id name russian english synonyms url kind status
                airedOn { year }
                publishers { name }
                genres { id name russian }
                poster { miniUrl mainUrl }
            }
        }`,
        ranobe: `query($search: String) {
            mangas(search: $search, limit: ${CONFIG.MAX_RESULTS_PER_CATEGORY}, censored: false, kind: "novel") {
                id name russian english synonyms url kind status
                airedOn { year }
                publishers { name }
                genres { id name russian }
                poster { miniUrl mainUrl }
            }
        }`,
        character: `query($search: String) {
            characters(search: $search, limit: ${CONFIG.MAX_RESULTS_PER_CATEGORY}) {
                id name russian english synonyms url
                poster { miniUrl mainUrl }
                isAnime isManga isRanobe
            }
        }`,
        person: `query($search: String) {
            people(search: $search, limit: ${CONFIG.MAX_RESULTS_PER_CATEGORY}) {
                id name russian english synonyms url
                poster { miniUrl mainUrl }
                isSeyu isMangaka isProducer
            }
        }`
    };

    // --- FETCH HANDLER ---
    const fetchGraphQL = async (query, searchTerm) => {
        if (activeRequestController) activeRequestController.abort();
        activeRequestController = new AbortController();

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || '',
            'X-Requested-With': 'XMLHttpRequest'
        };

        try {
            const response = await fetch(CONFIG.GRAPHQL_URL, {
                method: 'POST',
                headers,
                body: JSON.stringify({ query, variables: { search: searchTerm } }),
                signal: activeRequestController.signal
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const json = await response.json();
            debug('GraphQL response:', json);
            return json.data;
        } catch (e) {
            if (e.name !== 'AbortError') console.error('[AdvSrch] Fetch error:', e);
            return null;
        }
    };

    // --- РЕЛЕВАНТНОСТЬ (учитываем синонимы и альтернативные названия) ---
    function getRelevanceScore(item, termLower) {
        let score = 0;
        const titles = [
            (item.russian || '').toLowerCase(),
            (item.name || '').toLowerCase(),
            (item.english || '').toLowerCase(),
            ...(item.synonyms || []).map(s => s.toLowerCase())
        ];

        for (const title of titles) {
            if (!title) continue;
            if (title === termLower) score += 20;
            else if (title.startsWith(termLower)) score += 12;
            else if (title.includes(termLower)) score += 8;
        }

        return score;
    }

    // --- HTML BUILDERS ---
    const buildAnimeHTML = (item) => {
        const titleRu = item.russian || item.name || item.english || '???';
        const url = item.url;
        const kindLabel = KIND_MAP[item.kind] || item.kind;
        const year = item.airedOn?.year ? `${item.airedOn.year} год` : '';
        const studio = item.studios?.[0]?.name || '';
        const statusLabel = STATUS_MAP[item.status] || item.status;

        const genresHtml = (item.genres || []).slice(0, 3).map(g => `
            <div class="b-tag" data-href="https://shikimori.one/animes/genre/${g.id}-${g.name}">
                <span class="genre-en">${g.name}</span><span class="genre-ru">${g.russian}</span>
            </div>
        `).join('');

        let metaLine = `<div class="b-tag">${kindLabel}</div>`;
        if (year) metaLine += `<div class="b-tag">${year}</div>`;
        if (studio) metaLine += `<div class="b-anime_status_tag studio" data-text="${studio}" title="${studio}"></div>`;
        metaLine += `<div class="b-anime_status_tag released" data-text="${statusLabel}"></div>`;

        return `
        <a class="b-db_entry-variant-list_item" data-id="${item.id}" href="${url}" data-adv="true">
            <div class="image"><img src="${item.poster.miniUrl}" srcset="${item.poster.mainUrl} 2x" alt="${titleRu}"></div>
            <div class="info">
                <div class="name"><span class="b-link">${titleRu}<span class="b-separator inline">/</span>${item.name}</span></div>
                <div class="line"><div class="key">Тип:</div><div class="value">${metaLine}</div></div>
                <div class="line"><div class="key">Жанры:</div><div class="value">${genresHtml}</div></div>
            </div>
        </a>`;
    };

    const buildMangaHTML = (item) => {
        const titleRu = item.russian || item.name || item.english || '???';
        const url = item.url;
        const kindLabel = KIND_MAP[item.kind] || 'Манга';
        const year = item.airedOn?.year ? `${item.airedOn.year} год` : '';
        const publisher = item.publishers?.[0]?.name || '';
        const statusLabel = item.status === 'released' ? 'издано' : (STATUS_MAP[item.status] || item.status);

        const genresHtml = (item.genres || []).slice(0, 3).map(g => `
            <div class="b-tag" data-href="https://shikimori.one/mangas/genre/${g.id}-${g.name}">
                <span class="genre-en">${g.name}</span><span class="genre-ru">${g.russian}</span>
            </div>
        `).join('');

        let metaLine = `<div class="b-tag">${kindLabel}</div>`;
        if (year) metaLine += `<div class="b-tag">${year}</div>`;
        if (publisher) metaLine += `<div class="b-anime_status_tag studio" data-text="${publisher}" title="${publisher}"></div>`;
        metaLine += `<div class="b-anime_status_tag released" data-text="${statusLabel}"></div>`;

        return `
        <a class="b-db_entry-variant-list_item" data-id="${item.id}" href="${url}" data-adv="true">
            <div class="image"><img src="${item.poster.miniUrl}" srcset="${item.poster.mainUrl} 2x" alt="${titleRu}"></div>
            <div class="info">
                <div class="name"><span class="b-link">${titleRu}<span class="b-separator inline">/</span>${item.name}</span></div>
                <div class="line"><div class="key">Тип:</div><div class="value">${metaLine}</div></div>
                <div class="line"><div class="key">Жанры:</div><div class="value">${genresHtml}</div></div>
            </div>
        </a>`;
    };

    const buildCharacterHTML = (item) => {
        const titleRu = item.russian || item.name || item.english || '???';
        const url = item.url;
        const types = [];
        if (item.isAnime) types.push('аниме');
        if (item.isManga) types.push('манги');
        if (item.isRanobe) types.push('ранобэ');

        let subtitle = 'Персонаж';
        if (types.length) {
            subtitle += ` ${types.length > 1 ? types.slice(0, -1).join(', ') + ' и ' + types[types.length-1] : types[0]}`;
        }

        return `
        <a class="b-db_entry-variant-list_item" data-id="${item.id}" href="${url}" data-adv="true">
            <div class="image"><img src="${item.poster.miniUrl}" srcset="${item.poster.mainUrl} 2x" alt="${titleRu}"></div>
            <div class="info">
                <div class="name"><span class="b-link">${titleRu}<span class="b-separator inline">/</span>${item.name}</span></div>
                <div class="line"><div class="value"><div class="b-tag">${subtitle}</div></div></div>
            </div>
        </a>`;
    };

    const buildPersonHTML = (item) => {
        const titleRu = item.russian || item.name || item.english || '???';
        const url = item.url;
        let subtitle = 'Участник проекта';
        if (item.isSeyu) subtitle = 'Сэйю';
        else if (item.isMangaka) subtitle = 'Автор манги';
        else if (item.isProducer) subtitle = 'Режиссёр / Продюсер';

        return `
        <a class="b-db_entry-variant-list_item" data-id="${item.id}" href="${url}" data-adv="true">
            <div class="image"><img src="${item.poster.miniUrl}" srcset="${item.poster.mainUrl} 2x" alt="${titleRu}"></div>
            <div class="info">
                <div class="name"><span class="b-link">${titleRu}<span class="b-separator inline">/</span>${item.name}</span></div>
                <div class="line"><div class="value"><div class="b-tag">${subtitle}</div></div></div>
            </div>
        </a>`;
    };

    // --- MAIN SEARCH LOGIC ---
    const performSearch = async (container, input) => {
        const term = input.value.trim();
        if (!term) {
            cachedResultsHTML = '';
            renderResults(container);
            return;
        }

        // Определяем режим поиска
        const modeEl = container.querySelector('.search-mode.active') || container.querySelector('.search-mode');
        let mode = modeEl?.dataset.mode || 'anime';
        if (!['anime', 'manga', 'ranobe', 'character', 'person'].includes(mode)) mode = 'anime';

        debug(`Поиск "${term}" в режиме "${mode}"`);

        const query = QUERIES[mode];
        const data = await fetchGraphQL(query, term);

        if (!data) {
            cachedResultsHTML = '';
            renderResults(container);
            return;
        }

        let items = [];
        if (data.animes) items = data.animes;
        else if (data.mangas) items = data.mangas;
        else if (data.characters) items = data.characters;
        else if (data.people) items = data.people;

        const termLower = term.toLowerCase();

        // Сортируем по релевантности (учитываем синонимы)
        items.sort((a, b) => getRelevanceScore(b, termLower) - getRelevanceScore(a, termLower));

        // Берём только топ-N
        items = items.slice(0, CONFIG.FINAL_LIMIT);

        let resultsHtml = '';
        if (items.length > 0) {
            if (mode === 'anime')      resultsHtml = items.map(buildAnimeHTML).join('');
            else if (mode === 'manga' || mode === 'ranobe') resultsHtml = items.map(buildMangaHTML).join('');
            else if (mode === 'character') resultsHtml = items.map(buildCharacterHTML).join('');
            else if (mode === 'person')    resultsHtml = items.map(buildPersonHTML).join('');

            cachedResultsHTML = `
                <div class="adv-results-group">
                    <div class="adv-result-label" style="padding: 5px 10px; font-size: 0.8em; opacity: 0.6;">GraphQL Results:</div>
                    ${resultsHtml}
                </div>
                <div class="adv-separator" style="height: 15px; border-bottom: 1px dashed rgba(127,127,127,0.2); margin-bottom: 10px;"></div>
            `;
        } else {
            cachedResultsHTML = '';
        }

        renderResults(container);
    };

    // --- DOM MANIPULATION ---
    const renderResults = (container) => {
        const wrapperId = 'adv-search-wrapper';
        let wrapper = container.querySelector(`#${wrapperId}`);

        // Если видим режимы поиска (не в процессе поиска) → убираем результаты
        if (container.querySelector('.search-mode') || !cachedResultsHTML) {
            if (wrapper) wrapper.remove();
            return;
        }

        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.id = wrapperId;
            container.prepend(wrapper);
        }

        if (wrapper.innerHTML !== cachedResultsHTML) {
            wrapper.innerHTML = cachedResultsHTML;
        }
    };

    // --- INITIALIZATION & EVENTS ---
    let observerInstance = null;

    const attachSearchListener = (resultsInner, inputField) => {
        if (resultsInner.dataset.advAttached === 'true') return;
        resultsInner.dataset.advAttached = 'true';

        let debounceTimer;
        inputField.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => performSearch(resultsInner, inputField), CONFIG.DEBOUNCE_MS);
        });

        const observer = new MutationObserver(() => renderResults(resultsInner));
        observer.observe(resultsInner, { childList: true, subtree: true });
    };

    const init = () => {
        if (observerInstance) observerInstance.disconnect();

        observerInstance = new MutationObserver(() => {
            const globalSearch = document.querySelector('.global-search');
            if (!globalSearch) return;

            const input = globalSearch.querySelector('input');
            const inner = globalSearch.querySelector('.search-results .inner');

            if (input && inner) {
                attachSearchListener(inner, input);
            }
        });

        observerInstance.observe(document.body, { childList: true, subtree: true });
        log("Скрипт запущен (v1.3)");
    };

    // Запуск
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }

    document.addEventListener('turbolinks:load', init);
})();
