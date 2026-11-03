# Signature Extractor

Two small tools that run entirely in your browser. Photos are never uploaded anywhere, and there is no account.

- **Extract signature** turns a photo of your handwritten signature into a transparent PNG.
- **Restore photo** cleans up an old or low-quality photo: faded colour, dust, scratches, noise and softness, with optional 2× or 4× upscaling.

Open `index.html` through any static host (GitHub Pages works), or run `python3 -m http.server` in this folder and visit `http://localhost:8000`. The sample photos need a web server to load; choosing your own photo also works when you open the file directly.

## Extract signature

The strokes are lifted from the photo, not redrawn, so the result matches the original signature.

1. Choose, drag in or paste a photo of your signature.
2. Drag a box around the signature to leave out lines, borders and shadows.
3. Adjust the result if needed: line thickness, ink sensitivity, edge softness, clean specks, padding and ink colour.
4. Click a stray mark in the result to erase it.
5. Download the PNG (transparent or white background), or copy the image.

For a good photo, sign with a dark pen on plain paper, use even light, and hold the camera straight above the page.

How it works: the paper brightness around each pixel is estimated from the photo itself, so shadows cancel out. Each pixel's darkness against that level becomes the stroke opacity, with an automatic threshold between faint and solid ink. Small specks are removed, the pen colour comes from the darkest solid strokes, and line thickness grows or shrinks the strokes using a distance map.

## Restore photo

This is classic image processing, not AI. It cleans and sharpens what is in the photo and does not invent detail that was never captured. Work runs in a Web Worker, with a live preview at up to 1600 px and a full-size export.

Steps, in order:

1. **Fading and colour**: per-channel levels from the 0.5% and 99.5% percentiles, plus a gentle lift for dark photos. This assumes the photo has real shadows and highlights, so lower it if colours look too strong.
2. **Dust and scratches**: pixels that stand out from three or more neighbours on a ring around them (specks and thin lines, not edges) are repaired from nearby clean pixels.
3. **Noise**: a bilateral filter guided by brightness, so edges stay where they are.
4. **Colour boost**: raises muted colours more than strong ones.
5. **Upscale**: Lanczos-3 resampling to 2× or 4×, capped at 24 megapixels.
6. **Sharpen**: unsharp mask on brightness only, with a small dead zone so noise is not boosted.

Photos larger than 6000 px on the long side, or 24 megapixels, are reduced when opened. High dust and noise settings can soften fine texture.

## Files

- `index.html`: the page, with a landing view and the two tools (`#signature`, `#restore`)
- `css/app.css`, `js/app.js`: shared styles, routing and helpers
- `js/signature.js`: signature extraction
- `js/engine.js`, `js/restore.js`: the restore engine and its page
- `assets/`: sample photos

No dependencies and no build step.
