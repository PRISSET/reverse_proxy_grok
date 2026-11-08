// Patchright 1.64.x: evaluate(fn, arg, options, isolatedContext).
// Keep the options slot explicit so false selects the main world, not invalid options.
export function evaluateMain(page, callback, argument) {
  return page.evaluate(callback, argument, undefined, false);
}
