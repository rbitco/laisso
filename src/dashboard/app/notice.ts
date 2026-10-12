/** The line at the top of the page that reports a save or an error; an empty message hides it. */
export function showNotice(message: string): void {
  const notice = document.querySelector<HTMLElement>('[data-role="notice"]');
  if (!notice) return;
  notice.textContent = message;
  notice.hidden = !message;
}
