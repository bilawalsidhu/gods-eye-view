// Entry file for Hostinger's LiteSpeed Node launcher
// (/usr/local/lsws/fcgi-bin/lsnode.js), which loads the app with require().
// server.js is an ES module with top-level await, which require() cannot load
// (ERR_REQUIRE_ASYNC_MODULE), so this CommonJS shim loads it with import().
//
// lsnode replaces http.Server.prototype.listen before requiring this file:
// the first listen() call is bound to LiteSpeed's own socket (the requested
// port/host are ignored) and any second call throws. server.js starts exactly
// one HTTP server, so it works both under lsnode and with plain `npm start`.
import('./server.js').catch((error) => {
  console.error('[gev] Failed to start server.js:', error);
  process.exitCode = 1;
  // Let the error reach the log before the launcher restarts the app.
  setTimeout(() => process.exit(1), 100);
});
