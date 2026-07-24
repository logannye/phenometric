import type { FacialKinematicsFrameV1 } from "@phenometrix/ambient-core";

export type FaceImageQuality = FacialKinematicsFrameV1["imageQuality"];

export interface PixelBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const DARK_CLIP_LEVEL = 0.02;
const BRIGHT_CLIP_LEVEL = 0.98;

function luminance(
  pixels: Uint8ClampedArray,
  pixelIndex: number
): number {
  const offset = pixelIndex * 4;
  return (
    (pixels[offset] * 0.2126 +
      pixels[offset + 1] * 0.7152 +
      pixels[offset + 2] * 0.0722) /
    255
  );
}

/**
 * Computes privacy-safe aggregate image statistics. Pixel data is neither
 * returned nor retained by this function.
 */
export function computeFaceImageQuality(
  image: PixelBuffer
): FaceImageQuality {
  const pixelCount = image.width * image.height;
  if (
    pixelCount <= 0 ||
    image.data.length < pixelCount * 4
  ) {
    return {
      illuminationMean: 0,
      darkClippingFraction: 1,
      brightClippingFraction: 0,
      sharpness: 0
    };
  }

  const luma = new Float64Array(pixelCount);
  let illuminationTotal = 0;
  let darkCount = 0;
  let brightCount = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const value = luminance(image.data, index);
    luma[index] = value;
    illuminationTotal += value;
    if (value <= DARK_CLIP_LEVEL) darkCount += 1;
    if (value >= BRIGHT_CLIP_LEVEL) brightCount += 1;
  }

  let laplacianTotal = 0;
  let laplacianSquaredTotal = 0;
  let laplacianCount = 0;
  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      const index = y * image.width + x;
      const laplacian =
        4 * luma[index] -
        luma[index - 1] -
        luma[index + 1] -
        luma[index - image.width] -
        luma[index + image.width];
      laplacianTotal += laplacian;
      laplacianSquaredTotal += laplacian * laplacian;
      laplacianCount += 1;
    }
  }
  const laplacianMean =
    laplacianCount === 0 ? 0 : laplacianTotal / laplacianCount;
  const sharpness =
    laplacianCount === 0
      ? 0
      : Math.max(
          0,
          laplacianSquaredTotal / laplacianCount -
            laplacianMean * laplacianMean
        );

  return {
    illuminationMean: illuminationTotal / pixelCount,
    darkClippingFraction: darkCount / pixelCount,
    brightClippingFraction: brightCount / pixelCount,
    sharpness
  };
}
