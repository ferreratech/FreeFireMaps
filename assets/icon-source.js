// "Ignis Sucks" icon: a flame inside a GPS/targeting reticle — find the fire.
const sharp = require('sharp');
const BG = '#0F1115';
const art = (scale) => `
<g transform="translate(512 512) scale(${scale}) translate(-512 -530)">
  <defs>
    <linearGradient id="fl" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FDBA74"/><stop offset="0.45" stop-color="#F97316"/><stop offset="1" stop-color="#DC2626"/>
    </linearGradient>
    <linearGradient id="core" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FEF9C3"/><stop offset="1" stop-color="#FACC15"/>
    </linearGradient>
  </defs>
  <!-- reticle -->
  <circle cx="512" cy="530" r="400" fill="none" stroke="#E5E7EB" stroke-width="34"/>
  <g stroke="#E5E7EB" stroke-width="34" stroke-linecap="round">
    <line x1="512" y1="86"  x2="512" y2="196"/>
    <line x1="512" y1="864" x2="512" y2="974"/>
    <line x1="68"  y1="530" x2="178" y2="530"/>
    <line x1="846" y1="530" x2="956" y2="530"/>
  </g>
  <!-- flame -->
  <path fill="url(#fl)" d="M512 210 C570 310 712 372 712 566 C712 700 620 776 512 776 C404 776 312 700 312 566 C312 474 372 434 396 356 C416 418 468 428 468 376 C468 316 500 262 512 210 Z"/>
  <path fill="url(#core)" d="M512 448 C548 500 604 526 604 616 C604 690 562 730 512 730 C462 730 420 690 420 616 C420 572 448 546 458 512 C468 552 494 556 494 522 C494 486 506 470 512 448 Z"/>
</g>`;
const svg = (bg, scale) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
${bg ? `<rect width="1024" height="1024" fill="${BG}"/>` : ''}${art(scale)}</svg>`;
(async () => {
  await sharp(Buffer.from(svg(true, 0.86))).png().toFile('icon.png');            // legacy / store icon
  await sharp(Buffer.from(svg(false, 0.70))).png().toFile('adaptive-icon.png');  // adaptive foreground (safe zone = centre 66%)
  await sharp(Buffer.from(svg(true, 0.86))).resize(256).png().toFile('preview.png');
  console.log('icons rendered');
})();
