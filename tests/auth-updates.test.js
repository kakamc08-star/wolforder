'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PGlite } = require('@electric-sql/pglite');
const db = new PGlite();
const ids = Object.fromEntries(['admin', 'company', 'driver', 'instagram_viewer'].map((role, i) => [role, `10000000-0000-4000-8000-00000000000${i + 1}`]));
process.env.JWT_SECRET = 'local-test-only-secret';
const originalPassword = 'original-١٢٣';
let hash, server, origin;
const row = async (sql, values = []) => (await db.query(sql, values)).rows[0];
async function attempt(id, expected, success) {
  return (await row('select public.record_wolforder_login_attempt($1,$2,$3) as result', [id, expected, success])).result;
}
class Query {
  constructor() { this.filters = []; this.fields = '*'; this.singleResult = false; }
  select(fields) { this.fields = fields; return this; }
  eq(key, value) { this.filters.push([key, [value]]); return this; }
  in(key, values) { this.filters.push([key, values]); return this; }
  order() { return this; }
  update(patch) { this.patch = patch; return this; }
  maybeSingle() { this.singleResult = true; return this; }
  single() { this.singleResult = true; return this; }
  async execute() {
    let users = (await db.query('select * from users')).rows;
    users = users.filter(user => this.filters.every(([key, values]) => values.includes(user[key])));
    if (this.patch) for (const user of users) {
      assert.deepEqual(Object.keys(this.patch), ['password']);
      await db.query('update users set password=$1 where id=$2', [this.patch.password, user.id]);
      user.password = this.patch.password;
    }
    const result = [];
    for (const user of users) {
      const fields = this.fields.split(',').map(field => field.trim());
      const selected = Object.fromEntries(Object.entries(user).filter(([key]) => fields.includes(key) || this.fields === '*'));
      if (this.fields.includes('login_state:')) selected.login_state = (await db.query('select failed_attempts,locked_until from wolforder_login_attempts where user_id=$1', [user.id])).rows;
      result.push(selected);
    }
    return { data: this.singleResult ? result[0] || null : result, error: null };
  }
  then(resolve, reject) { return this.execute().then(resolve, reject); }
}
const dbPath = require.resolve('../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  from(table) { assert.equal(table, 'users'); return new Query(); },
  async rpc(name, args) {
    assert.equal(name, 'record_wolforder_login_attempt');
    return { data: await attempt(args.p_user_id, args.p_expected_password_hash, args.p_success), error: null };
  }
} };
const router = require('../routes/auth');
test.before(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table users(id uuid primary key, username text unique, password text, role text, name text, phone text);
    create table instagram_company_links(company_id uuid references users(id), slug text, is_active boolean);
    create schema storage; create table storage.objects(bucket_id text);`);
  hash = await bcrypt.hash(originalPassword, 4);
  for (const [role, id] of Object.entries(ids)) await db.query('insert into users values($1,$2,$3,$2,$2,$4)', [id, role, hash, '0987654321']);
  const migration = fs.readFileSync(path.join(__dirname, '../database/2026-11-13-all-requested-updates.sql'), 'utf8');
  await db.exec(migration);
  await db.query('insert into instagram_company_links values($1,$2,true)', [ids.company, 'company-link']);
  const objectPath = `${ids.company}/20000000-0000-4000-8000-000000000001.jpg`;
  await db.query('insert into instagram_storefront_images values($1,$2)', [ids.company, objectPath]);
  await db.exec(migration);
  assert.equal((await row('select count(*) as count from instagram_storefront_images')).count, 1);
  assert.equal((await row('select get_instagram_storefront_image_path($1) as path', ['company-link'])).path, objectPath);
  const app = express(); app.use(express.json()); app.use(require('../middleware/numbers')); app.use('/api/auth', router);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}/api/auth`;
});
test.beforeEach(async () => {
  await db.exec('delete from wolforder_login_attempts');
  for (const [role, id] of Object.entries(ids)) await db.query('update users set password=$1,role=$2 where id=$3', [hash, role, id]);
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await db.close(); });
const tokenFor = role => jwt.sign({ id: ids[role], role }, process.env.JWT_SECRET, { expiresIn: '7d' });
async function api(route, method = 'POST', body, token) {
  const response = await fetch(origin + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}
const login = (role, password = originalPassword) => api('/login', 'POST', { username: role, password });

test('all login roles retain bcrypt credentials and seven-day JWT sessions', async () => {
  for (const role of Object.keys(ids)) {
    const result = await login(role); assert.equal(result.status, 200);
    const claims = jwt.verify(result.data.token, process.env.JWT_SECRET);
    assert.equal(claims.role, role); assert.equal(claims.exp - claims.iat, 7 * 86400);
    assert.equal(result.data.user.password, undefined);
  }
});
test('third failure locks only that account, remains server-enforced, and preserves existing sessions', async () => {
  const active = (await login('driver')).data.token;
  assert.equal((await login('driver', 'wrong')).status, 400);
  assert.equal((await login('driver', 'wrong')).status, 400);
  const third = await login('driver', 'wrong'); assert.equal(third.status, 429);
  assert.equal(third.data.code, 'LOGIN_LOCKED'); assert.equal(third.data.retryAfterSeconds, 300);
  assert.equal(third.headers.get('retry-after'), '300');
  const again = await login('driver'); assert.equal(again.status, 429);
  assert.equal(again.data.lockedUntil, third.data.lockedUntil);
  assert.equal((await login('company')).status, 200);
  assert.equal((await api('/me', 'GET', undefined, active)).status, 200);
  assert.equal((await row('select failed_attempts from wolforder_login_attempts where user_id=$1', [ids.driver])).failed_attempts, 3);
});
test('success resets failures and an expired lock permits a fresh attempt', async () => {
  await login('company', 'wrong'); await login('company', 'wrong');
  assert.equal((await login('company')).status, 200);
  assert.equal((await login('company', 'wrong')).status, 400);
  assert.equal((await row('select failed_attempts from wolforder_login_attempts where user_id=$1', [ids.company])).failed_attempts, 1);
  await login('company', 'wrong'); await login('company', 'wrong');
  await db.query("update wolforder_login_attempts set locked_until=now()-interval '1 second' where user_id=$1", [ids.company]);
  assert.equal((await login('company')).status, 200);
  assert.equal((await row('select failed_attempts from wolforder_login_attempts where user_id=$1', [ids.company])).failed_attempts, 0);
});
test('simultaneous failures are capped at three without extending the lock', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => login('company', 'wrong')));
  assert.equal(results.filter(result => result.status === 400).length, 2);
  assert.equal(results.filter(result => result.status === 429).length, 4);
  assert.equal(new Set(results.filter(result => result.status === 429).map(result => result.data.lockedUntil)).size, 1);
});
test('stale bcrypt verification cannot log in or count failures after password replacement', async () => {
  await db.query('update users set password=$1 where id=$2', ['different-hash', ids.driver]);
  assert.equal((await attempt(ids.driver, hash, true)).credentials_changed, true);
  assert.equal((await attempt(ids.driver, hash, false)).credentials_changed, true);
  assert.equal((await row('select count(*) as count from wolforder_login_attempts')).count, 0);
});
test('password management excludes hashes and rejects missing or non-admin sessions', async () => {
  assert.equal((await api('/password-accounts', 'GET')).status, 401);
  for (const role of ['company', 'driver', 'instagram_viewer']) assert.equal((await api('/password-accounts', 'GET', undefined, tokenFor(role))).status, 403);
  const accounts = await api('/password-accounts', 'GET', undefined, tokenFor('admin'));
  assert.equal(accounts.status, 200); assert.equal(accounts.data.length, 3);
  for (const account of accounts.data) assert.deepEqual(Object.keys(account).sort(), ['id', 'name', 'role', 'username']);
  await db.query("update users set role='company' where id=$1", [ids.admin]);
  assert.equal((await api('/password-accounts', 'GET', undefined, tokenFor('admin'))).status, 403);
});
test('admin changes only the selected password, including admin accounts, without altering sessions or other data', async () => {
  for (const role of ['driver', 'company', 'admin']) {
    const before = await row('select * from users where id=$1', [ids[role]]);
    const password = 'new-١٢٣-password';
    const response = await api(`/users/${ids[role]}/password`, 'PATCH', { newPassword: password, confirmPassword: password }, tokenFor('admin'));
    assert.equal(response.status, 200);
    const after = await row('select * from users where id=$1', [ids[role]]);
    assert.notEqual(after.password, password); assert.equal(await bcrypt.compare(password, after.password), true);
    assert.deepEqual({ ...after, password: before.password }, before);
    assert.equal((await login(role, password)).status, 200);
    assert.equal((await login(role, originalPassword)).status, 400);
  }
});
test('invalid, mismatched and overlong passwords do not write, and viewer accounts cannot be reset here', async () => {
  const route = `/users/${ids.driver}/password`;
  for (const body of [{ newPassword: 'short', confirmPassword: 'short' }, { newPassword: 'long-enough', confirmPassword: 'different' }, { newPassword: 'ش'.repeat(37), confirmPassword: 'ش'.repeat(37) }]) {
    assert.equal((await api(route, 'PATCH', body, tokenFor('admin'))).status, 400);
  }
  assert.equal((await row('select password from users where id=$1', [ids.driver])).password, hash);
  assert.equal((await api(route, 'PATCH', { newPassword: 'changed', confirmPassword: 'changed' }, tokenFor('company'))).status, 403);
  assert.equal((await api(`/users/${ids.instagram_viewer}/password`, 'PATCH', { newPassword: 'changed', confirmPassword: 'changed' }, tokenFor('admin'))).status, 404);
});
test('browser database roles cannot bypass lock accounting or read the new protected tables', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec('set role ' + role);
    try {
      await assert.rejects(attempt(ids.driver, hash, true), /permission denied/);
      await assert.rejects(db.query('select * from wolforder_login_attempts'), /permission denied/);
      await assert.rejects(db.query('select * from instagram_storefront_images'), /permission denied/);
    } finally { await db.exec('reset role'); }
  }
});
