// The order rows arrive in: motion.css delays a row's entrance by its place, `--i`
// (docs/motion.md, "Lists and loading"). A row takes its place once, when it is first drawn.
// A later render never moves it, so an entrance that is still playing does not shift, and rows
// that arrive later (a folder opened, a group unfolded) count from their own heading, not the list's top.
export function arrive(el: HTMLElement | null, i: number): void {
  if (el && el.style.getPropertyValue('--i') === '') el.style.setProperty('--i', String(i));
}
