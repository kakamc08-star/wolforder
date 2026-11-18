/* Optional customer product pictures. Never participates in order validation/submission. */
(() => {
  'use strict';
  const slug = encodeURIComponent(decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || ''));
  const cache = new Map();
  const states = new WeakMap();
  const activeRows = new Set();

  function remember(id, value) {
    cache.delete(id);
    cache.set(id, value);
    if (cache.size > 80) cache.delete(cache.keys().next().value);
  }

  function clear(state) {
    state.controller?.abort();
    clearTimeout(state.timeout);
    if (state.image) {
      state.image.onload = state.image.onerror = null;
      state.image.removeAttribute('src');
    }
    state.pane.replaceChildren();
    state.pane.hidden = true;
    state.pane.removeAttribute('aria-busy');
    state.image = null;
  }

  function update(row, variant, productName = '') {
    let state = states.get(row);
    if (!state) {
      const pane = document.createElement('div');
      pane.className = 'storefront-variant-image';
      pane.hidden = true;
      row.querySelector('.storefront-item-grid').after(pane);
      state = { pane, id: '', generation: 0 };
      states.set(row, state);
      activeRows.add(row);
    }
    const id = variant?.variant_id || '';
    if (state.id === id) return;
    state.id = id;
    const generation = ++state.generation;
    clear(state); // Remove the old image synchronously before fetching the new selection.
    if (!id) return;
    const current = () => row.isConnected && state.generation === generation;
    const fail = () => {
      if (!current()) return;
      cache.delete(id);
      clear(state);
    };
    const spinner = document.createElement('span');
    spinner.className = 'storefront-image-loading';
    spinner.setAttribute('role', 'status');
    spinner.textContent = 'جاري تحميل الصورة...';
    state.pane.append(spinner);
    state.pane.hidden = false;
    state.pane.setAttribute('aria-busy', 'true');
    state.controller = new AbortController();
    state.timeout = setTimeout(fail, 20000);

    void (async () => {
      try {
        let entry = cache.get(id);
        if (!entry || entry.expiresAt <= Date.now()) {
          const response = await fetch(`/api/instagram/storefront/${slug}/variants/${encodeURIComponent(id)}/image`, {
            cache: 'no-store', signal: state.controller.signal
          });
          if (!response.ok) throw new Error('Image unavailable');
          const data = await response.json();
          entry = { url: data.imageUrl || null, expiresAt: Date.now() + (data.imageUrl ? 240000 : 15000) };
          if (!current()) return;
          remember(id, entry);
        }
        if (!current()) return;
        if (!entry.url) { clear(state); return; }
        // Each request owns a separate image node. Late load/error events cannot reveal an old picture.
        const image = new Image();
        state.image = image;
        image.alt = [productName, variant.color, variant.size].filter(Boolean).join(' - ');
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';
        image.onload = () => {
          if (!current()) return;
          clearTimeout(state.timeout);
          state.pane.replaceChildren(image);
          state.pane.removeAttribute('aria-busy');
        };
        image.onerror = fail;
        image.src = entry.url;
      } catch (_error) { if (current()) clear(state); }
    })();
  }

  function dispose(row) {
    const state = states.get(row);
    if (state) { ++state.generation; clear(state); states.delete(row); }
    activeRows.delete(row);
  }

  function invalidate() {
    cache.clear();
    activeRows.forEach((row) => {
      if (!row.isConnected) return dispose(row);
      const state = states.get(row);
      ++state.generation;
      state.id = ''; // The order page calls update again with its current validated selection.
      clear(state);
    });
  }

  window.WolfOrderVariantImages = { update, dispose, invalidate };
})();
