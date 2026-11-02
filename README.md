# Signature Extractor

Turn a photo of your handwritten signature into a transparent PNG.

The strokes are lifted from the photo, not redrawn, so the result matches the original signature. Everything runs in your browser. The photo is never uploaded anywhere.

## Use it

Open `index.html` in any modern browser (or use the hosted page), then:

1. Choose, drag in or paste a photo of your signature.
2. Drag a box around the signature on the photo to leave out lines, borders and shadows.
3. Adjust the result if needed:
   - **Line thickness**: make the pen line thinner or thicker.
   - **Ink sensitivity**: pick up fainter strokes or fewer strokes.
   - **Edge softness**, **Clean specks**, **Padding**.
   - **Ink colour**: keep the original pen colour, or use black, blue or any colour.
4. Click a stray mark in the result to erase it.
5. Download the PNG (transparent or white background), or copy the image.

## Tips for a good photo

- Sign with a dark pen on plain white paper.
- Use even light and avoid shadows across the signature.
- Hold the camera straight above the page and get close.

## How it works

1. The paper brightness around each pixel is estimated from the photo itself, so shadows and uneven light cancel out.
2. Each pixel's darkness against that paper level becomes the stroke's opacity, with an automatic threshold between faint and solid ink.
3. Small specks are removed, and the pen colour is taken from the darkest solid strokes.
4. Line thickness grows or shrinks the strokes using a distance map, keeping the soft edges.

It is a single static file with no dependencies and no build step.
