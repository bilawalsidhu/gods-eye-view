- Refuse Ontario 511 catalog redirects and keep the key-bearing request URL
  and upstream error text out of failure logs, which now name only the error
  class and system code; release the body of an error response. Credit
  Ontario 511 with the Open Government Licence – Ontario attribution statement
  (asturksever, #1266).
- Abort the other Tarktee (Estonia) DATEX request as soon as one fails, before
  its headers or while its body is read, instead of waiting out the shared
  30 s deadline; a response that arrives after the failure is released too.
  The Lithuania pack reads its two catalogs through the same helper
  (asturksever, #1266).
- Frame the calibration gizmo before the CCTV QA drag regression drags it;
  default autofocus could leave the arrow shorter than the 10 px grab
  threshold (asturksever, #1266).
