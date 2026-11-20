// ==UserScript==
// @name         Vinted Real Price
// @name:it      Vinted Real Price – prezzo reale con spedizione
// @namespace    https://github.com/r-carissimi
// @version      1.2.0
// @description  Shows the price you'll actually pay on Vinted (item + buyer protection fee + cheapest shipping) and adds a "Real price" sort option.
// @description:it Mostra il prezzo che pagherai davvero su Vinted (articolo + commissione + spedizione più economica) e aggiunge l'ordinamento per prezzo reale.
// @author       r-carissimi
// @license      MIT
// @homepageURL  https://github.com/r-carissimi/vinted-real-price
// @supportURL   https://github.com/r-carissimi/vinted-real-price/issues
// @match        https://www.vinted.at/*
// @match        https://www.vinted.be/*
// @match        https://www.vinted.co.uk/*
// @match        https://www.vinted.com/*
// @match        https://www.vinted.cz/*
// @match        https://www.vinted.de/*
// @match        https://www.vinted.dk/*
// @match        https://www.vinted.ee/*
// @match        https://www.vinted.es/*
// @match        https://www.vinted.fi/*
// @match        https://www.vinted.fr/*
// @match        https://www.vinted.gr/*
// @match        https://www.vinted.hr/*
// @match        https://www.vinted.hu/*
// @match        https://www.vinted.ie/*
// @match        https://www.vinted.it/*
// @match        https://www.vinted.lt/*
// @match        https://www.vinted.lu/*
// @match        https://www.vinted.lv/*
// @match        https://www.vinted.nl/*
// @match        https://www.vinted.pl/*
// @match        https://www.vinted.pt/*
// @match        https://www.vinted.ro/*
// @match        https://www.vinted.se/*
// @match        https://www.vinted.si/*
// @match        https://www.vinted.sk/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  // www.vinted.it -> https://api.edge.vinted.it (same pattern on every Vinted domain)
  const API_BASE = 'https://api.edge.' + location.hostname.replace(/^www\./, '');
  const CONCURRENCY = 6;
  const CACHE_TTL_MS = 30 * 60 * 1000;
  // Bump when the shape of cached data changes, so stale entries are ignored.
  const CACHE_PREFIX = 'vrp:v1:';
  const UNKNOWN_ORDER = 999999999;
  const SORT_VALUE = 'vrp_real_price';

  // Catalog cards: product-item-id-123--breakdown. Home feed: feed-item--breakdown (id only in the link).
  const ITEM_TESTID_RE = /^product-item-id-(\d+)--breakdown$/;
  const ITEM_HREF_RE = /\/items\/(\d+)/;
  const ITEM_PAGE_RE = /^\/items\/(\d+)/;

  const SEL = {
    price: '[data-testid="total-combined-price"]',
    feeLabel: '[data-testid="service-fee-included-title"]',
    sidebar: '[data-testid="item-sidebar-price-container"]',
    gridItem: '[data-testid="grid-item"]',
    breakdown: '[data-testid$="--breakdown"]',
    sortDropdown: '[data-testid="sort-by-dropdown"]',
    sortTrigger: '[data-testid="catalog--sort-filter--trigger"]',
    sortTriggerText: '[data-testid="catalog--sort-filter--trigger--text"]',
  };

  // ---------------------------------------------------------------------------
  // i18n (follows the site language, falls back to English)
  // ---------------------------------------------------------------------------

  const STRINGS = {
    en: {
      inclShipping: 'incl. shipping',
      inclFeeShipping: 'incl. fee & shipping',
      pickupOnly: 'incl. · pickup only',
      sortOption: 'Real price: low to high',
      sortChip: 'Real price',
      item: 'item',
      fee: 'fee',
      shipping: 'shipping (cheapest)',
      freeShipping: 'free shipping',
    },
    it: {
      inclShipping: 'incl. sped.',
      inclFeeShipping: 'incl. commissione e spedizione',
      pickupOnly: 'incl. · solo ritiro',
      sortOption: 'Prezzo reale (crescente)',
      sortChip: 'Prezzo reale',
      item: 'articolo',
      fee: 'commissione',
      shipping: 'spedizione (minima)',
      freeShipping: 'spedizione gratis',
    },
    fr: {
      inclShipping: 'livraison incl.',
      inclFeeShipping: 'frais et livraison incl.',
      pickupOnly: 'incl. · remise en main propre',
      sortOption: 'Prix réel : croissant',
      sortChip: 'Prix réel',
      item: 'article',
      fee: 'frais',
      shipping: 'livraison (min.)',
      freeShipping: 'livraison gratuite',
    },
    de: {
      inclShipping: 'inkl. Versand',
      inclFeeShipping: 'inkl. Gebühr & Versand',
      pickupOnly: 'inkl. · nur Abholung',
      sortOption: 'Echter Preis: aufsteigend',
      sortChip: 'Echter Preis',
      item: 'Artikel',
      fee: 'Gebühr',
      shipping: 'Versand (günstigster)',
      freeShipping: 'kostenloser Versand',
    },
    es: {
      inclShipping: 'envío incl.',
      inclFeeShipping: 'tarifa y envío incl.',
      pickupOnly: 'incl. · solo recogida',
      sortOption: 'Precio real: de menor a mayor',
      sortChip: 'Precio real',
      item: 'artículo',
      fee: 'tarifa',
      shipping: 'envío (mín.)',
      freeShipping: 'envío gratis',
    },
  };

  const LOCALE = document.documentElement.lang || navigator.language || 'en';
  const T = STRINGS[LOCALE.slice(0, 2).toLowerCase()] || STRINGS.en;

  const fmtCache = {};
  function fmt(amount, currency) {
    if (!fmtCache[currency]) {
      fmtCache[currency] = new Intl.NumberFormat(LOCALE, { style: 'currency', currency });
    }
    return fmtCache[currency].format(amount);
  }

  // ---------------------------------------------------------------------------
  // Pricing data: Vinted's own price-breakdown endpoint (the one behind the "incl." popup)
  // ---------------------------------------------------------------------------

  const memo = new Map(); // id -> Promise<info>
  const queue = [];
  let active = 0;

  function cacheGet(id) {
    try {
      const raw = sessionStorage.getItem(CACHE_PREFIX + id);
      if (!raw) return null;
      const { t, v } = JSON.parse(raw);
      return Date.now() - t < CACHE_TTL_MS ? v : null;
    } catch {
      return null;
    }
  }

  function cacheSet(id, v) {
    try {
      sessionStorage.setItem(CACHE_PREFIX + id, JSON.stringify({ t: Date.now(), v }));
    } catch {
      // storage full or unavailable: the in-memory cache is enough
    }
  }

  function pump() {
    while (active < CONCURRENCY && queue.length) {
      const job = queue.shift();
      active++;
      job().finally(() => {
        active--;
        pump();
      });
    }
  }

  function enqueue(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => fn().then(resolve, reject));
      pump();
    });
  }

  function parseServices(j) {
    const total = j.total_amount; // item + buyer protection fee
    const services = j.services || {};
    const shipping = services.shipping;
    const fee = services.buyer_protection && services.buyer_protection.final_price;
    const ship = shipping && shipping.final_price;
    const currency = total.currency_code;
    const totalAmount = parseFloat(total.amount);
    const shipAmount = ship && ship.currency_code === currency ? parseFloat(ship.amount) : null;
    return {
      currency,
      total: totalAmount,
      fee: fee ? parseFloat(fee.amount) : null,
      shipping: shipAmount,
      pickupOnly: !!services.pickup_only || !!(shipping && shipping.pickup_only),
      real: shipAmount != null ? totalAmount + shipAmount : null,
    };
  }

  function getInfo(id) {
    if (memo.has(id)) return memo.get(id);
    const cached = cacheGet(id);
    const p = cached
      ? Promise.resolve(cached)
      : enqueue(async () => {
          const r = await fetch(`${API_BASE}/pricing/public/api/v1/items/${id}/services`, {
            credentials: 'include',
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const info = parseServices(await r.json());
          cacheSet(id, info);
          return info;
        });
    memo.set(id, p);
    // on failure, allow a retry on the next scan
    p.catch(() => memo.delete(id));
    return p;
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = '[data-vrp-hidden] { display: none !important; }';
    document.head.appendChild(s);
  }

  // The original nodes belong to React: rather than changing their text (which React
  // would overwrite or trip over), hide them and render a sibling with the same classes.
  function overlay(original, key, text) {
    let mine = original.nextElementSibling;
    if (!mine || !mine.hasAttribute('data-vrp-for')) {
      mine = document.createElement(original.tagName);
      mine.setAttribute('data-vrp-for', '');
      original.insertAdjacentElement('afterend', mine);
    }
    // only write on change: every DOM write re-triggers the MutationObserver
    if (mine.className !== original.className) mine.className = original.className;
    if (mine.dataset.vrpKey !== key) mine.dataset.vrpKey = key;
    if (mine.textContent !== text) mine.textContent = text;
    if (!original.hasAttribute('data-vrp-hidden')) original.setAttribute('data-vrp-hidden', '');
    return mine;
  }

  function removeOverlay(original) {
    if (!original.hasAttribute('data-vrp-hidden')) return;
    original.removeAttribute('data-vrp-hidden');
    const mine = original.nextElementSibling;
    if (mine && mine.hasAttribute('data-vrp-for')) mine.remove();
  }

  function hasOverlay(original, key) {
    const mine = original.nextElementSibling;
    return !!mine && mine.hasAttribute('data-vrp-for') && mine.dataset.vrpKey === key;
  }

  // ---------------------------------------------------------------------------
  // Prices
  // ---------------------------------------------------------------------------

  function tooltip(info) {
    const parts = [`${fmt(info.total - (info.fee || 0), info.currency)} ${T.item}`];
    if (info.fee != null) parts.push(`${fmt(info.fee, info.currency)} ${T.fee}`);
    if (info.shipping === 0) parts.push(T.freeShipping);
    else if (info.shipping != null) parts.push(`${fmt(info.shipping, info.currency)} ${T.shipping}`);
    return parts.join(' + ');
  }

  function applyPrice(priceEl, id, gridItem, isSidebar) {
    if (hasOverlay(priceEl, id)) return;
    const labelEl = priceEl.parentElement.querySelector(SEL.feeLabel);

    getInfo(id).then(
      (info) => {
        if (!priceEl.isConnected) return;
        let price, label;
        if (info.real != null) {
          price = info.real;
          label = isSidebar ? T.inclFeeShipping : T.inclShipping;
        } else if (info.pickupOnly) {
          price = info.total;
          label = T.pickupOnly;
        } else {
          return; // no shipping data: keep Vinted's price
        }
        overlay(priceEl, id, fmt(price, info.currency)).title = tooltip(info);
        if (labelEl) overlay(labelEl, id, label);
        if (gridItem) {
          gridItem.dataset.vrpReal = info.real != null ? String(info.real) : '';
          if (sortOn) scheduleSort();
        }
      },
      () => {
        // network error: Vinted's price stays, the next scan retries
      }
    );
  }

  function itemIdFor(priceEl, gridItem) {
    const breakdown = priceEl.closest(SEL.breakdown);
    const m = breakdown && ITEM_TESTID_RE.exec(breakdown.dataset.testid);
    if (m) return m[1];
    const link = gridItem && gridItem.querySelector('a[href*="/items/"]');
    const hm = link && ITEM_HREF_RE.exec(link.getAttribute('href'));
    return hm ? hm[1] : null;
  }

  function scanPrices() {
    const pageItem = ITEM_PAGE_RE.exec(location.pathname);
    for (const priceEl of document.querySelectorAll(SEL.price)) {
      if (priceEl.closest(SEL.sidebar)) {
        if (pageItem) applyPrice(priceEl, pageItem[1], null, true);
        continue;
      }
      const gridItem = priceEl.closest(SEL.gridItem);
      const id = itemIdFor(priceEl, gridItem);
      if (id) applyPrice(priceEl, id, gridItem, false);
    }
  }

  // ---------------------------------------------------------------------------
  // Sorting ("Sort by" → Real price)
  // ---------------------------------------------------------------------------

  // Off by default and not persisted: it stays on until another sort option is
  // picked or the page is reloaded. Only the cards already loaded are reordered.
  let sortOn = false;
  let sortTimer = null;

  function scheduleSort() {
    if (sortTimer) return;
    sortTimer = setTimeout(() => {
      sortTimer = null;
      applySort();
    }, 150);
  }

  // The grid is a flex container, so CSS `order` reorders cards without moving React's nodes.
  function applySort() {
    for (const gi of document.querySelectorAll(SEL.gridItem)) {
      if (!sortOn) {
        gi.style.removeProperty('order');
        continue;
      }
      const v = gi.dataset.vrpReal;
      gi.style.order = v ? String(Math.round(parseFloat(v) * 100)) : String(UNKNOWN_ORDER);
    }
  }

  function setSort(on) {
    sortOn = on;
    applySort();
    syncSortUi();
  }

  // Vinted's own "Selected"/"Not selected" labels, read from its radios so they're localised.
  const radioLabels = { on: null, off: null };

  function syncSortUi() {
    const text = document.querySelector(SEL.sortTriggerText);
    if (text) {
      if (sortOn) overlay(text, 'sort', T.sortChip);
      else removeOverlay(text);
    }

    const dropdown = document.querySelector(SEL.sortDropdown);
    if (!dropdown) return;
    for (const input of dropdown.querySelectorAll('input[type="radio"]')) {
      if (input.value === SORT_VALUE) input.checked = sortOn;
      else if (sortOn) input.checked = false;
      const label = input.checked ? radioLabels.on : radioLabels.off;
      if (label) input.setAttribute('aria-label', label);
    }
  }

  function closeDropdown() {
    const trigger = document.querySelector(SEL.sortTrigger);
    if (trigger && trigger.getAttribute('aria-expanded') === 'true') trigger.click();
  }

  function ensureSortOption() {
    const dropdown = document.querySelector(SEL.sortDropdown);
    if (!dropdown || dropdown.querySelector('[data-vrp-sort]')) return;
    const list = dropdown.querySelector('ul');
    const template = list && list.querySelector('li');
    if (!template) return;

    for (const input of dropdown.querySelectorAll('input[type="radio"]')) {
      radioLabels[input.checked ? 'on' : 'off'] = input.getAttribute('aria-label');
    }

    // A deep clone carries no React handlers: it's just markup with Vinted's styling.
    const li = template.cloneNode(true);
    li.setAttribute('data-vrp-sort', '');
    for (const el of li.querySelectorAll('[id]')) el.id = 'vrp-' + el.id;
    for (const el of li.querySelectorAll('[for]')) el.setAttribute('for', 'vrp-' + el.getAttribute('for'));
    for (const el of li.querySelectorAll('[data-testid]')) el.removeAttribute('data-testid');
    const title = li.querySelector('.web_ui__Cell__body .web_ui__Text__text');
    if (title) title.textContent = T.sortOption;
    const input = li.querySelector('input[type="radio"]');
    if (input) {
      input.value = SORT_VALUE;
      input.name = 'vrp_sort_by';
    }
    li.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setSort(true);
      closeDropdown();
    });
    list.appendChild(li);

    // picking one of Vinted's sort options turns ours off
    list.addEventListener(
      'click',
      (e) => {
        if (sortOn && !e.target.closest('[data-vrp-sort]')) setSort(false);
      },
      true
    );

    syncSortUi();
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  injectStyles();

  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scanPrices();
      ensureSortOption();
      if (sortOn) {
        syncSortUi();
        scheduleSort();
      }
    });
  }

  new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
  queueScan();
})();
