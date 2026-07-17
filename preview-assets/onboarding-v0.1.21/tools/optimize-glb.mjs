/* =========================================================
   optimize-glb.mjs — reproducible local GLB crusher

   Turns the raw, uncompressed source Chiefmonkey GLB into the
   production onboarding asset:

     - dedup + prune unused
     - DROP forbidden locomotion / knock-down clips (walk/run/jog/
       sprint/knockdown/fall-down), using the SAME semantic filter the
       runtime uses (imported from ../onboarding-client.js) so the built
       asset and the runtime pools can never disagree
     - weld vertices, resample redundant keyframes
     - WebP texture conversion (self-hosted, browser-native — no runtime
       decoder dependency), resize oversized maps
     - Draco mesh compression (matches the self-hosted DRACOLoader the
       preview already ships — no third-party CDN)

   No third-party runtime CDN dependency is introduced: Draco decoding is
   done by the vendored wasm decoder under three-libs/draco/, WebP by the
   browser itself.

   Usage:
     node tools/optimize-glb.mjs <source.glb> [out.glb]

   Emits <out.glb> plus <out>.manifest.json (sizes, %reduction, sha256,
   retained + dropped clip inventory with durations). Deterministic:
   re-running on the same input yields byte-identical output + sha.
   ========================================================= */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, resample, textureCompress,
} from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { isForbiddenClip } from '../onboarding-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const srcPath = process.argv[2];
if (!srcPath) {
  console.error('usage: node tools/optimize-glb.mjs <source.glb> [out.glb]');
  process.exit(1);
}
const outPath = process.argv[3] || join(__dirname, '..', 'assets', 'chiefmonkey-onboarding.glb');

function clipDuration(anim) {
  let dur = 0;
  for (const ch of anim.listChannels()) {
    const input = ch.getSampler()?.getInput();
    const arr = input?.getArray();
    if (arr && arr.length) dur = Math.max(dur, arr[arr.length - 1]);
  }
  return dur;
}

function inventory(root) {
  return root.listAnimations()
    .map((a) => ({ name: a.getName(), duration: Number(clipDuration(a).toFixed(3)) }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

async function main() {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });

  const doc = await io.read(srcPath);
  const root = doc.getRoot();

  const before = inventory(root);

  // ── Drop forbidden clips (single source of truth: runtime filter) ──
  const dropped = [];
  for (const anim of root.listAnimations()) {
    if (isForbiddenClip(anim.getName())) {
      dropped.push({ name: anim.getName(), duration: Number(clipDuration(anim).toFixed(3)) });
      anim.dispose();
    }
  }

  // ── Clean + shrink ──
  await doc.transform(
    dedup(),
    weld(),
    resample(),
    // Convert every texture to WebP (browser-native; no runtime decoder).
    // Cap at 1024² — matches the previous shipped asset and is ample for a
    // hero character. Larger maps are downscaled; smaller are left alone.
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      quality: 82,
      resize: [1024, 1024],
    }),
    // Second dedup: the source ships baseColor + emissive as two near-identical
    // PNGs that only become byte-identical AFTER WebP re-encode, so this pass
    // merges them into a single shared texture (the first dedup, pre-compress,
    // could not).
    dedup(),
    // prune AFTER texture work so a now-unused (e.g. zero-factor emissive)
    // texture is removed rather than re-encoded.
    prune({ keepAttributes: false, keepLeaves: false }),
  );

  // ── Draco mesh compression (edgebreaker, fidelity-safe quantization) ──
  // Higher position/normal bits keep the skinned silhouette crisp; joints are
  // kept lossless-ish so skin weights don't drift.
  doc.createExtension(KHRDracoMeshCompression)
    .setRequired(true)
    .setEncoderOptions({
      method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
      encodeSpeed: 5,
      decodeSpeed: 5,
      quantizationBits: {
        POSITION: 14,
        NORMAL: 10,
        TEXCOORD_0: 12,
        JOINTS_0: 0,
        WEIGHTS_0: 8,
      },
    });

  await io.write(outPath, doc);

  // ── Report ──
  const outDoc = await io.read(outPath);
  const after = inventory(outDoc.getRoot());
  const srcBytes = statSync(srcPath).size;
  const outBytes = statSync(outPath).size;
  const sha256 = createHash('sha256').update(readFileSync(outPath)).digest('hex');

  const manifest = {
    asset: 'chiefmonkey-onboarding.glb',
    generated_from: srcPath.split('/').pop(),
    source_sha256: createHash('sha256').update(readFileSync(srcPath)).digest('hex'),
    sha256,
    bytes_original: srcBytes,
    bytes_optimized: outBytes,
    reduction_pct: Number((100 * (1 - outBytes / srcBytes)).toFixed(2)),
    pipeline: ['dedup', 'weld', 'resample', 'textureCompress(webp,q82,<=1024)', 'prune', 'draco(edgebreaker)'],
    meshes: outDoc.getRoot().listMeshes().length,
    skins: outDoc.getRoot().listSkins().length,
    skin_joints: outDoc.getRoot().listSkins()[0]?.listJoints().length ?? 0,
    materials: outDoc.getRoot().listMaterials().length,
    textures: outDoc.getRoot().listTextures().length,
    animations_retained: after,
    animations_dropped_forbidden: dropped.sort((a, b) => a.name.localeCompare(b.name)),
  };
  writeFileSync(outPath + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n');

  console.log('=== optimize-glb ===');
  console.log('source   :', srcPath, `(${srcBytes} bytes)`);
  console.log('optimized:', outPath, `(${outBytes} bytes)`);
  console.log('reduction:', manifest.reduction_pct + '%');
  console.log('sha256   :', sha256);
  console.log('clips in :', before.length, '→ retained', after.length, ', dropped(forbidden)', dropped.length);
  console.log('dropped  :', dropped.map((d) => d.name).join(', ') || '(none)');
  console.log('textures :', manifest.textures, '| skins', manifest.skins, '| joints', manifest.skin_joints);
}

main().catch((e) => { console.error(e); process.exit(1); });
