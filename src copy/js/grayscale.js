export function rgbaToGrayscale(imageData) {
  var pixels = imageData.data;
  var grayscale = new Uint8Array(imageData.width * imageData.height);

  var grayIndex = 0;
  for (var pixelIndex = 0; pixelIndex < pixels.length; pixelIndex += 4) {
    grayscale[grayIndex] = Math.round((pixels[pixelIndex] + pixels[pixelIndex + 1] + pixels[pixelIndex + 2]) / 3);
    grayIndex++;
  }

  return grayscale;
}
