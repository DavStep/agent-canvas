// Hovering a session's header or focusing its control turns its portrait toward the owner.
// The poses live in a shared image strip. Motion and its reduced-motion fallback are in CSS.
export function watchPortrait(icon: HTMLElement): () => void {
  const host = icon.closest('.card-head')?.closest('.card') ?? icon.closest('.rail-row, .jump-hit') ?? icon;
  const control = host.closest('button, [tabindex]');
  let hovered = host.matches(':hover') && matchMedia('(hover: hover)').matches;
  let focused = !!control?.matches(':focus-visible');
  const update = () => icon.toggleAttribute('data-watching', hovered || focused);
  const enter = (event: Event) => {
    if ((event as PointerEvent).pointerType === 'touch') return;
    hovered = true;
    update();
  };
  const leave = () => { hovered = false; update(); };
  const focus = () => { focused = !!control?.matches(':focus-visible'); update(); };
  const blur = () => { focused = false; update(); };
  update();
  host.addEventListener('pointerenter', enter);
  host.addEventListener('pointerleave', leave);
  host.addEventListener('pointercancel', leave);
  control?.addEventListener('focus', focus);
  control?.addEventListener('blur', blur);
  return () => {
    host.removeEventListener('pointerenter', enter);
    host.removeEventListener('pointerleave', leave);
    host.removeEventListener('pointercancel', leave);
    control?.removeEventListener('focus', focus);
    control?.removeEventListener('blur', blur);
  };
}
