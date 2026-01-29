export function rgbaToGrayscale(imageData) {
  const pixels = imageData.data;
  const grayscale = new Uint8Array(imageData.width * imageData.height);

  for (let pixelIndex = 0, grayIndex = 0; pixelIndex < pixels.length; pixelIndex += 4, grayIndex++) {
    grayscale[grayIndex] = Math.round(
      (pixels[pixelIndex] + pixels[pixelIndex + 1] + pixels[pixelIndex + 2]) / 3,
    );
  }

  return grayscale;
}
