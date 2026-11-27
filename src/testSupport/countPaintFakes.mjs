/** A canvas text measurer for count labels. */
export function countTextDocument() {
  return {
    createElement: () => ({
      getContext: () => ({
        measureText: (text) => ({
          width: text.length * 7,
          actualBoundingBoxAscent: 4,
          actualBoundingBoxDescent: 4,
        }),
      }),
    }),
  };
}

/** A paint context recording labels and their opacity. */
export function recordingContext() {
  return {
    labels: [],
    globalAlpha: 1,
    save() {},
    restore() {},
    beginPath() {},
    roundRect() {},
    stroke() {},
    fill() {},
    drawImage() {},
    fillText(text, x, y) {
      this.labels.push({ text, x, y, alpha: this.globalAlpha });
    },
  };
}
