(() => {
  const panes = [...document.querySelectorAll('[data-pane]')]
    .map(e => e.innerText.replace(/\s+/g, " ").trim())
    .filter(t => t.length > 4);
  return panes[panes.length - 1]?.slice(0, 200) ?? "(empty)";
})()
