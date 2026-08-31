(function createDriverOfflineStore() {
  const DB_NAME = 'wolforder-driver-offline';
  const DB_VERSION = 1;
  const SNAPSHOTS_STORE = 'snapshots';
  const PENDING_STORE = 'pendingUpdates';
  let databasePromise = null;

  function openDatabase() {
    if (databasePromise) return databasePromise;

    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;

        if (!database.objectStoreNames.contains(SNAPSHOTS_STORE)) {
          database.createObjectStore(SNAPSHOTS_STORE, { keyPath: 'scope' });
        }

        if (!database.objectStoreNames.contains(PENDING_STORE)) {
          const store = database.createObjectStore(PENDING_STORE, { keyPath: 'key' });
          store.createIndex('scope', 'scope', { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('تعذر فتح التخزين المحلي'));
      request.onblocked = () => reject(new Error('التخزين المحلي محجوب مؤقتاً'));
    });

    return databasePromise;
  }

  function waitForTransaction(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('فشل التخزين المحلي'));
      transaction.onabort = () => reject(transaction.error || new Error('أُلغي التخزين المحلي'));
    });
  }

  function waitForRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('فشلت قراءة التخزين المحلي'));
    });
  }

  async function saveSnapshot(scope, orders) {
    const database = await openDatabase();
    const transaction = database.transaction(SNAPSHOTS_STORE, 'readwrite');
    const completion = waitForTransaction(transaction);
    transaction.objectStore(SNAPSHOTS_STORE).put({
      scope,
      orders,
      updatedAt: new Date().toISOString()
    });
    await completion;
  }

  async function getSnapshot(scope) {
    const database = await openDatabase();
    const transaction = database.transaction(SNAPSHOTS_STORE, 'readonly');
    return waitForRequest(transaction.objectStore(SNAPSHOTS_STORE).get(scope));
  }

  async function queueUpdate(scope, update) {
    const database = await openDatabase();
    const transaction = database.transaction(PENDING_STORE, 'readwrite');
    const completion = waitForTransaction(transaction);
    const orderId = String(update.orderId);
    const orderSource = update.orderSource === 'instagram' ? 'instagram' : 'basic';

    transaction.objectStore(PENDING_STORE).put({
      key: `${scope}:${orderSource}:${orderId}`,
      scope,
      orderId,
      orderSource,
      status: update.status,
      note: update.note,
      queuedAt: new Date().toISOString()
    });

    await completion;
  }

  async function getPendingUpdates(scope) {
    const database = await openDatabase();
    const transaction = database.transaction(PENDING_STORE, 'readonly');
    const store = transaction.objectStore(PENDING_STORE);
    const results = await waitForRequest(store.index('scope').getAll(scope));
    return results.sort((first, second) => first.queuedAt.localeCompare(second.queuedAt));
  }

  async function removePendingUpdate(key) {
    const database = await openDatabase();
    const transaction = database.transaction(PENDING_STORE, 'readwrite');
    const completion = waitForTransaction(transaction);
    transaction.objectStore(PENDING_STORE).delete(key);
    await completion;
  }

  async function clearScope(scope) {
    const database = await openDatabase();
    const transaction = database.transaction([SNAPSHOTS_STORE, PENDING_STORE], 'readwrite');
    const completion = waitForTransaction(transaction);
    transaction.objectStore(SNAPSHOTS_STORE).delete(scope);

    const pendingStore = transaction.objectStore(PENDING_STORE);
    const cursorRequest = pendingStore.index('scope').openKeyCursor(IDBKeyRange.only(scope));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      pendingStore.delete(cursor.primaryKey);
      cursor.continue();
    };

    await completion;
  }

  window.DriverOfflineStore = {
    saveSnapshot,
    getSnapshot,
    queueUpdate,
    getPendingUpdates,
    removePendingUpdate,
    clearScope
  };
})();
