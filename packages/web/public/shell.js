/* The Marvis desktop app (packages/desktop) on a Mac has no title bar: the
   window's buttons sit over the top-left corner. Mark the page before first
   paint so the top rows leave them room and move the window (index.css,
   "Desktop window"); full screen hides the buttons, and the room goes with
   them. In a browser `marvisDesktop` is undefined and this does nothing.
   External file for the same reason as theme.js: the CSP is `script-src 'self'`. */
(function () {
  var desktop = window.marvisDesktop;
  if (!desktop || desktop.titleBar !== 'inset') return;
  var root = document.documentElement;
  root.setAttribute('data-titlebar', 'inset');
  desktop.onFullScreen(function (fullScreen) {
    if (fullScreen) root.removeAttribute('data-titlebar');
    else root.setAttribute('data-titlebar', 'inset');
  });
})();
