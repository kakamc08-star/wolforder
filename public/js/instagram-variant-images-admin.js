/* Image controls live only in the Instagram admin product editor. */
(() => {
  'use strict';
  const pending = new Set();
  let revision = 0;
  const grid = document.getElementById('instagramProductsGrid');

  function controls(line) {
    const box = line.querySelector('.variant-image-controls');
    const busy = pending.has(line.dataset.variantId);
    box.querySelectorAll('button, input').forEach((element) => { element.disabled = busy; });
    box.querySelector('[data-variant-image-action="delete"]').disabled = busy || box.dataset.hasImage !== 'true';
    box.querySelector('.variant-image-status').textContent = busy ? 'جاري حفظ الصورة...' : '';
  }

  function preview(line, url, hasImage = Boolean(url)) {
    const box = line.querySelector('.variant-image-controls');
    box.dataset.hasImage = String(hasImage);
    const image = box.querySelector('img');
    image.hidden = true;
    image.removeAttribute('src');
    image.onload = () => { image.hidden = false; };
    image.onerror = () => { image.hidden = true; };
    if (url) image.src = url;
    box.querySelector('[data-variant-image-action="upload"]').textContent = hasImage ? 'تغيير الصورة' : 'رفع صورة';
    controls(line);
  }

  async function refresh() {
    const currentRevision = ++revision;
    const lines = [...grid.querySelectorAll('.product-variant-line')];
    for (const line of lines) {
      if (!line.querySelector('.variant-image-controls')) {
        const box = document.createElement('div');
        box.className = 'variant-image-controls';
        box.innerHTML = '<img hidden alt="معاينة صورة اللون والمقاس" loading="lazy" referrerpolicy="no-referrer"><div class="variant-image-actions"><input class="variant-image-input" type="file" accept="image/jpeg,image/png,image/webp" hidden><button type="button" class="btn btn-secondary btn-sm" data-variant-image-action="upload">رفع صورة</button><button type="button" class="btn btn-danger btn-sm" data-variant-image-action="delete" disabled>حذف الصورة</button></div><small class="variant-image-status" role="status"></small>';
        line.append(box);
      }
      // Do not let an unknown preview state overwrite the previous image with a late response.
      line.querySelectorAll('[data-variant-image-action]').forEach((button) => { button.disabled = true; });
    }
    try {
      for (let start = 0; start < lines.length; start += 100) {
        const batch = lines.slice(start, start + 100);
        const data = await igApi('/api/instagram/variant-images/previews', {
          method: 'POST', body: { variantIds: batch.map((line) => line.dataset.variantId) }
        });
        if (revision !== currentRevision) return;
        const images = new Map((data.images || []).map((item) => [item.variantId, item.imageUrl]));
        for (const line of batch) {
          if (!pending.has(line.dataset.variantId)) preview(line, images.get(line.dataset.variantId), images.has(line.dataset.variantId));
        }
      }
    } catch (error) {
      if (revision === currentRevision) igNotify(error.message, 'error');
    } finally {
      if (revision === currentRevision) lines.filter((line) => line.isConnected).forEach(controls);
    }
  }

  async function change(line, file) {
    const id = line.dataset.variantId;
    if (pending.has(id)) return;
    if (file && file.size > 12 * 1024 * 1024) return igNotify('حجم الصورة يجب ألا يتجاوز 12 MB', 'error');
    pending.add(id);
    controls(line);
    try {
      const data = await igApi(`/api/instagram/variants/${encodeURIComponent(id)}/image`, file
        ? { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file }
        : { method: 'DELETE' });
      const current = [...grid.querySelectorAll('.product-variant-line')].find((item) => item.dataset.variantId === id);
      if (current) preview(current, data.imageUrl, Boolean(file));
      igNotify(file ? 'تم حفظ صورة اللون والمقاس' : 'تم حذف الصورة فقط');
      if (data.cleanupFailed) igNotify('تم حفظ التغيير، وستتم إعادة محاولة تنظيف الصورة السابقة تلقائياً.', 'error');
    } catch (error) {
      igNotify(error.message, 'error');
      // The response can fail after a successful commit; reload metadata instead of guessing.
      await refresh();
    } finally {
      pending.delete(id);
      const current = [...grid.querySelectorAll('.product-variant-line')].find((item) => item.dataset.variantId === id);
      if (current) controls(current);
    }
  }

  grid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-variant-image-action]');
    if (!button || button.disabled) return;
    const line = button.closest('.product-variant-line');
    if (button.dataset.variantImageAction === 'upload') {
      const input = line.querySelector('.variant-image-input');
      input.value = '';
      input.click();
    } else if (confirm('حذف صورة هذا اللون والمقاس فقط؟')) { void change(line); }
  });
  grid.addEventListener('change', (event) => {
    if (event.target.matches('.variant-image-input') && event.target.files?.[0]) {
      void change(event.target.closest('.product-variant-line'), event.target.files[0]);
    }
  });
  window.WolfOrderVariantImageAdmin = { refresh };
})();
