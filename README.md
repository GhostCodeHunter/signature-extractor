# Signature Extractor

Two small tools that run entirely in your browser. Photos are never uploaded anywhere, and there is no account.

- **Extract signature** turns a photo of your handwritten signature into a transparent PNG.
- **Restore photo** cleans up an old or low-quality photo: faded colour, dust, scratches, noise and softness, with optional 2×, 4× or 8× enlarging. Faces are detected and processed more gently, and never redrawn.

Open `index.html` through any static host (GitHub Pages works), or run `python3 -m http.server` in this folder and visit `http://localhost:8000`. The sample photos need a web server to load; choosing your own photo also works when you open the file directly.

## Extract signature

The strokes come from your photo, so the result keeps the shape, line weight and ink colour of your own signature.

1. Choose, drag in or paste a photo of your signature.
2. Drag a box around the signature to leave out lines, borders and shadows.
3. Adjust the result if needed: line thickness, ink sensitivity, edge softness, clean specks, padding and ink colour. **Output** chooses Traced or Pixels, **Watermark removal** chooses Off, Auto or Strong, and **Real ink** gives the strokes the look of a real pen.
4. Click a stray mark in the result to erase it.
5. Download the PNG (transparent or white background) or the SVG, or copy the image.

For a good photo, sign with a dark pen on plain paper, use even light, and hold the camera straight above the page.

How it works: the paper brightness around each pixel is estimated from the photo itself, so shadows cancel out. Each pixel's darkness against that level becomes the stroke opacity, with an automatic threshold between faint and solid ink. Small specks are removed, the pen colour comes from the darkest solid strokes, and line thickness grows or shrinks the strokes using a distance map.

### Traced and Pixels

- **Traced** (default) redraws the strokes as smooth outlines at up to 4× the photo's size, so edges stay crisp when you enlarge the signature. The outline level is picked so that the traced strokes cover the same area as the photo's strokes, which keeps the line weight. Outlines are found with marching squares, simplified, and drawn as curves. The SVG download holds the same outlines as one filled path.
- **Pixels** keeps the photo's own pixels with a soft edge, at the photo's own size.

### Real ink

Off by default, so the result stays an exact copy of your signature. Ballpoint, Fountain pen, Felt tip and Aged reshape the ink of the finished PNG, with a Strength slider.

- **Ballpoint**: slightly uneven ink, fine grain, a ragged edge and a few tiny gaps in thin parts.
- **Fountain pen**: ink collects and darkens in thick parts, thin parts turn lighter, and the edge feathers a little.
- **Felt tip**: solid colour with soft, slightly bleeding edges.
- **Aged**: faded, patchy ink with more gaps and a rougher edge.

How it works: the average pen width is measured from the strokes, and every effect is sized from it, so the look is the same at any zoom. Edge roughness, ink density, pooling and gaps come from seeded noise, so the same signature always gets the same texture. The effect changes the finished PNG only: the SVG download always keeps the clean outlines, and click-to-erase still works on the clean strokes. Large outputs (over 12 megapixels) are left clean.

### Watermarks

Watermark removal only exists in the signature tool, and only works on marks that differ from the pen. In **Auto** a connected mark is left out when its core is much fainter than the pen, or when its colour is far from the pen colour. Faint or off-colour pixels that touch the signature are also removed when they sit more than a couple of pixels away from solid pen. **Strong** is stricter on both. Pen strokes away from a mark are not changed. If nothing is found, the result is identical to Off.

Limits: a mark in the same colour and darkness as the pen cannot be separated. A heavy mark that crosses the strokes can leave small stubs beside them, and coloured text over the pen can leave small notches. A pen with two colours may lose the second one, so use Off then. Click the leftovers to erase them.

## Restore photo

Almost all of this is classic image processing: it cleans and sharpens what is in the photo and does not invent detail that was never captured. The one exception is the optional **AI face detail** step (see below), which rebuilds the face of a small or blurred portrait with a neural network that runs on your device. Work runs in a Web Worker, with a live preview that is enlarged to the size you chose (up to 1600 px on the long side) and a full-size export.

Steps, in order:

1. **Fading and colour**: per-channel levels from the 0.5% and 99.5% percentiles, plus a gentle lift for dark photos. This assumes the photo has real shadows and highlights, so lower it if colours look too strong.
2. **Dust and scratches**: pixels that stand out from three or more neighbours on a ring around them (specks and thin lines, not edges) are repaired from nearby clean pixels.
3. **Noise**: a bilateral filter guided by brightness, so edges stay where they are.
4. **Colour boost**: raises muted colours more than strong ones.
5. **Enlarge**: Lanczos-3 resampling to 2×, 4× or 8×, done in 2× steps. After each step a soft edge-steepening filter keeps edges from turning into blur, and noise reduction rises a little with the size. This makes edges cleaner and the file bigger. It does not add detail the camera never recorded.
6. **Sharpen**: unsharp mask on brightness only, with a small dead zone so noise is not boosted.
7. **Background** (optional): see below.

Photos larger than 6000 px on the long side, or 24 megapixels, are reduced when opened. The saved file can be up to 36 megapixels, so 8× is only offered for small photos (up to about 0.56 megapixels) and 4× up to about 2.25 megapixels. High dust and noise settings can soften fine texture.

### ID photo and background

The **ID photo** preset turns the tone correction up to full, picks 4× (or the largest size the photo allows), turns **AI face detail** on and picks **Sky blue** for the background. Other presets leave those choices alone. Sky blue is a light shade; if you need a vivid blue like many passport offices ask for, choose **Blue** or a custom colour.

**Background** swaps an even backdrop for one flat colour: Sky blue, Blue, White, Grey or any colour you pick. The backdrop is found from the photo's own edges. A pixel counts as backdrop when it is close to the colour along the top and upper sides, is connected to those edges without crossing a sharp change, and stays close to a smooth estimate of the wall (the wall may be lighter on one side). Lower in the photo the tolerance narrows, because that is where clothing sits. Where hair or a shoulder blends into the wall, the blend is kept and only the wall's share of each pixel is replaced. The person is not changed.

If no even backdrop reaches the top and sides, the page says so and leaves the background as it was. When a garment is nearly the colour of the wall, the edge between them can be a little off. Choose Keep, or a custom colour, in that case.

### AI face detail

A small or blurred portrait has lost the detail of the eyes, brows, lips and skin, and sharpening cannot bring that back. This optional step rebuilds it:

1. **Find the face**: SCRFD (2.5 GFLOPs) finds each face and its five landmarks (up to three faces per photo).
2. **Align and rebuild**: the face is rotated and scaled to a 256 px square, and GPEN-BFR (a GAN-based blind face restoration network, 256 px) redraws it.
3. **Put it back, in the photo's own colour**: the rebuilt face replaces only the fine detail. Its overall colour and shading are swapped for the photo's own, so skin tone and lighting stay what they were, and the edge is feathered into the rest of the photo. The flat backdrop is never touched.

It runs in a Web Worker with ONNX Runtime Web (WebAssembly, one thread), so nothing is uploaded. A face takes a few seconds. The **Strength** slider mixes the rebuilt face with the classic result; lower it to stay closer to the original.

The network files are not small. `models/gpen_bfr_256.onnx` is 76 MB and `models/scrfd_2.5g.onnx` is 3 MB. They are fetched the first time AI face detail is switched on and kept in the browser's cache. The page also accepts the model as four numbered pieces (`gpen_bfr_256.part1.wasm` to `part4.wasm`, 3 MB for the detector in `scrfd_2.5g.part1.wasm`). They are the same bytes cut into parts under 20 MB, named `.wasm` because the shared Claude artifact host only serves a fixed list of file types and caps a file at 20 MB. The shared artifact has no access to other sites, so that is how it carries the model. If the 76 MB file cannot be reached (for example in a copy of the page that does not include the `models` folder), the page says so and offers **Choose a face model file**. The 512 px model (`gpen_bfr_512.onnx`, about 284 MB, from the facefusion-assets release) can be picked there too; it is detected by size and gives a little more detail.

What it does and does not do:

- It is a reconstruction, not a recovery. The network draws plausible detail from a learned idea of faces, so small features (a mole, a scar, the shape of a brow, fine hair texture) can come out different from the real person. **Always compare the result with the original.** Do not use it for any document that must show an unaltered photo.
- On the test photos the face is clearly sharper and keeps who it is (a forehead mark and the eyebrows survived), and the result is much closer to the studio original than the classic result. But a face-similarity score (ArcFace) against the true original on one test photo came out about the same or slightly lower than the classic result (0.82 for the 256 model, 0.85 for the 512 model, against 0.85 classic). Pixel measures such as PSNR also drop a little, because the invented detail is not aligned to the real one. Treat those numbers as a reminder that the face is drawn, not recovered.
- Curly hair, beard texture and hair edges are not rebuilt like the original, and the classic cleanup of the rest of the photo is unchanged.
- Only the face is rebuilt. Hair, neck, clothes and the rest keep the classic result.

### What it cannot do

It does not take a text prompt, and the classic steps cannot rebuild eyes, hair or skin texture that a small or blurred photo never captured. With AI face detail off, a 273 px wide passport photo comes out cleaner, with even colour and a flat backdrop, but not like a sharp studio original. On two test photos (each compared with its own full-resolution original) the classic result moved from roughly 18 to 21 dB PSNR and from 0.73 to 0.85 SSIM with the background swap, and the face area improved only slightly. AI face detail goes a long way beyond that, but only for faces, and at the cost described above. It does not change the clothes, hair outline, or what the photo shows, and it will not make a bad photo into a studio one: a face turned away, hidden by a hand, or smaller than about 30 px may be missed or come out wrong.

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
- `js/realink.js`: the Real ink pen looks
- `js/engine.js`, `js/restore.js`: the restore engine and its page
- `js/facemodel.js`: the face-finder model data
- `assets/`: sample photos and the stage images shown on the landing page

No dependencies and no build step.

## Credits and licences

- **ONNX Runtime Web** 1.23.0 (MIT), in `vendor/ort`.
- **GPEN** (GAN Prior Embedded Network, Yang et al., CVPR 2021), the face restoration network. The ONNX conversion used here comes from the facefusion-assets release.
- **SCRFD** (Guo et al., InsightFace), the face detector, also from facefusion-assets.

The GPEN and SCRFD weights have their own licences, which may restrict commercial use. They have not been checked for this project, so read them before using this page in a product.
