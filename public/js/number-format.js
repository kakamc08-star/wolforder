(function initializeNumbers(root) {
  'use strict';

  function toEnglish(value) {
    return String(value ?? '')
      .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 1632))
      .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 1776))
      .replace(/٫/g, '.')
      .replace(/٬/g, '');
  }

  if (typeof module === 'object' && module.exports) module.exports = { toEnglish };
  if (!root.document) return;

  const document = root.document;
  const seen = new WeakSet();
  const digitPattern = /[٠-٩۰-۹٫٬]/;
  const fieldSelector = 'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="password"]), textarea';
  let fieldsScheduled = false;

  function protectedField(field) {
    return field.closest('[data-preserve-digits]')
      || field.type === 'password'
      || /username|password|token/i.test(field.id + ' ' + field.name);
  }

  function validateNumber(field) {
    field.setCustomValidity('');
    if (!field.value.trim()) return;
    const value = Number(field.value);
    const minText = field.getAttribute('min');
    const maxText = field.getAttribute('max');
    if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(field.value.trim()) || !Number.isFinite(value)) {
      field.setCustomValidity('أدخل رقماً صالحاً');
    } else if (minText !== null && value < Number(minText)) {
      field.setCustomValidity('الحد الأدنى ' + toEnglish(minText));
    } else if (maxText !== null && value > Number(maxText)) {
      field.setCustomValidity('الحد الأعلى ' + toEnglish(maxText));
    } else if (field.getAttribute('step') !== 'any') {
      const step = Number(field.getAttribute('step') || 1);
      const steps = (value - Number(minText || 0)) / (step > 0 ? step : 1);
      if (Math.abs(steps - Math.round(steps)) > 1e-7) {
        field.setCustomValidity('أدخل كمية أو قيمة توافق الخطوة المحددة');
      }
    }
  }

  function normalizeField(field) {
    if (protectedField(field)) return;
    if (['date', 'time', 'datetime-local', 'month', 'week'].includes(field.type)) field.lang = 'en-GB';
    if (field.type === 'number') {
      const original = field.getAttribute('value') || '';
      const value = field.value || (digitPattern.test(original) ? original : '');
      field.type = 'text';
      field.dataset.wolfNumber = 'true';
      field.inputMode = field.getAttribute('step') === 'any' || Number(field.getAttribute('step')) % 1
        ? 'decimal' : 'numeric';
      field.value = toEnglish(value);
    }
    if (!field.matches('textarea, input[type="text"], input[type="tel"], input[type="search"], input[type="url"]')) return;
    const value = field.value;
    const normalize = (text) => field.dataset.wolfNumber ? toEnglish(text).replace(/,/g, '') : toEnglish(text);
    const normalized = normalize(value);
    if (normalized !== value) {
      const start = field.selectionStart;
      const end = field.selectionEnd;
      field.value = normalized;
      if (document.activeElement === field && start !== null) {
        field.setSelectionRange(normalize(value.slice(0, start)).length, normalize(value.slice(0, end)).length);
      }
    }
    if (field.dataset.wolfNumber) validateNumber(field);
  }

  function normalizeNode(node) {
    if (node.nodeType === 3) {
      if (node.parentElement?.closest('script, style, code, pre, [data-preserve-digits]')) return;
      if (digitPattern.test(node.data)) node.data = toEnglish(node.data);
      return;
    }
    if (node.nodeType !== 1 || seen.has(node)) return;
    if (node.matches('script, style, code, pre, [data-preserve-digits]')) return;
    seen.add(node);
    if (node.matches('input, textarea')) normalizeField(node);
    if (node.matches('a[href^="tel:"]')) {
      const href = node.getAttribute('href');
      if (digitPattern.test(href)) node.setAttribute('href', toEnglish(href));
    }
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      const value = node.getAttribute(attribute);
      if (value && digitPattern.test(value)) node.setAttribute(attribute, toEnglish(value));
    }
    node.childNodes.forEach(normalizeNode);
  }

  function refreshFields() {
    fieldsScheduled = false;
    document.querySelectorAll(fieldSelector).forEach(normalizeField);
  }

  function scheduleFields() {
    if (fieldsScheduled) return;
    fieldsScheduled = true;
    root.requestAnimationFrame(refreshFields);
  }

  function start() {
    normalizeNode(document.body);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') normalizeNode(record.target);
        else if (record.type === 'childList') record.addedNodes.forEach(normalizeNode);
        else if (record.target.matches('input, textarea')) normalizeField(record.target);
        else if (record.attributeName === 'href' && record.target.matches('a[href^="tel:"]')) {
          const value = record.target.getAttribute('href');
          if (digitPattern.test(value)) record.target.setAttribute('href', toEnglish(value));
        }
      }
      scheduleFields();
    });
    observer.observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['value', 'hidden', 'style', 'href']
    });
  }

  document.addEventListener('input', (event) => {
    if (event.target.matches('input, textarea')) normalizeField(event.target);
  }, true);
  document.addEventListener('focusin', (event) => {
    if (event.target.matches('input, textarea')) normalizeField(event.target);
  });
  document.addEventListener('reset', () => root.setTimeout(refreshFields, 0), true);
  root.WolfNumbers = { toEnglish, refresh: refreshFields };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof window === 'undefined' ? globalThis : window);
