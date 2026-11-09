- Every local route that answers `405 Method Not Allowed` now names the
  methods it accepts in an `Allow` header, built by `allowedMethods()` in
  `server/providers/common/methods.js`; response bodies and status codes are
  unchanged (Rishikesh Akkalwar, @iostream4YOU, #883).
