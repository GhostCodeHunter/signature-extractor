# Signature Extractor

Two small tools that run entirely in your browser. Photos are never uploaded anywhere, and there is no account.

- **Extract signature** turns a photo of your handwritten signature into a transparent PNG.
- **Restore photo** cleans up an old or low-quality photo: faded colour, dust, scratches, noise and softness, with optional 2×, 4× or 8× enlarging. Faces are detected and processed more gently, and never redrawn.

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
5. **Enlarge**: Lanczos-3 resampling to 2×, 4× or 8×, done in 2× steps. After each step a soft edge-steepening filter keeps edges from turning into blur, and noise reduction rises a little with the size. This makes edges cleaner and the file bigger. It does not add detail the camera never recorded.
6. **Sharpen**: unsharp mask on brightness only, with a small dead zone so noise is not boosted.

Photos larger than 6000 px on the long side, or 24 megapixels, are reduced when opened. The saved file can be up to 36 megapixels, so 8× is only offered for small photos (up to about 0.56 megapixels) and 4× up to about 2.25 megapixels. High dust and noise settings can soften fine texture.

### Face protection

Faces are found on your device, using the browser's built-in face detector when it has one and otherwise a small bundled cascade. Each face area is processed on its own with gentler settings and blended back with a soft edge, so there is no visible seam.

- **Off**: faces are treated like the rest of the photo.
- **Gentle** (default): lighter noise reduction and sharpening, less speck repair, no colour boost, and the eye region is left out of speck repair so catchlights and pupils stay.
- **Strict**: tone correction and resizing only.

Nothing is redrawn or generated. The bundled finder works best on faces that look at the camera, and it can also fire on animal faces or face-like patterns. Use **Mark a face** to draw a box around one it missed, and click a box in marking mode to remove it.

The bundled detector in `js/facemodel.js` is OpenCV's `lbpcascade_frontalface` (OpenCV is licensed under Apache 2.0, and BSD 3-clause in older releases), converted to a compact JavaScript object.

## Files

- `index.html`: the page, with a landing view and the two tools (`#signature`, `#restore`)
- `css/app.css`, `js/app.js`: shared styles, routing and helpers
- `js/signature.js`: signature extraction
- `js/engine.js`, `js/restore.js`: the restore engine and its page
- `js/facemodel.js`: the face-finder model data
- `assets/`: sample photos and the stage images shown on the landing page

No dependencies and no build step.
