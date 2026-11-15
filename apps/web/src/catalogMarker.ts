export type CatalogMarkerShape = 'circle' | 'rhomb';

export function createCatalogMarker(color: string, size: number, shape: CatalogMarkerShape): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return canvas;

  const center = size / 2;
  const radius = center - 1.5;
  context.beginPath();
  if (shape === 'rhomb') {
    context.moveTo(center, center - radius);
    context.lineTo(center + radius, center);
    context.lineTo(center, center + radius);
    context.lineTo(center - radius, center);
    context.closePath();
  } else {
    context.arc(center, center, radius, 0, Math.PI * 2);
  }
  context.fillStyle = '#070a10';
  context.fill();
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.stroke();
  context.beginPath();
  context.arc(center, center, Math.max(1.5, size * 0.13), 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
  return canvas;
}
