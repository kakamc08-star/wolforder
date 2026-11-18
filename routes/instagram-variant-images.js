'use strict';

const express = require('express');
const sharp = require('sharp');
const { randomUUID } = require('node:crypto');
const BUCKET = 'instagram-variant-images';
const URL_SECONDS = 300;
const MAX_UPLOAD = 12 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const missingMigration = (error) => ['PGRST202', 'PGRST205', '42P01', '42883'].includes(error?.code);
const cleanupRunning = new WeakSet();

async function optimizeVariantImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_UPLOAD) throw new Error('Invalid image');
  const image = sharp(bytes, { limitInputPixels: 60000000, failOn: 'warning' });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1) {
    throw new Error('Unsupported image');
  }
  const output = await image.rotate().resize({
    width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true
  }).webp({ quality: 82, effort: 4 }).toBuffer();
  if (output.length > 3 * 1024 * 1024) throw new Error('Optimized image too large');
  return output;
}

async function cleanupVariantImages(supabase) {
  if (cleanupRunning.has(supabase)) return true;
  cleanupRunning.add(supabase);
  try {
    const { data, error } = await supabase.rpc('get_instagram_variant_image_cleanup_batch');
    if (missingMigration(error)) return true; // Old installations continue working until SQL is applied.
    if (error) throw error;
    const paths = (data || []).map((row) => row.object_path);
    if (!paths.length) return true;
    const removed = await supabase.storage.from(BUCKET).remove(paths);
    if (removed.error) throw removed.error;
    const completed = await supabase.rpc('complete_instagram_variant_image_cleanup', { p_paths: paths });
    if (completed.error) throw completed.error;
    return true;
  } catch (error) {
    console.error('Variant image cleanup will retry:', error.message);
    return false;
  } finally {
    cleanupRunning.delete(supabase);
  }
}

function startVariantImageCleanup(supabase) {
  void cleanupVariantImages(supabase);
  const timer = setInterval(() => void cleanupVariantImages(supabase), 60000);
  timer.unref();
  return () => clearInterval(timer);
}

async function signImage(supabase, path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, URL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}

function mutationError(res, error) {
  console.error('Variant image mutation failed:', error.message);
  if (missingMigration(error)) return res.status(503).json({ message: 'شغّل ملف SQL الخاص بصور الأصناف أولاً' });
  if (error.code === '42501') return res.status(403).json({ message: 'تعديل صور الأصناف متاح للمدير فقط' });
  if (error.code === 'P0002') return res.status(404).json({ message: 'اللون والمقاس غير موجودين' });
  return res.status(500).json({ message: 'تعذر حفظ الصورة. حدّث الأصناف للتحقق ثم أعد المحاولة.' });
}

function createVariantImageRoutes({ supabase, requireRole, broadcastInstagramUpdate }) {
  const publicRouter = express.Router();
  const adminRouter = express.Router();

  publicRouter.get('/storefront/:slug/variants/:variantId/image', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!UUID.test(req.params.variantId)) return res.status(400).json({ imageUrl: null });
    try {
      const { data: path, error } = await supabase.rpc('get_instagram_variant_image_path', {
        p_slug: req.params.slug, p_variant_id: req.params.variantId.toLowerCase()
      });
      if (missingMigration(error)) return res.json({ imageUrl: null });
      if (error) throw error;
      if (!path) return res.json({ imageUrl: null });
      return res.json({ imageUrl: await signImage(supabase, path), expiresIn: URL_SECONDS });
    } catch (error) {
      console.error('Variant image read failed:', error.message);
      return res.status(503).json({ imageUrl: null });
    }
  });

  adminRouter.post('/variant-images/previews', requireRole('admin'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const ids = req.body.variantIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => !UUID.test(id))) {
      return res.status(400).json({ message: 'معرفات الألوان والمقاسات غير صالحة' });
    }
    try {
      const { data: rows, error } = await supabase.from('instagram_variant_images')
        .select('variant_id, object_path').in('variant_id', ids);
      if (missingMigration(error)) return res.json({ images: [] });
      if (error) throw error;
      if (!rows?.length) return res.json({ images: [] });
      const { data: signed, error: signError } = await supabase.storage.from(BUCKET)
        .createSignedUrls(rows.map((row) => row.object_path), URL_SECONDS);
      if (signError) throw signError;
      const urls = new Map((signed || []).map((entry) => [entry.path, entry.signedUrl]));
      return res.json({ images: rows.map((row) => ({
        variantId: row.variant_id, imageUrl: urls.get(row.object_path) || null
      })) });
    } catch (error) {
      console.error('Variant image previews failed:', error.message);
      return res.status(503).json({ message: 'تعذر تحميل معاينات صور الأصناف' });
    }
  });

  const parseImage = express.raw({ type: ['application/octet-stream', 'image/*'], limit: MAX_UPLOAD, inflate: false });
  adminRouter.put('/variants/:id/image', requireRole('admin'), parseImage, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!UUID.test(req.params.id)) return res.status(400).json({ message: 'معرف اللون والمقاس غير صالح' });
    let bytes;
    try { bytes = await optimizeVariantImage(req.body); }
    catch (_error) { return res.status(415).json({ message: 'اختر صورة سليمة بصيغة JPG أو PNG أو WebP (حتى 12 MB و60 مليون بكسل)' }); }
    const variantId = req.params.id.toLowerCase();
    const path = `${variantId}/${randomUUID()}.webp`;
    try {
      const prepared = await supabase.rpc('prepare_instagram_variant_image_upload', {
        p_variant_id: variantId, p_actor_user_id: req.user.id, p_object_path: path
      });
      if (prepared.error) return mutationError(res, prepared.error);
      const uploaded = await supabase.storage.from(BUCKET).upload(path, bytes, {
        contentType: 'image/webp', cacheControl: '300', upsert: false
      });
      if (uploaded.error) return res.status(502).json({ message: 'تعذر رفع الصورة إلى التخزين. الصورة السابقة محفوظة.' });
      const saved = await supabase.rpc('set_instagram_variant_image_path', {
        p_variant_id: variantId, p_actor_user_id: req.user.id, p_object_path: path
      });
      // An ambiguous network error can follow a committed transaction. The durable outbox
      // decides what to delete; never delete the uploaded object merely because RPC failed.
      if (saved.error) return mutationError(res, saved.error);
      broadcastInstagramUpdate(req, 'INSTAGRAM_VARIANT_IMAGE_UPDATED');
      const cleanupFailed = !await cleanupVariantImages(supabase);
      const imageUrl = await signImage(supabase, path).catch(() => null);
      return res.json({ imageUrl, cleanupFailed });
    } catch (error) { return mutationError(res, error); }
  }, (error, _req, res, _next) => {
    return res.status(error.type === 'entity.too.large' ? 413 : 400).json({
      message: error.type === 'entity.too.large' ? 'حجم الصورة يجب ألا يتجاوز 12 MB' : 'تعذر قراءة ملف الصورة'
    });
  });

  adminRouter.delete('/variants/:id/image', requireRole('admin'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!UUID.test(req.params.id)) return res.status(400).json({ message: 'معرف اللون والمقاس غير صالح' });
    try {
      const { error } = await supabase.rpc('set_instagram_variant_image_path', {
        p_variant_id: req.params.id.toLowerCase(), p_actor_user_id: req.user.id, p_object_path: null
      });
      if (error) return mutationError(res, error);
      broadcastInstagramUpdate(req, 'INSTAGRAM_VARIANT_IMAGE_UPDATED');
      return res.json({ imageUrl: null, cleanupFailed: !await cleanupVariantImages(supabase) });
    } catch (error) { return mutationError(res, error); }
  });
  return { publicRouter, adminRouter };
}

module.exports = { createVariantImageRoutes, optimizeVariantImage, cleanupVariantImages, startVariantImageCleanup };
